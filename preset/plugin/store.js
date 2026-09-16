/**
 * 星野 · 本地存储层
 *
 * 纯 Node（只依赖 node:fs / node:path），无第三方依赖、无需构建。
 * 负责「智能体 / 人设 / 档案 / 用户人设 / 对话记录」在磁盘上的全部读写，
 * 是 星野 插件的唯一真相来源。上层（tools.js / prompt.js）只调用这里的方法。
 *
 * 目录布局（dataRoot 默认 {工作区}/xingye-data）：
 *
 *   <dataRoot>/
 *     index.json                        全局索引：智能体列表 + 用户人设列表 + 当前激活项
 *     config.json                       保留策略等配置（可手工编辑）
 *     characters/<cid>/
 *       character.json                  { id, name, createdAt, updatedAt, tags, personaSource }
 *       persona.md                      人设正文（导入的 md/txt 原样保存，或直接输入的文字）
 *       source/                         导入文件的原始副本（保留导入痕迹，便于回溯）
 *       archives/<aid>/
 *         archive.json                  { id, title, createdAt, updatedAt, userPersonaId, sessionIds }
 *         messages.jsonl                对话原文，逐行一条 JSON —— 回溯与撤销的数据源
 *         summary.md                    定期清理后旧对话的摘要（原文被删除，只留这里）
 *         trash.jsonl                   被撤销的消息（保留，可恢复）
 *     user-personas/<pid>/
 *       persona.json                    { id, name, createdAt, updatedAt, source }
 *       persona.md                      用户人设正文
 */

import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_UNDO_WINDOW = 30
export const DEFAULT_MAX_VERBATIM = 400
export const DEFAULT_RETENTION_DAYS = 30

export const DEFAULT_CONFIG = {
  /** 可撤销并可完整回溯的最近消息条数（用户明确要求 30） */
  undoWindow: DEFAULT_UNDO_WINDOW,
  /** 单个档案最多保留的原文条数；超出部分滚动进 summary.md 后删除原文 */
  maxVerbatimMessages: DEFAULT_MAX_VERBATIM,
  /** 超过该天数的原文滚动进 summary.md（0 = 不按时间清理） */
  retentionDays: DEFAULT_RETENTION_DAYS,
  /** 每次写入后是否顺带做一次清理检查 */
  pruneOnWrite: true,
}

/** 生成短 id：时间戳 + 随机后缀，可读且几乎不会撞 */
function newId(prefix) {
  const t = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  const r = Math.random().toString(36).slice(2, 6)
  return `${prefix}_${t}_${r}`
}

function nowIso() {
  return new Date().toISOString()
}

/** 目录名安全化：中文/字母数字保留，其余替换为 - */
function slug(text, fallback) {
  const s = String(text ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s.length > 0 ? s.slice(0, 40) : fallback
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

function exists(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * 导入人设文本：支持 .md / .markdown / .txt / 任意纯文本，也支持直接给文字。
 * 返回 { text, source } —— source 记录来源，便于回溯人设是怎么来的。
 */
export function loadPersonaInput({ text, file, cwd }) {
  if (typeof text === 'string' && text.trim().length > 0) {
    return { text: text.trim(), source: { kind: 'text', at: nowIso() } }
  }
  if (typeof file === 'string' && file.trim().length > 0) {
    const resolved = path.isAbsolute(file) ? file : path.resolve(cwd ?? process.cwd(), file)
    if (!exists(resolved)) throw new Error(`人设文件不存在：${resolved}`)
    const ext = path.extname(resolved).toLowerCase()
    if (!['.md', '.markdown', '.txt', '.text', '.mdx', ''].includes(ext)) {
      throw new Error(`只支持导入 markdown / txt 文本文件，收到：${ext || '(无扩展名)'}`)
    }
    const content = readText(resolved)
    if (content.trim().length === 0) throw new Error(`人设文件是空的：${resolved}`)
    return {
      text: content.trim(),
      source: { kind: 'file', path: resolved, ext, at: nowIso() },
    }
  }
  throw new Error('必须提供人设文字（text）或人设文件路径（file）其中之一')
}

export class XingyeStore {
  constructor(dataRoot) {
    this.root = path.resolve(dataRoot)
    fs.mkdirSync(this.root, { recursive: true })
    this.charactersDir = path.join(this.root, 'characters')
    this.userPersonasDir = path.join(this.root, 'user-personas')
    fs.mkdirSync(this.charactersDir, { recursive: true })
    fs.mkdirSync(this.userPersonasDir, { recursive: true })
    this.ensureConfig()
  }

  // ── 基础路径 ──────────────────────────────────────────────────────────────

  get configFile() {
    return path.join(this.root, 'config.json')
  }

  get indexPath() {
    return path.join(this.root, 'index.json')
  }

  ensureConfig() {
    if (!exists(this.configFile)) writeJson(this.configFile, DEFAULT_CONFIG)
    // 补齐缺失字段，保留用户已有设置
    const current = readJson(this.configFile, {})
    const merged = { ...DEFAULT_CONFIG, ...current }
    if (JSON.stringify(merged) !== JSON.stringify(current)) writeJson(this.configFile, merged)
    return merged
  }

  get config() {
    return { ...DEFAULT_CONFIG, ...readJson(this.configFile, {}) }
  }

  /** 目录名 = 人类可读名 + 唯一后缀，既有可读性又不会撞名 */
  characterDir(id) {
    return path.join(this.charactersDir, id)
  }

  archiveDir(characterId, archiveId) {
    return path.join(this.characterDir(characterId), 'archives', archiveId)
  }

  userPersonaDir(id) {
    return path.join(this.userPersonasDir, id)
  }

  // ── 全局索引 ──────────────────────────────────────────────────────────────

  readIndex() {
    const idx = readJson(this.indexPath, null)
    if (idx && typeof idx === 'object') {
      return {
        activeCharacterId: idx.activeCharacterId ?? null,
        activeArchiveId: idx.activeArchiveId ?? null,
        activeUserPersonaId: idx.activeUserPersonaId ?? null,
        updatedAt: idx.updatedAt ?? nowIso(),
      }
    }
    return {
      activeCharacterId: null,
      activeArchiveId: null,
      activeUserPersonaId: null,
      updatedAt: nowIso(),
    }
  }

  writeIndex(patch) {
    const next = { ...this.readIndex(), ...patch, updatedAt: nowIso() }
    writeJson(this.indexPath, next)
    return next
  }

  // ── 智能体（人物） ────────────────────────────────────────────────────────

  listCharacters() {
    if (!exists(this.charactersDir)) return []
    return fs
      .readdirSync(this.charactersDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => this.getCharacter(d.name))
      .filter(Boolean)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  }

  getCharacter(id) {
    const file = path.join(this.characterDir(id), 'character.json')
    return readJson(file, null)
  }

  /** 按名字（或 id）找人物；名字不唯一时返回第一个匹配 */
  findCharacter(ref) {
    if (!ref) return null
    const direct = this.getCharacter(ref)
    if (direct) return direct
    const name = String(ref).trim()
    return this.listCharacters().find((c) => c.name === name) ?? null
  }

  createCharacter({ name, personaText, personaSource, tags }) {
    if (!name || String(name).trim().length === 0) throw new Error('人物名称不能为空')
    const cleanName = String(name).trim()
    const id = `${slug(cleanName, 'char')}-${newId('c').slice(-9)}`
    const dir = this.characterDir(id)
    if (exists(dir)) throw new Error(`同名目录已存在：${id}`)
    fs.mkdirSync(dir, { recursive: true })
    const character = {
      id,
      name: cleanName,
      tags: Array.isArray(tags) ? tags : [],
      personaSource: personaSource ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    writeJson(path.join(dir, 'character.json'), character)
    writeText(path.join(dir, 'persona.md'), `${personaText ?? ''}\n`)
    return character
  }

  readPersona(characterId) {
    return readText(path.join(this.characterDir(characterId), 'persona.md'), '')
  }

  updateCharacterPersona(characterId, { personaText, personaSource }) {
    const character = this.getCharacter(characterId)
    if (!character) throw new Error(`找不到人物：${characterId}`)
    const dir = this.characterDir(characterId)
    if (personaText !== undefined) writeText(path.join(dir, 'persona.md'), `${personaText}\n`)
    const next = {
      ...character,
      personaSource: personaSource ?? character.personaSource,
      updatedAt: nowIso(),
    }
    writeJson(path.join(dir, 'character.json'), next)
    return next
  }

  renameCharacter(characterId, name) {
    const character = this.getCharacter(characterId)
    if (!character) throw new Error(`找不到人物：${characterId}`)
    const next = { ...character, name: String(name).trim(), updatedAt: nowIso() }
    writeJson(path.join(this.characterDir(characterId), 'character.json'), next)
    return next
  }

  /** 保存导入文件的原始副本，保留「人设从哪来」的证据 */
  savePersonaSource(characterId, { fileName, content }) {
    if (!fileName) return null
    const dir = path.join(this.characterDir(characterId), 'source')
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, slug(fileName, 'import') + path.extname(fileName || '.txt'))
    writeText(target, content)
    return target
  }

  deleteCharacter(characterId) {
    const dir = this.characterDir(characterId)
    if (!exists(dir)) throw new Error(`找不到人物：${characterId}`)
    fs.rmSync(dir, { recursive: true, force: true })
    const idx = this.readIndex()
    if (idx.activeCharacterId === characterId) {
      this.writeIndex({ activeCharacterId: null, activeArchiveId: null })
    }
    return true
  }

  // ── 档案（同一人物的多条会话线） ─────────────────────────────────────────

  listArchives(characterId) {
    const dir = path.join(this.characterDir(characterId), 'archives')
    if (!exists(dir)) return []
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => this.getArchive(characterId, d.name))
      .filter(Boolean)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  }

  getArchive(characterId, archiveId) {
    return readJson(path.join(this.archiveDir(characterId, archiveId), 'archive.json'), null)
  }

  findArchive(ref, characterId) {
    if (!ref) return null
    const chars = characterId
      ? [this.getCharacter(characterId)].filter(Boolean)
      : this.listCharacters()
    for (const c of chars) {
      const byId = this.getArchive(c.id, ref)
      if (byId) return { character: c, archive: byId }
      const byTitle = this.listArchives(c.id).find((a) => a.title === ref)
      if (byTitle) return { character: c, archive: byTitle }
    }
    return null
  }

  /** 找到某个 DSH 会话绑定到的档案 —— 用于「一个档案 = 一条会话线」的自动绑定 */
  findArchiveBySession(sessionId) {
    for (const c of this.listCharacters()) {
      for (const a of this.listArchives(c.id)) {
        if (Array.isArray(a.sessionIds) && a.sessionIds.includes(sessionId)) {
          return { character: c, archive: a }
        }
      }
    }
    return null
  }

  createArchive(characterId, { title, userPersonaId } = {}) {
    const character = this.getCharacter(characterId)
    if (!character) throw new Error(`找不到人物：${characterId}`)
    const existing = this.listArchives(characterId)
    const cleanTitle = String(title ?? '').trim() || `档案 ${existing.length + 1}`
    const id = `${slug(cleanTitle, 'arc')}-${newId('a').slice(-9)}`
    const dir = this.archiveDir(characterId, id)
    fs.mkdirSync(dir, { recursive: true })
    const archive = {
      id,
      characterId,
      title: cleanTitle,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      userPersonaId: userPersonaId ?? null,
      sessionIds: [],
      messageCount: 0,
      prunedCount: 0,
    }
    writeJson(path.join(dir, 'archive.json'), archive)
    writeText(path.join(dir, 'messages.jsonl'), '')
    return archive
  }

  touchArchive(characterId, archiveId, patch = {}) {
    const archive = this.getArchive(characterId, archiveId)
    if (!archive) return null
    const next = { ...archive, ...patch, updatedAt: nowIso() }
    writeJson(path.join(this.archiveDir(characterId, archiveId), 'archive.json'), next)
    return next
  }

  deleteArchive(characterId, archiveId) {
    const dir = this.archiveDir(characterId, archiveId)
    if (!exists(dir)) throw new Error(`找不到档案：${archiveId}`)
    fs.rmSync(dir, { recursive: true, force: true })
    const idx = this.readIndex()
    if (idx.activeArchiveId === archiveId) this.writeIndex({ activeArchiveId: null })
    return true
  }

  // ── 对话记录（本地存储，用于回溯与撤销） ─────────────────────────────────

  messagesFile(characterId, archiveId) {
    return path.join(this.archiveDir(characterId, archiveId), 'messages.jsonl')
  }

  trashFile(characterId, archiveId) {
    return path.join(this.archiveDir(characterId, archiveId), 'trash.jsonl')
  }

  /** 逐行读取对话原文；坏行直接跳过，不因一行损坏丢掉整个档案 */
  readMessages(characterId, archiveId) {
    const file = this.messagesFile(characterId, archiveId)
    const raw = readText(file, '')
    const out = []
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (t.length === 0) continue
      try {
        out.push(JSON.parse(t))
      } catch {
        /* 跳过损坏行 */
      }
    }
    return out
  }

  appendMessage(characterId, archiveId, message) {
    const file = this.messagesFile(characterId, archiveId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const record = { at: nowIso(), ...message }
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
    const archive = this.getArchive(characterId, archiveId)
    const count = (archive?.messageCount ?? 0) + 1
    this.touchArchive(characterId, archiveId, { messageCount: count, lastAt: record.at })
    // 只在确实超限时才做清理：prune 要整读一遍文件，不能每条消息都跑
    const config = this.config
    if (config.pruneOnWrite && count > Math.max(config.undoWindow, config.maxVerbatimMessages)) {
      this.prune(characterId, archiveId)
    }
    return record
  }

  writeMessages(characterId, archiveId, messages) {
    const file = this.messagesFile(characterId, archiveId)
    writeText(file, messages.map((m) => JSON.stringify(m)).join('\n') + (messages.length ? '\n' : ''))
    this.touchArchive(characterId, archiveId, { messageCount: messages.length })
  }

  /**
   * 撤销最近 n 条对话。
   * 被撤销的消息不销毁，而是移入 trash.jsonl —— 用户回溯时还能看到「撤了什么」。
   * n 受 undoWindow（默认 30）约束。
   */
  undo(characterId, archiveId, n) {
    const config = this.config
    const limit = Math.max(1, Math.min(Number(n) || 1, config.undoWindow))
    const messages = this.readMessages(characterId, archiveId)
    if (messages.length === 0) return { removed: 0, remaining: 0, limit, messages: [] }
    const take = Math.min(limit, messages.length)
    const kept = messages.slice(0, messages.length - take)
    const removed = messages.slice(messages.length - take)
    // 撤销必须可追溯：进回收站而不是删除
    const trash = this.trashFile(characterId, archiveId)
    fs.mkdirSync(path.dirname(trash), { recursive: true })
    fs.appendFileSync(
      trash,
      removed.map((m) => JSON.stringify({ undoneAt: nowIso(), ...m })).join('\n') + '\n',
      'utf8',
    )
    this.writeMessages(characterId, archiveId, kept)
    // 事件簿必须跟着回退：撤掉的那几句剧情不该继续留在「前情提要」里
    const voidedEvents = this.voidEventsAfter(characterId, archiveId, kept.length - 1, 'undo')
    return { removed: take, remaining: kept.length, limit, messages: removed, voidedEvents }
  }

  /** 把回收站里最后 n 条撤销恢复回对话 */
  restore(characterId, archiveId, n) {
    const file = this.trashFile(characterId, archiveId)
    const raw = readText(file, '')
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    if (lines.length === 0) return { restored: 0 }
    const take = Math.max(1, Math.min(Number(n) || 1, lines.length))
    const restoring = lines.slice(lines.length - take)
    const remaining = lines.slice(0, lines.length - take)
    const messages = this.readMessages(characterId, archiveId)
    for (const line of restoring) {
      try {
        const rec = JSON.parse(line)
        delete rec.undoneAt
        messages.push(rec)
      } catch {
        /* 跳过损坏行 */
      }
    }
    this.writeMessages(characterId, archiveId, messages)
    writeText(file, remaining.join('\n') + (remaining.length ? '\n' : ''))
    // 内容回来了，对应的事件簿条目也一并复活
    const unvoidedEvents = this.unvoidEventsAfter(characterId, archiveId, messages.length - 1)
    return { restored: take, unvoidedEvents }
  }

  /**
   * 定期清理：把超出「可回溯窗口」的旧对话压成 summary.md，然后删除原文，
   * 避免对话越攒越多、吃内存。
   *
   * 铁律：最近 undoWindow 条（默认 30）永远保留原文 —— 那是撤销与回溯要用的。
   */
  prune(characterId, archiveId) {
    const config = this.config
    const messages = this.readMessages(characterId, archiveId)
    const keepFloor = config.undoWindow
    if (messages.length <= Math.max(keepFloor, config.maxVerbatimMessages)) {
      // 条数没超限，再看是否按时间该清
      if (!config.retentionDays || config.retentionDays <= 0) return { pruned: 0 }
      const cutoff = Date.now() - config.retentionDays * 86400000
      const prunable = messages.filter((m, i) => {
        const t = Date.parse(m.at ?? '')
        return Number.isFinite(t) && t < cutoff && i < messages.length - keepFloor
      })
      if (prunable.length === 0) return { pruned: 0 }
      return this.applyPrune(characterId, archiveId, messages, prunable)
    }
    const cut = messages.length - Math.max(keepFloor, config.maxVerbatimMessages)
    const prunable = messages.slice(0, cut)
    return this.applyPrune(characterId, archiveId, messages, prunable)
  }

  applyPrune(characterId, archiveId, messages, prunable) {
    const dir = this.archiveDir(characterId, archiveId)
    const summaryFile = path.join(dir, 'summary.md')
    const lines = prunable.map((m) => {
      const who = m.role === 'user' ? `用户(${m.speaker ?? '本人'})` : m.speaker || '对方'
      const text = String(m.text ?? '').replace(/\s+/g, ' ').slice(0, 400)
      return `- [${m.at ?? ''}] ${who}：${text}`
    })
    const header = `\n\n## 归档段落（原文已清理，仅留梗概）\n\n`
    fs.appendFileSync(summaryFile, header + lines.join('\n') + '\n', 'utf8')
    const prunableSet = new Set(prunable)
    const kept = messages.filter((m) => !prunableSet.has(m))
    this.writeMessages(characterId, archiveId, kept)
    const archive = this.getArchive(characterId, archiveId)
    this.touchArchive(characterId, archiveId, {
      prunedCount: (archive?.prunedCount ?? 0) + prunable.length,
    })
    return { pruned: prunable.length, remaining: kept.length }
  }

  readSummary(characterId, archiveId) {
    return readText(path.join(this.archiveDir(characterId, archiveId), 'summary.md'), '')
  }

  // ── 用户人设（用户给自己设置的多套人设） ─────────────────────────────────

  listUserPersonas() {
    if (!exists(this.userPersonasDir)) return []
    return fs
      .readdirSync(this.userPersonasDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => readJson(path.join(this.userPersonasDir, d.name, 'persona.json'), null))
      .filter(Boolean)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  }

  getUserPersona(id) {
    return readJson(path.join(this.userPersonaDir(id), 'persona.json'), null)
  }

  findUserPersona(ref) {
    if (!ref) return null
    const direct = this.getUserPersona(ref)
    if (direct) return direct
    const name = String(ref).trim()
    return this.listUserPersonas().find((p) => p.name === name) ?? null
  }

  createUserPersona({ name, personaText, personaSource }) {
    if (!name || String(name).trim().length === 0) throw new Error('用户人设名称不能为空')
    const cleanName = String(name).trim()
    const id = `${slug(cleanName, 'me')}-${newId('u').slice(-9)}`
    const dir = this.userPersonaDir(id)
    if (exists(dir)) throw new Error(`同名目录已存在：${id}`)
    fs.mkdirSync(dir, { recursive: true })
    const persona = {
      id,
      name: cleanName,
      personaSource: personaSource ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    }
    writeJson(path.join(dir, 'persona.json'), persona)
    writeText(path.join(dir, 'persona.md'), `${personaText ?? ''}\n`)
    return persona
  }

  readUserPersonaText(id) {
    return readText(path.join(this.userPersonaDir(id), 'persona.md'), '')
  }

  updateUserPersona(id, { personaText, personaSource, name }) {
    const persona = this.getUserPersona(id)
    if (!persona) throw new Error(`找不到用户人设：${id}`)
    const dir = this.userPersonaDir(id)
    if (personaText !== undefined) writeText(path.join(dir, 'persona.md'), `${personaText}\n`)
    const next = {
      ...persona,
      name: name ? String(name).trim() : persona.name,
      personaSource: personaSource ?? persona.personaSource,
      updatedAt: nowIso(),
    }
    writeJson(path.join(dir, 'persona.json'), next)
    return next
  }

  deleteUserPersona(id) {
    const dir = this.userPersonaDir(id)
    if (!exists(dir)) throw new Error(`找不到用户人设：${id}`)
    fs.rmSync(dir, { recursive: true, force: true })
    if (this.readIndex().activeUserPersonaId === id) this.writeIndex({ activeUserPersonaId: null })
    return true
  }

  // ── 角色形象（立绘 / 背景） ──────────────────────────────────────────────

  /**
   * 约定：把图片直接放进角色目录就叫 avatar.* / background.*，插件认这个。
   * 用户不必记路径，也不需要任何「导入」动作 —— 丢进去就生效。
   */
  characterImage(characterId, kind) {
    const dir = this.characterDir(characterId)
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
      const file = path.join(dir, `${kind}${ext}`)
      if (exists(file)) return file
    }
    return null
  }

  characterImages(characterId) {
    const avatar = this.characterImage(characterId, 'avatar')
    const background = this.characterImage(characterId, 'background')
    return {
      avatar,
      background,
      // 立绘也认 portrait.*，语义上比 avatar 更准
      portrait: this.characterImage(characterId, 'portrait') ?? avatar,
    }
  }

  /** 从任意位置收一张图进角色目录；会覆盖同类的旧图 */
  setCharacterImage(characterId, kind, sourceFile) {
    const character = this.getCharacter(characterId)
    if (!character) throw new Error(`找不到人物：${characterId}`)
    const src = path.isAbsolute(sourceFile) ? sourceFile : path.resolve(process.cwd(), sourceFile)
    if (!exists(src)) throw new Error(`图片不存在：${src}`)
    const ext = path.extname(src).toLowerCase()
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
      throw new Error(`只支持 png / jpg / jpeg / webp / gif，收到：${ext || '(无扩展名)'}`)
    }
    const dir = this.characterDir(characterId)
    fs.mkdirSync(dir, { recursive: true })
    // 先清掉同类旧图，避免 avatar.png 与 avatar.jpg 同时存在导致认哪个不确定
    for (const old of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
      fs.rmSync(path.join(dir, `${kind}${old}`), { force: true })
    }
    const target = path.join(dir, `${kind}${ext}`)
    fs.copyFileSync(src, target)
    return target
  }

  deleteCharacterImage(characterId, kind) {
    let removed = 0
    for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
      const file = path.join(this.characterDir(characterId), `${kind}${ext}`)
      if (exists(file)) {
        fs.rmSync(file, { force: true })
        removed += 1
      }
    }
    return removed
  }

  // ── 记忆图片画廊（角色主页用） ───────────────────────────────────────────

  galleryFile(characterId) {
    return path.join(this.characterDir(characterId), 'gallery.json')
  }

  galleryDir(characterId) {
    return path.join(this.characterDir(characterId), 'gallery')
  }

  readGallery(characterId) {
    const g = readJson(this.galleryFile(characterId), [])
    return Array.isArray(g) ? g : []
  }

  /**
   * 记一张记忆图片。
   *
   * 同时保留两份：`attachmentRef` 指向 DSH 的附件库（这样它能渲染进对话），
   * `file` 是画廊目录下的实体副本 —— 让 `xingye-data` 单独备份出去也是完整的。
   */
  addGalleryItem(characterId, item) {
    const gallery = this.readGallery(characterId)
    const entry = { id: newId('img'), at: nowIso(), ...item }
    gallery.push(entry)
    writeJson(this.galleryFile(characterId), gallery)
    return entry
  }

  listGallery(characterId) {
    return this.readGallery(characterId).slice().reverse()
  }

  saveGalleryBytes(characterId, id, ext, bytes) {
    const dir = this.galleryDir(characterId)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${id}.${ext}`)
    fs.writeFileSync(file, bytes)
    return file
  }

  readGalleryBytes(characterId, id) {
    const item = this.readGallery(characterId).find((g) => g.id === id)
    if (!item?.file) return null
    try {
      return fs.readFileSync(item.file)
    } catch {
      return null
    }
  }

  // ── 事件簿（剧情节点 / 细节 / 偏好） ─────────────────────────────────────

  eventbookFile(characterId, archiveId) {
    return path.join(this.archiveDir(characterId, archiveId), 'eventbook.jsonl')
  }

  readEvents(characterId, archiveId) {
    const raw = readText(this.eventbookFile(characterId, archiveId), '')
    const out = []
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (t.length === 0) continue
      try {
        out.push(JSON.parse(t))
      } catch {
        /* 跳过损坏行 */
      }
    }
    return out
  }

  writeEvents(characterId, archiveId, events) {
    writeText(
      this.eventbookFile(characterId, archiveId),
      events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : ''),
    )
  }

  /**
   * 追加一条事件簿条目。
   *
   * `anchor.messageIndex` 是「记下这条时档案里已有多少条对话」——
   * 有了它，回溯到第 N 条时就能精确地把这之后的故事节点标为作废，
   * 而不必删掉它们（用户改剧本时要能对照被放弃的那条分支）。
   */
  addEvent(characterId, archiveId, { kind, title, text, tags, image }) {
    const events = this.readEvents(characterId, archiveId)
    const messageIndex = this.readMessages(characterId, archiveId).length
    const event = {
      id: newId('ev'),
      at: nowIso(),
      kind: ['plot', 'scene', 'detail', 'preference', 'note'].includes(kind) ? kind : 'note',
      title: String(title ?? '').trim() || '（未命名节点）',
      text: String(text ?? '').trim(),
      tags: Array.isArray(tags) ? tags : [],
      image: image ?? null,
      anchor: { messageIndex },
      voidedAt: null,
    }
    events.push(event)
    this.writeEvents(characterId, archiveId, events)
    return event
  }

  updateEvent(characterId, archiveId, id, patch) {
    const events = this.readEvents(characterId, archiveId)
    const i = events.findIndex((e) => e.id === id)
    if (i < 0) throw new Error(`找不到事件簿条目：${id}`)
    events[i] = { ...events[i], ...patch, id: events[i].id, at: events[i].at, updatedAt: nowIso() }
    this.writeEvents(characterId, archiveId, events)
    return events[i]
  }

  deleteEvent(characterId, archiveId, id) {
    const events = this.readEvents(characterId, archiveId)
    const kept = events.filter((e) => e.id !== id)
    if (kept.length === events.length) throw new Error(`找不到事件簿条目：${id}`)
    this.writeEvents(characterId, archiveId, kept)
    return true
  }

  /** 回溯时把某个位置之后的节点标为「已作废（另一条分支）」，而不是删除 */
  voidEventsAfter(characterId, archiveId, messageIndex, reason) {
    const events = this.readEvents(characterId, archiveId)
    let voided = 0
    const next = events.map((e) => {
      if (e.voidedAt || e.anchor?.messageIndex === undefined) return e
      if (e.anchor.messageIndex > messageIndex) {
        voided += 1
        return { ...e, voidedAt: nowIso(), voidedReason: reason ?? null }
      }
      return e
    })
    if (voided > 0) this.writeEvents(characterId, archiveId, next)
    return voided
  }

  /** 恢复某个位置之后被作废的节点（分支接回主线时用） */
  unvoidEventsAfter(characterId, archiveId, messageIndex) {
    const events = this.readEvents(characterId, archiveId)
    let restored = 0
    const next = events.map((e) => {
      if (!e.voidedAt || e.anchor?.messageIndex === undefined) return e
      const copy = { ...e }
      delete copy.voidedAt
      delete copy.voidedReason
      restored += 1
      return copy
    })
    if (restored > 0) this.writeEvents(characterId, archiveId, next)
    return restored
  }

  // ── 剧情分支（回溯 / 重说 / 重启留下的分叉） ─────────────────────────────

  branchesDir(characterId, archiveId) {
    return path.join(this.archiveDir(characterId, archiveId), 'branches')
  }

  /**
   * 回溯到第 `toIndex` 条之前：把 `messages[toIndex..]` 整段剪下来存成一个具名分支。
   *
   * 「改剧本」必须能反悔，所以被剪掉的剧情一个字节都不销毁 ——
   * 它成为一个分支，随时可以接回主线或被引用对照。
   */
  rewind(characterId, archiveId, { toIndex, reason }) {
    const messages = this.readMessages(characterId, archiveId)
    const target = Math.max(0, Math.min(Number(toIndex) || 0, messages.length))
    if (target >= messages.length) {
      return { branchId: null, cut: 0, remaining: messages.length, voidedEvents: 0, messages: [] }
    }
    const cut = messages.slice(target)
    const kept = messages.slice(0, target)

    const dir = this.branchesDir(characterId, archiveId)
    fs.mkdirSync(dir, { recursive: true })
    const branchId = newId('br')
    writeJson(path.join(dir, `${branchId}.json`), {
      id: branchId,
      createdAt: nowIso(),
      reason: reason ?? null,
      fromIndex: target,
      messages: cut,
    })

    this.writeMessages(characterId, archiveId, kept)
    const voidedEvents = this.voidEventsAfter(characterId, archiveId, target, branchId)
    const archive = this.getArchive(characterId, archiveId)
    this.touchArchive(characterId, archiveId, {
      branchCount: (archive?.branchCount ?? 0) + 1,
      lastBranchId: branchId,
    })
    return { branchId, cut: cut.length, remaining: kept.length, voidedEvents, messages: cut }
  }

  listBranches(characterId, archiveId) {
    const dir = this.branchesDir(characterId, archiveId)
    if (!exists(dir)) return []
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson(path.join(dir, f), null))
      .filter(Boolean)
      .map((b) => ({
        id: b.id,
        createdAt: b.createdAt,
        reason: b.reason,
        fromIndex: b.fromIndex,
        messageCount: Array.isArray(b.messages) ? b.messages.length : 0,
      }))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  readBranch(characterId, archiveId, branchId) {
    return readJson(path.join(this.branchesDir(characterId, archiveId), `${branchId}.json`), null)
  }

  /** 把某个分支接回主线末尾（切回那条剧情走向） */
  restoreBranch(characterId, archiveId, branchId) {
    const branch = this.readBranch(characterId, archiveId, branchId)
    if (!branch) throw new Error(`找不到分支：${branchId}`)
    const messages = this.readMessages(characterId, archiveId)
    const merged = [...messages, ...(branch.messages ?? [])]
    this.writeMessages(characterId, archiveId, merged)
    this.unvoidEventsAfter(characterId, archiveId, messages.length - 1)
    fs.rmSync(path.join(this.branchesDir(characterId, archiveId), `${branchId}.json`), { force: true })
    return { restored: (branch.messages ?? []).length, total: merged.length }
  }

  /** 把事件簿串成一段可直接进提示词的「前情提要」 */
  buildRecap(characterId, archiveId, { includeVoided = false, limit = 60 } = {}) {
    const events = this.readEvents(characterId, archiveId)
    const usable = events.filter((e) => includeVoided || !e.voidedAt)
    if (usable.length === 0) return ''
    const label = { plot: '剧情', scene: '场景', detail: '细节', preference: '偏好', note: '备注' }
    return usable
      .slice(-limit)
      .map((e) => {
        const who = label[e.kind] ?? '备注'
        const tags = e.tags?.length ? ` #${e.tags.join(' #')}` : ''
        return `- [${who}] ${e.title}${tags}：${e.text}`
      })
      .join('\n')
  }

  // ── 组合视图 ──────────────────────────────────────────────────────────────

  /** 当前激活的人物 / 档案 / 用户人设，以及它们的正文 —— 供提示词注入使用 */
  activeState() {
    const idx = this.readIndex()
    const character = idx.activeCharacterId ? this.getCharacter(idx.activeCharacterId) : null
    const archive =
      character && idx.activeArchiveId ? this.getArchive(character.id, idx.activeArchiveId) : null
    const userPersona = idx.activeUserPersonaId
      ? this.getUserPersona(idx.activeUserPersonaId)
      : null
    return {
      index: idx,
      character,
      archive,
      userPersona,
      characterPersona: character ? this.readPersona(character.id) : '',
      userPersonaText: userPersona ? this.readUserPersonaText(userPersona.id) : '',
    }
  }

  setActive({ characterId, archiveId, userPersonaId }) {
    const patch = {}
    if (characterId !== undefined) patch.activeCharacterId = characterId
    if (archiveId !== undefined) patch.activeArchiveId = archiveId
    if (userPersonaId !== undefined) patch.activeUserPersonaId = userPersonaId
    return this.writeIndex(patch)
  }

  /** 把一个 DSH 会话绑到档案上，之后重开会话也能自动接回同一条线 */
  bindSession(characterId, archiveId, sessionId) {
    const archive = this.getArchive(characterId, archiveId)
    if (!archive) return null
    const ids = new Set(archive.sessionIds ?? [])
    ids.add(sessionId)
    return this.touchArchive(characterId, archiveId, { sessionIds: [...ids] })
  }

  /** 磁盘占用概览 —— 用户关心的「别占太多内存」有据可查 */
  stats() {
    const characters = this.listCharacters()
    let messages = 0
    let archives = 0
    let bytes = 0
    for (const c of characters) {
      for (const a of this.listArchives(c.id)) {
        archives += 1
        const msgs = this.readMessages(c.id, a.id)
        messages += msgs.length
        try {
          bytes += fs.statSync(this.messagesFile(c.id, a.id)).size
        } catch {
          /* 文件不存在 */
        }
      }
    }
    return { dataRoot: this.root, characters: characters.length, archives, messages, messageBytes: bytes, config: this.config }
  }
}

export { newId, nowIso }

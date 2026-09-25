/**
 * 星野 · 前端数据出口
 *
 * 浏览器读不了本地文件，所以界面要的东西必须先落成一份可被 JSON 通道搬运的快照。
 * 这里把「当前有哪些人物、他们的人设与立绘/背景、各自有哪些档案、每个会话绑在哪条线上」
 * 写成一个 `ui-state.json`。
 *
 * 为什么不在客户端那半直接读文件：动态 Cordis 插件的 host 半是沙箱，没有 fs；
 * 而**这个插件是跑在 DSH 进程里的真 Node 模块**，有完整的 fs。
 * 让有权限的一侧准备好数据，让沙箱那侧只搬 JSON —— 这是最省事也最稳的分工。
 *
 * 图片以 data URL 内嵌，超过上限的图跳过：一份 ui-state.json 不该因为背景图变成几十 MB。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 单张图内嵌上限；超过就只给路径，界面自己去别处取 */
const MAX_EMBED_BYTES = 4 * 1024 * 1024

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** 画廊图的单张内嵌上限（比背景图更保守：面板里一次要显示好几张） */
const MAX_GALLERY_EMBED_BYTES = 1.5 * 1024 * 1024
/** 面板里最多内嵌几张画廊图 */
const MAX_GALLERY_ITEMS = 8

/**
 * 按 magic bytes 认图片类型。
 *
 * 为什么不能信扩展名：实测用户给的「zjz.png」字节头是 RIFF/WEBP —— 是 WebP 存成了 .png。
 * 按扩展名标成 image/png 之后，浏览器拿到的 data URL 声明与内容不符，图就不显示。
 */
function sniffMime(bytes) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length > 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (bytes.length > 3 && bytes.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  return null
}

function dataUrlOf(file) {
  if (!file) return null
  try {
    const stat = fs.statSync(file)
    if (stat.size > MAX_EMBED_BYTES) {
      return { tooLarge: true, path: file, bytes: stat.size }
    }
    const bytes = fs.readFileSync(file)
    // 先按字节认，认不出再退回扩展名 —— 用户放进来的图扩展名常常是错的
    const mime = sniffMime(bytes) ?? MIME[path.extname(file).toLowerCase()] ?? 'image/png'
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

/** 画廊条目：把实体文件也内嵌一份，面板才能直接显示 */
function galleryFor(store, characterId) {
  const items = store.listGallery(characterId).slice(0, MAX_GALLERY_ITEMS)
  return items.map((item) => {
    let data = null
    if (item.file) {
      try {
        const stat = fs.statSync(item.file)
        if (stat.size <= MAX_GALLERY_EMBED_BYTES) {
          const bytes = fs.readFileSync(item.file)
          const mime = sniffMime(bytes) ?? MIME[path.extname(item.file).toLowerCase()] ?? 'image/png'
          data = `data:${mime};base64,${bytes.toString('base64')}`
        }
      } catch {
        /* 文件没了就只显示文字 */
      }
    }
    return {
      id: item.id,
      kind: item.kind ?? 'memory',
      caption: item.caption ?? null,
      at: item.at,
      pending: item.pending === true,
      eventId: item.eventId ?? null,
      prompt: item.prompt ? String(item.prompt).slice(0, 400) : null,
      data,
    }
  })
}

/**
 * 生成并写入 ui-state.json。
 *
 * @param store - XingyeStore
 * @param extra - 额外信息（例如当前进程里已知的会话绑定）
 * @returns 写入的文件路径
 */
export function writeUiState(store, extra = {}) {
  const characters = {}

  for (const character of store.listCharacters()) {
    const images = store.characterImages(character.id)
    const archives = store.listArchives(character.id).map((a) => {
      const messages = store.readMessages(character.id, a.id)
      const events = store.readEvents(character.id, a.id)
      return {
        id: a.id,
        title: a.title,
        messageCount: messages.length,
        updatedAt: a.updatedAt,
        // 给界面做「最后一句话」预览用
        tail: messages.slice(-2).map((m) => ({
          speaker: m.speaker ?? (m.role === 'user' ? '用户' : '对方'),
          text: String(m.text ?? '').slice(0, 80),
          at: m.at,
        })),
        // 事件簿：面板要按时间顺序铺开，所以只留界面用得上的字段
        events: events.map((e) => ({
          id: e.id,
          kind: e.kind,
          title: e.title,
          text: String(e.text ?? '').slice(0, 400),
          tags: e.tags ?? [],
          at: e.at,
          voided: Boolean(e.voidedAt),
          image: e.image ?? null,
        })),
        eventCount: events.filter((e) => !e.voidedAt).length,
        branches: store.listBranches(character.id, a.id).map((b) => ({
          id: b.id,
          createdAt: b.createdAt,
          reason: b.reason,
          messageCount: b.messageCount,
        })),
      }
    })

    characters[character.id] = {
      id: character.id,
      name: character.name,
      tags: character.tags ?? [],
      createdAt: character.createdAt,
      updatedAt: character.updatedAt,
      persona: store.readPersona(character.id),
      personaSource: character.personaSource ?? null,
      images: {
        portrait: dataUrlOf(images.portrait),
        avatar: dataUrlOf(images.avatar),
        background: dataUrlOf(images.background),
        // 面板要显示路径提示，方便用户知道该往哪放图
        portraitPath: `${store.characterDir(character.id)}${path.sep}portrait.png`,
        backgroundPath: `${store.characterDir(character.id)}${path.sep}background.png`,
      },
      gallery: galleryFor(store, character.id),
      archives,
    }
  }

  // 用户自己的人设（微信式「我的人设」列表要按行铺开，所以连预览一起带上）
  const userPersonas = store.listUserPersonas().map((persona) => {
    const text = store.readUserPersonaText(persona.id)
    return {
      id: persona.id,
      name: persona.name,
      updatedAt: persona.updatedAt,
      preview: String(text).replace(/\s+/g, ' ').slice(0, 80),
      text,
    }
  })

  let sessions = {}
  try {
    sessions = JSON.parse(fs.readFileSync(path.join(store.root, 'sessions.json'), 'utf8'))
  } catch {
    /* 还没有任何会话绑定 */
  }

  const snapshot = {
    version: 1,
    generatedAt: new Date().toISOString(),
    dataRoot: store.root,
    active: store.readIndex(),
    characters,
    userPersonas,
    sessions,
    ...extra,
  }

  const file = path.join(store.root, 'ui-state.json')
  // 唯一临时文件名，避免多实例并发写入时 Windows EPERM 文件锁
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return file
}

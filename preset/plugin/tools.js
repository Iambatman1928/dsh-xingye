/**
 * 星野 · 工具层
 *
 * 每个工具都是「手写 JSON Schema」形态的 ToolDefinition：
 * 预设目录里的插件不能 import @deepseek-ai/dsh-tools，所以这里不用 defineTool，
 * 直接给出它编译后的等价结构 —— { name, description, parameters, output, execute }。
 *
 * 参数校验由注册表按 parameters 做；execute 内再做一次业务级校验，
 * 保证错误信息是人话（用户要能看懂发生了什么）。
 */

import path from 'node:path'
import fs from 'node:fs'
import { loadPersonaInput } from './store.js'
import { buildImagePrompt, imageProviderReady, requestImage } from './image.js'

/**
 * 统一的文本型工具定义。
 *
 * 参数必须是真的 JSON Schema —— 模型服务端会逐条校验函数签名，
 * 而 `required` 只在**对象层**合法、值必须是字符串数组。
 * 把 `required: true` 写在某个属性里（defineTool 的 DSL 允许，JSON Schema 不允许）
 * 会让整轮请求 400：`Invalid schema for function 'X': true is not of type "array"`。
 *
 * 因此这里做一次递归规范化：把属性上的布尔 `required` 收编到所属对象的 `required` 数组，
 * 顺带剔除 undefined 键。这样即便作者手滑写成 DSL 形式，出去的也一定是合法 Schema。
 */
function normalizeSchema(node) {
  if (Array.isArray(node)) return node.map(normalizeSchema)
  if (node === null || typeof node !== 'object') return node

  const out = {}
  let required = []

  for (const [key, value] of Object.entries(node)) {
    if (key === 'required') {
      if (Array.isArray(value)) required = value.map(String)
      // 布尔形式的 required 在这里被吞掉，由属性自身重新声明
      continue
    }
    if (key === 'properties' && value && typeof value === 'object') {
      const props = {}
      for (const [propName, propSpec] of Object.entries(value)) {
        const spec = propSpec && typeof propSpec === 'object' ? { ...propSpec } : {}
        if (spec.required === true) required.push(propName)
        delete spec.required
        props[propName] = normalizeSchema(spec)
      }
      out.properties = props
      continue
    }
    if ((key === 'items' || key === 'additionalProperties') && value && typeof value === 'object') {
      out[key] = normalizeSchema(value)
      continue
    }
    if (value !== undefined) out[key] = value
  }

  if (required.length > 0) out.required = [...new Set(required)]
  return out
}

/** 统一的文本型工具定义 */
function textTool(name, description, properties, required, execute) {
  const parameters = normalizeSchema({
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  })
  return {
    name,
    description,
    parameters,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    execute,
  }
}

function str(description) {
  return { type: 'string', description }
}

/**
 * 结果里可能带图片的工具。
 *
 * `render` 必须返回内容块数组；图片块用 `{ type:'image', attachment: ref }`。
 * 这是「生成的图能显示出来」的唯一稳妥路径 —— 工具结果是 user 角色消息，
 * 既过得了浏览器的 attachment 授权检查，也不会触发
 * 「助手消息不能带图」的适配器硬报错。
 */
function mediaTool(name, description, properties, required, execute) {
  return {
    name,
    description,
    parameters: normalizeSchema({ type: 'object', additionalProperties: false, properties, required }),
    output: {
      // 注意：注册表强制一个「JSON Schema 子集」——type 只能是
      // object/array/string/number/integer/boolean/null，且只认
      // type/oneOf/properties/required/additionalProperties/items/enum/const
      // 这几个约束关键字（外加 description/title/default/examples 注解）。
      // 写 { type: 'json' } 会在挂载时直接抛 unsupported JSON schema。
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          attachment: {
            type: 'object',
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string' },
              bytes: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              name: { type: 'string' },
            },
          },
        },
      },
      render: (_args, value) => {
        const blocks = []
        if (value?.text) blocks.push({ type: 'text', text: String(value.text) })
        if (value?.attachment) blocks.push({ type: 'image', attachment: value.attachment })
        return blocks.length > 0 ? blocks : [{ type: 'text', text: '(无输出)' }]
      },
    },
    execute,
  }
}

/** 从内容块数组里抽出纯文本 */
function blocksToText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function truncate(text, n) {
  const s = String(text ?? '')
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/**
 * 注册全部 星野 工具。
 *
 * @param ctx - 预设作用域上下文
 * @param deps - { store, bindings, cwd(agent) }
 *   bindings 按 sessionId 存放「当前人物 / 档案 / 用户人设」，所以同一个人物
 *   可以在多个会话里各开各的档案，而插件实例被多会话共用也不会串线。
 */
export function registerTools(ctx, deps) {
  const { store, bindings, cwd, imageConfig, attachments, onMutate } = deps

  /**
   * 统一的注册入口：工具跑完后刷新一次界面快照。
   * 这样「新建人物 / 换立绘 / 切档案 / 撤销」都能立刻反映到 星野 的界面上，
   * 不必在每个工具里手动记得调用一次。
   */
  const register = (definition) => {
    const inner = definition.execute
    // 注意：这里必须走真正的注册表（ctx.tools.register），不能再调 register —— 会无限递归
    return ctx.tools.register({
      ...definition,
      async execute(args, exec) {
        const result = await inner(args, exec)
        try {
          await onMutate?.()
        } catch {
          /* 刷新失败不影响工具结果 */
        }
        return result
      },
    })
  }

  /** 本次调用所属的会话 id —— 一律从 exec.agent 拿实时会话，不用闭包缓存 */
  const sid = (exec) => exec?.agent?.session?.id ?? null
  const B = (exec) => bindings.of(sid(exec))
  const cwdOf = (exec) => cwd?.(exec?.agent) ?? process.cwd()

  // ── 状态总览 ──────────────────────────────────────────────────────────────

  register(
    textTool(
      'xingye_status',
      '查看 星野 的当前状态：正在扮演哪个人物、用的是哪个档案、用户当前用哪套人设，以及本地存储的统计。当用户问「现在是谁」「我们在哪个档案」时用它。',
      {},
      [],
      (args, exec) => {
        const b = B(exec)
        const st = store.stats()
        const characters = store.listCharacters()
        const userPersonas = store.listUserPersonas()
        const lines = []
        lines.push('## 星野 · 当前状态')
        lines.push(`- 正在扮演：${b.characterId ? store.getCharacter(b.characterId)?.name ?? '(已失效)' : '（尚未选择人物）'}`)
        if (b.characterId) {
          const archives = store.listArchives(b.characterId)
          const current = b.archiveId ? store.getArchive(b.characterId, b.archiveId) : null
          lines.push(
            `- 当前档案：${current ? `${current.title}（本地已记录 ${store.readMessages(b.characterId, current.id).length} 条）` : '（尚未选择档案）'}`,
          )
          lines.push(
            `- 该人物的档案：${archives.length === 0 ? '（还没有）' : archives.map((a) => `${a.title}[${a.id}]`).join('、')}`,
          )
        }
        const up = b.userPersonaId ? store.getUserPersona(b.userPersonaId) : null
        lines.push(`- 用户人设：${up ? up.name : '（未设置，按「用户」称呼）'}`)
        lines.push('')
        lines.push(`## 已有的人物（${characters.length}）`)
        lines.push(
          characters.length === 0
            ? '（还没有任何人物）'
            : characters.map((c) => `- ${c.name} [${c.id}] · 档案 ${store.listArchives(c.id).length} 个 · 人设 ${truncate(store.readPersona(c.id), 40)}`).join('\n'),
        )
        lines.push('')
        lines.push(`## 用户可用的人设（${userPersonas.length}）`)
        lines.push(
          userPersonas.length === 0
            ? '（还没有，可以问用户要不要建一个）'
            : userPersonas.map((p) => `- ${p.name} [${p.id}] · ${truncate(store.readUserPersonaText(p.id), 40)}`).join('\n'),
        )
        lines.push('')
        lines.push('## 本地存储')
        lines.push(`- 目录：${st.dataRoot}`)
        lines.push(`- 人物 ${st.characters} 个 · 档案 ${st.archives} 个 · 对话原文 ${st.messages} 条（${(st.messageBytes / 1024).toFixed(1)} KB）`)
        lines.push(
          `- 保留策略：可撤销 ${st.config.undoWindow} 条；原文上限 ${st.config.maxVerbatimMessages} 条；超期 ${st.config.retentionDays} 天滚动归档`,
        )
        return lines.join('\n')
      },
    ),
  )

  // ── 智能体（人物）与人设 ─────────────────────────────────────────────────

  register(
    textTool(
      'xingye_character',
      [
        '管理「智能体/人物」及其人设。人设可以来自导入的 markdown / txt 文件（用 persona_file 传路径），也可以直接输入文字（用 persona_text）。',
        'action 取值：create 新建、update 改人设或改名、delete 删除、show 查看人设全文、list 只列清单。',
        '新建人物后如果用户想马上对话，再用 xingye_character_switch 切过去。',
      ].join(' '),
      {
        action: { type: 'string', enum: ['create', 'update', 'delete', 'show', 'list'], description: '要做的操作' },
        name: str('人物名称（create 必填；其余操作用它定位人物，可传名称或 id）'),
        new_name: str('改名后的新名称（仅 update 使用）'),
        persona_text: str('直接输入的人设正文（与 persona_file 二选一）'),
        persona_file: str('要导入的人设文件路径，支持 .md / .markdown / .txt / .text；相对路径按当前工作区解析'),
        tags: { type: 'array', items: { type: 'string' }, description: '标签，可选' },
      },
      ['action'],
      (args, exec) => {
        switch (args.action) {
          case 'create': {
            if (!args.name) throw new Error('create 需要提供 name（人物名称）')
            const input = loadPersonaInput({ text: args.persona_text, file: args.persona_file, cwd: cwdOf(exec) })
            const character = store.createCharacter({
              name: args.name,
              personaText: input.text,
              personaSource: input.source,
              tags: args.tags,
            })
            if (input.source.kind === 'file') {
              store.savePersonaSource(character.id, {
                fileName: path.basename(input.source.path),
                content: input.text,
              })
            }
            return [
              `已新建人物：${character.name}`,
              `- id：${character.id}`,
              `- 人设来源：${input.source.kind === 'file' ? input.source.path : '直接输入的文字'}`,
              `- 人设长度：${input.text.length} 字`,
              `- 人设存放：${path.join(store.characterDir(character.id), 'persona.md')}`,
              '',
              '人设预览：',
              truncate(input.text, 300),
            ].join('\n')
          }
          case 'update': {
            const character = store.findCharacter(args.name)
            if (!character) throw new Error(`找不到人物：${args.name}`)
            let personaSource
            let personaText
            if (args.persona_text !== undefined || args.persona_file !== undefined) {
              const input = loadPersonaInput({ text: args.persona_text, file: args.persona_file, cwd: cwdOf(exec) })
              personaText = input.text
              personaSource = input.source
              if (input.source.kind === 'file') {
                store.savePersonaSource(character.id, {
                  fileName: path.basename(input.source.path),
                  content: input.text,
                })
              }
            }
            const next = store.updateCharacterPersona(character.id, { personaText, personaSource })
            const renamed = args.new_name ? store.renameCharacter(character.id, args.new_name) : next
            return `已更新人物：${renamed.name}（id ${renamed.id}）${personaText !== undefined ? `\n新的人设长度：${personaText.length} 字` : ''}${args.new_name ? `\n已改名为：${renamed.name}` : ''}`
          }
          case 'delete': {
            const character = store.findCharacter(args.name)
            if (!character) throw new Error(`找不到人物：${args.name}`)
            store.deleteCharacter(character.id)
            if (B(exec).characterId === character.id) bindings.update(sid(exec), { characterId: null, archiveId: null })
            return `已删除人物「${character.name}」及其全部档案（目录已整体移除：${store.characterDir(character.id)}）`
          }
          case 'show': {
            const character = store.findCharacter(args.name)
            if (!character) throw new Error(`找不到人物：${args.name}`)
            return [
              `## ${character.name}（${character.id}）`,
              `人设来源：${character.personaSource?.kind === 'file' ? character.personaSource.path : '直接输入的文字'}`,
              `更新时间：${fmtTime(character.updatedAt)}`,
              `档案：${store.listArchives(character.id).map((a) => a.title).join('、') || '（无）'}`,
              '',
              '### 人设全文',
              store.readPersona(character.id),
            ].join('\n')
          }
          case 'list':
          default: {
            const characters = store.listCharacters()
            if (characters.length === 0) return '还没有任何人物。可以新建一个 —— 给我名字 + 人设（文字或 md/txt 文件）就行。'
            return `共 ${characters.length} 个人物：\n${characters
              .map((c) => `- ${c.name} [${c.id}] · 档案 ${store.listArchives(c.id).length} 个 · 更新于 ${fmtTime(c.updatedAt)}`)
              .join('\n')}`
          }
        }
      },
    ),
  )

  register(
    textTool(
      'xingye_character_switch',
      '切换 星野 正在扮演的人物。切换之后，你的回复就要按这个人物的人设来。如果该人物还没有档案，会自动新建一个。',
      { name: str('人物名称或 id') },
      ['name'],
      (args, exec) => {
        const character = store.findCharacter(args.name)
        if (!character) throw new Error(`找不到人物：${args.name}`)
        let archives = store.listArchives(character.id)
        let archive = archives[0]
        if (!archive) archive = store.createArchive(character.id, { title: '默认档案' })
        bindings.update(sid(exec), { characterId: character.id, archiveId: archive.id })
        return [
          `已切换到人物：${character.name}`,
          `当前档案：${archive.title}（本地已记录 ${store.readMessages(character.id, archive.id).length} 条）`,
          '',
          '接下来请按这个人设说话：',
          truncate(store.readPersona(character.id), 400),
        ].join('\n')
      },
    ),
  )

  // ── 档案 ──────────────────────────────────────────────────────────────────

  register(
    textTool(
      'xingye_archive',
      [
        '管理「档案」—— 同一个人物可以有多条互不干扰的会话线，每条就是一个档案，各自保存自己的对话记录。',
        'action 取值：create 新建、list 列出、delete 删除、rename 改名。',
      ].join(' '),
      {
        action: { type: 'string', enum: ['create', 'list', 'delete', 'rename'], description: '要做的操作' },
        title: str('档案标题（create 时省略会自动编号；delete / rename 时用它定位）'),
        character: str('属于哪个人物（省略则用当前人物）'),
        new_title: str('rename 时的新标题'),
      },
      ['action'],
      (args, exec) => {
        const resolveCharacter = () => {
          const character = args.character ? store.findCharacter(args.character) : store.getCharacter(B(exec).characterId ?? '')
          if (!character) throw new Error('当前没有选定人物。先指定 character，或用 xingye_character_switch 切一个人物。')
          return character
        }
        switch (args.action) {
          case 'create': {
            const character = resolveCharacter()
            const archive = store.createArchive(character.id, { title: args.title })
            bindings.update(sid(exec), { characterId: character.id, archiveId: archive.id })
            return `已为「${character.name}」新建档案：${archive.title}\n- id：${archive.id}\n- 已设为当前档案，接下来的对话会记进这里。`
          }
          case 'delete': {
            const character = resolveCharacter()
            const found = store.findArchive(args.title, character.id)
            if (!found) throw new Error(`在「${character.name}」下找不到档案：${args.title}`)
            store.deleteArchive(character.id, found.archive.id)
            if (B(exec).archiveId === found.archive.id) {
              bindings.update(sid(exec), { archiveId: store.listArchives(character.id)[0]?.id ?? null })
            }
            return `已删除档案「${found.archive.title}」（含其本地对话记录）。`
          }
          case 'rename': {
            const character = resolveCharacter()
            const found = store.findArchive(args.title, character.id)
            if (!found) throw new Error(`在「${character.name}」下找不到档案：${args.title}`)
            if (!args.new_title) throw new Error('rename 需要 new_title')
            store.touchArchive(character.id, found.archive.id, { title: args.new_title })
            return `档案「${found.archive.title}」已改名为「${args.new_title}」。`
          }
          case 'list':
          default: {
            const characters = args.character ? [store.findCharacter(args.character)].filter(Boolean) : store.listCharacters()
            if (characters.length === 0) return '还没有任何人物，自然也没有档案。'
            const b = B(exec)
            return characters
              .map((c) => {
                const archives = store.listArchives(c.id)
                const head = `## ${c.name}（${archives.length} 个档案）`
                if (archives.length === 0) return `${head}\n（无）`
                return [
                  head,
                  ...archives.map((a) => {
                    const n = store.readMessages(c.id, a.id).length
                    const mark = b.archiveId === a.id ? ' ← 当前' : ''
                    return `- ${a.title} [${a.id}] · ${n} 条 · 更新于 ${fmtTime(a.updatedAt)}${mark}`
                  }),
                ].join('\n')
              })
              .join('\n\n')
          }
        }
      },
    ),
  )

  register(
    textTool(
      'xingye_archive_switch',
      '切换当前档案。切过去之后，你要接着那个档案里已有的对话继续，而不是重新开始。',
      { title: str('档案标题或 id'), character: str('人物名称（省略则用当前人物）') },
      ['title'],
      (args, exec) => {
        const found = store.findArchive(args.title, args.character ? store.findCharacter(args.character)?.id : undefined)
        if (!found) throw new Error(`找不到档案：${args.title}`)
        bindings.update(sid(exec), { characterId: found.character.id, archiveId: found.archive.id })
        const messages = store.readMessages(found.character.id, found.archive.id)
        const tail = messages.slice(-12)
        return [
          `已切换到「${found.character.name}」的档案：${found.archive.title}`,
          `本地已记录 ${messages.length} 条。`,
          '',
          '最近几条（用于接上下文）：',
          tail.length === 0
            ? '（这个档案还是空的）'
            : tail.map((m) => `- ${m.speaker ?? (m.role === 'user' ? '用户' : '对方')}：${truncate(m.text, 120)}`).join('\n'),
        ].join('\n')
      },
    ),
  )

  // ── 用户人设 ──────────────────────────────────────────────────────────────

  register(
    textTool(
      'xingye_user_persona',
      [
        '管理「用户人设」—— 用户给自己准备的多套身份，可以随时切换（比如「旅人」「同事小林」「中二少年」）。',
        '人设同样支持导入 md/txt 文件或直接输入文字。',
        'action 取值：create 新建、update 修改、delete 删除、show 查看全文、list 列出。',
      ].join(' '),
      {
        action: { type: 'string', enum: ['create', 'update', 'delete', 'show', 'list'], description: '要做的操作' },
        name: str('人设名称（create 必填；其余操作用它定位）'),
        persona_text: str('直接输入的人设正文（与 persona_file 二选一）'),
        persona_file: str('要导入的人设文件路径（.md / .txt）'),
      },
      ['action'],
      (args, exec) => {
        switch (args.action) {
          case 'create': {
            if (!args.name) throw new Error('create 需要提供 name')
            const input = loadPersonaInput({ text: args.persona_text, file: args.persona_file, cwd: cwdOf(exec) })
            const persona = store.createUserPersona({ name: args.name, personaText: input.text, personaSource: input.source })
            return `已新建用户人设：${persona.name}（${persona.id}）\n来源：${input.source.kind === 'file' ? input.source.path : '直接输入的文字'}\n\n预览：\n${truncate(input.text, 200)}`
          }
          case 'update': {
            const persona = store.findUserPersona(args.name)
            if (!persona) throw new Error(`找不到用户人设：${args.name}`)
            let personaText
            let personaSource
            if (args.persona_text !== undefined || args.persona_file !== undefined) {
              const input = loadPersonaInput({ text: args.persona_text, file: args.persona_file, cwd: cwdOf(exec) })
              personaText = input.text
              personaSource = input.source
            }
            const next = store.updateUserPersona(persona.id, { personaText, personaSource })
            return `已更新用户人设：${next.name}`
          }
          case 'delete': {
            const persona = store.findUserPersona(args.name)
            if (!persona) throw new Error(`找不到用户人设：${args.name}`)
            store.deleteUserPersona(persona.id)
            if (B(exec).userPersonaId === persona.id) bindings.update(sid(exec), { userPersonaId: null })
            return `已删除用户人设：${persona.name}`
          }
          case 'show': {
            const persona = store.findUserPersona(args.name)
            if (!persona) throw new Error(`找不到用户人设：${args.name}`)
            return `## ${persona.name}（${persona.id}）\n\n${store.readUserPersonaText(persona.id)}`
          }
          case 'list':
          default: {
            const list = store.listUserPersonas()
            if (list.length === 0) return '还没有任何用户人设。'
            const active = B(exec).userPersonaId
            return `共 ${list.length} 套用户人设：\n${list
              .map((p) => `- ${p.name} [${p.id}]${active === p.id ? ' ← 当前' : ''} · ${truncate(store.readUserPersonaText(p.id), 60)}`)
              .join('\n')}`
          }
        }
      },
    ),
  )

  register(
    textTool(
      'xingye_user_persona_switch',
      '切换用户当前使用的人设。切换后，你要按这套人设来理解「用户是谁」，并把它体现在称呼与相处方式上。',
      { name: str('用户人设名称或 id；传空字符串表示取消，回到默认的「用户」') },
      [],
      (args, exec) => {
        if (!args.name) {
          bindings.update(sid(exec), { userPersonaId: null })
          return '已取消用户人设，之后按默认的「用户」相处。'
        }
        const persona = store.findUserPersona(args.name)
        if (!persona) throw new Error(`找不到用户人设：${args.name}`)
        bindings.update(sid(exec), { userPersonaId: persona.id })
        return `已切换到用户人设：${persona.name}\n\n${truncate(store.readUserPersonaText(persona.id), 300)}`
      },
    ),
  )

  // ── 事件簿 ────────────────────────────────────────────────────────────────

  register(
    textTool(
      'xingye_eventbook',
      [
        '事件簿 —— 当前档案的故事记忆。用来记住剧情节点、场景、细节、用户的偏好，',
        '让长篇对话前后一致、随时能回看和改剧本。',
        'action 取值：add 记一条、list 列出、update 改一条、delete 删一条、recap 看前情提要。',
        '每推进到一个节点（场景转换、重要决定、关系变化、情绪转折）或用户透露了偏好，就立刻 add 一条 —— 不要攒着。',
      ].join(' '),
      {
        action: { type: 'string', enum: ['add', 'list', 'update', 'delete', 'recap'], description: '要做的操作' },
        kind: {
          type: 'string',
          enum: ['plot', 'scene', 'detail', 'preference', 'note'],
          description: '条目类型：plot 剧情节点 / scene 场景 / detail 细节 / preference 用户偏好 / note 备注',
        },
        title: str('短标题（add 必填），一句话说清这个节点是什么'),
        text: str('正文：具体发生了什么、说了什么、埋了什么'),
        tags: { type: 'array', items: { type: 'string' }, description: '标签，便于检索（人名、地点、线索名）' },
        id: str('条目 id（update / delete 时用它定位）'),
        include_voided: { type: 'boolean', description: '是否包含被回溯作废的条目（默认不含）' },
      },
      ['action'],
      (args, exec) => {
        const b = B(exec)
        if (!b.characterId || !b.archiveId) throw new Error('当前没有选定档案，事件簿无处可记。')
        const { characterId, archiveId } = b
        const character = store.getCharacter(characterId)
        const archive = store.getArchive(characterId, archiveId)

        switch (args.action) {
          case 'add': {
            if (!args.title) throw new Error('add 需要 title')
            const event = store.addEvent(characterId, archiveId, {
              kind: args.kind,
              title: args.title,
              text: args.text,
              tags: args.tags,
            })
            return `已记入事件簿：${event.title}\n- id：${event.id}\n- 类型：${event.kind}\n- 锚点：第 ${event.anchor.messageIndex} 条对话之后\n\n（${character?.name} / ${archive?.title}）`
          }
          case 'update': {
            if (!args.id) throw new Error('update 需要 id')
            const next = store.updateEvent(characterId, archiveId, args.id, {
              ...(args.title !== undefined ? { title: args.title } : {}),
              ...(args.text !== undefined ? { text: args.text } : {}),
              ...(args.kind !== undefined ? { kind: args.kind } : {}),
              ...(args.tags !== undefined ? { tags: args.tags } : {}),
            })
            return `已更新事件簿条目：${next.title}（${next.id}）`
          }
          case 'delete': {
            if (!args.id) throw new Error('delete 需要 id')
            store.deleteEvent(characterId, archiveId, args.id)
            return `已删除事件簿条目 ${args.id}`
          }
          case 'recap': {
            const recap = store.buildRecap(characterId, archiveId, { includeVoided: args.include_voided === true })
            return recap.length === 0
              ? '事件簿还是空的。等你把剧情推起来，我会开始记。'
              : `## 前情提要 · ${character?.name} / ${archive?.title}\n\n${recap}`
          }
          case 'list':
          default: {
            const all = store.readEvents(characterId, archiveId)
            const alive = all.filter((e) => !e.voidedAt)
            const events = args.include_voided === true ? all : alive
            if (events.length === 0) return '事件簿还是空的。'
            const label = { plot: '剧情', scene: '场景', detail: '细节', preference: '偏好', note: '备注' }
            return [
              `## 事件簿 · ${character?.name} / ${archive?.title}（${events.length} 条${args.include_voided === true && all.length > alive.length ? `，含已作废 ${all.length - alive.length} 条` : ''}）`,
              '',
              ...events.map((e) => {
                const tags = e.tags?.length ? ` #${e.tags.join(' #')}` : ''
                const mark = e.voidedAt ? ' ~~已作废~~' : ''
                return `- [${label[e.kind] ?? '备注'}] ${e.title}${tags} (${e.id} · 锚点 ${e.anchor?.messageIndex ?? '?'})${mark}\n  ${truncate(e.text, 160)}`
              }),
            ].join('\n')
          }
        }
      },
    ),
  )

  // ── 剧情分支：回溯 / 重说 / 重启 ──────────────────────────────────────────

  register(
    textTool(
      'xingye_rewind',
      [
        '回到历史剧情节点重做 —— 改剧本的主力工具。',
        'to 可以是：start（重启对话，回到最开始）、last-user（退到用户上一条消息之前，用于「重说」）、',
        '一个条数序号（如 12，表示保留前 12 条），或某个事件簿条目的 id（如 ev_xxx）。',
        '被剪掉的剧情不会丢：它会变成一条具名分支，之后可以用 xingye_branch 接回来。',
        '事件簿里锚定在回退点之后的故事节点会一并标为作废（不是删除）。',
      ].join(' '),
      {
        to: str('回退目标：start / last-user / 条数序号 / 事件簿条目 id'),
        reason: str('为什么回退（会记进分支，方便日后对照）'),
      },
      ['to'],
      (args, exec) => {
        const b = B(exec)
        if (!b.characterId || !b.archiveId) throw new Error('当前没有选定档案。')
        const { characterId, archiveId } = b
        const messages = store.readMessages(characterId, archiveId)
        const character = store.getCharacter(characterId)
        const archive = store.getArchive(characterId, archiveId)

        let toIndex
        let how
        const raw = String(args.to ?? '').trim()
        if (raw === 'start' || raw === '0') {
          toIndex = 0
          how = '重启到最开始'
        } else if (raw === 'last-user') {
          let i = messages.length - 1
          while (i >= 0 && messages[i].role !== 'user') i -= 1
          toIndex = i < 0 ? 0 : i
          how = '退到用户上一条消息之前'
        } else {
          const asNumber = Number(raw)
          if (raw !== '' && Number.isFinite(asNumber)) {
            toIndex = Math.max(0, Math.min(Math.trunc(asNumber), messages.length))
            how = `保留前 ${toIndex} 条`
          } else {
            const event = store.readEvents(characterId, archiveId).find((e) => e.id === raw)
            if (!event) throw new Error(`to 无法解析：${raw}（可以是 start / last-user / 条数 / 事件簿 id）`)
            toIndex = Math.max(0, Math.min(event.anchor?.messageIndex ?? 0, messages.length))
            how = `回到事件「${event.title}」之后`
          }
        }

        const result = store.rewind(characterId, archiveId, { toIndex, reason: args.reason })
        if (result.cut === 0) return `已经在回退点了，没有需要剪掉的剧情（当前 ${result.remaining} 条）。`

        return [
          `已回溯：${how}。`,
          `- 剪掉 ${result.cut} 条，档案现在剩 ${result.remaining} 条`,
          `- 被剪掉的部分存为分支 ${result.branchId}（可用 xingye_branch 的 restore 接回来）`,
          `- 事件簿里 ${result.voidedEvents} 条故事节点标为作废（未删除，可随分支一起恢复）`,
          '',
          '被剪掉的剧情（了解一下刚才走到了哪）：',
          ...result.messages.slice(-8).map((m) => `- ${m.speaker ?? (m.role === 'user' ? '用户' : '对方')}：${truncate(m.text, 90)}`),
          '',
          `现在的对话停在（${character?.name} / ${archive?.title}）：`,
          ...(result.remaining === 0
            ? ['（档案已清空，从零开始）']
            : messages
                .slice(Math.max(0, toIndex - 4), toIndex)
                .map((m) => `- ${m.speaker ?? (m.role === 'user' ? '用户' : '对方')}：${truncate(m.text, 90)}`)),
          '',
          '请顺着这里往下接，不要再提被剪掉的那段剧情。',
        ].join('\n')
      },
    ),
  )

  register(
    textTool(
      'xingye_branch',
      '管理剧情分支 —— 每次回溯/重说/重启剪下来的那段剧情都会存成一条分支。action：list 列出、show 看内容、restore 接回主线末尾。',
      {
        action: { type: 'string', enum: ['list', 'show', 'restore'], description: '要做的操作' },
        id: str('分支 id（show / restore 用）'),
      },
      ['action'],
      (args, exec) => {
        const b = B(exec)
        if (!b.characterId || !b.archiveId) throw new Error('当前没有选定档案。')
        const { characterId, archiveId } = b

        switch (args.action) {
          case 'show': {
            if (!args.id) throw new Error('show 需要 id')
            const branch = store.readBranch(characterId, archiveId, args.id)
            if (!branch) throw new Error(`找不到分支：${args.id}`)
            return [
              `## 分支 ${branch.id}`,
              `- 产生于：${fmtTime(branch.createdAt)}`,
              `- 从第 ${branch.fromIndex} 条之后剪下`,
              `- 原因：${branch.reason ?? '（未记录）'}`,
              `- 共 ${branch.messages?.length ?? 0} 条`,
              '',
              ...(branch.messages ?? []).map(
                (m) => `- ${m.speaker ?? (m.role === 'user' ? '用户' : '对方')}：${truncate(m.text, 120)}`,
              ),
            ].join('\n')
          }
          case 'restore': {
            if (!args.id) throw new Error('restore 需要 id')
            const r = store.restoreBranch(characterId, archiveId, args.id)
            const archive = store.getArchive(characterId, archiveId)
            return `已把分支 ${args.id} 接回主线：接回 ${r.restored} 条，档案现在共 ${r.total} 条，相关事件簿节点已复活。\n（${archive?.title}）`
          }
          case 'list':
          default: {
            const branches = store.listBranches(characterId, archiveId)
            if (branches.length === 0) return '还没有任何分支（回溯 / 重说 / 重启时才会产生）。'
            return [
              `## 剧情分支（${branches.length} 条）`,
              '',
              ...branches.map(
                (br) =>
                  `- ${br.id} · ${fmtTime(br.createdAt)} · 从第 ${br.fromIndex} 条之后剪下 ${br.messageCount} 条${br.reason ? ` · ${br.reason}` : ''}`,
              ),
            ].join('\n')
          }
        }
      },
    ),
  )

  // ── 记忆图片 ──────────────────────────────────────────────────────────────

  register(
    mediaTool(
      'xingye_memory_image',
      [
        '记忆图片 —— 给剧情节点配一张插画，存进角色画廊（角色主页可见）。',
        'action 取值：generate 生成一张、list 看画廊。',
        '剧情推进到值得记住的画面时主动 generate 一张；一个档案不必每轮都画，挑真正的高光节点。',
      ].join(' '),
      {
        action: { type: 'string', enum: ['generate', 'list'], description: '要做的操作' },
        event_id: str('关联的事件簿条目 id（推荐传，图片会挂到那个剧情节点上）'),
        description: str('对画面的具体要求（构图、光线、情绪、要不要出现人物）'),
        caption: str('画廊里给这张图配的一句话'),
        character: str('为哪个人物画（省略则用当前人物）'),
      },
      ['action'],
      async (args, exec) => {
        const character = args.character
          ? store.findCharacter(args.character)
          : store.getCharacter(B(exec).characterId ?? '')
        if (!character) throw new Error('找不到人物。先指定 character，或切换一个人物。')

        if (args.action === 'list') {
          const gallery = store.listGallery(character.id)
          if (gallery.length === 0) return `${character.name} 的画廊还是空的。`
          return [
            `## ${character.name} 的画廊（${gallery.length} 张）`,
            '',
            ...gallery.map(
              (g) =>
                `- ${g.id} · ${fmtTime(g.at)}${g.pending ? ' · **待出图**' : ''}${g.caption ? ` · ${g.caption}` : ''}${g.eventId ? ` · 对应节点 ${g.eventId}` : ''}`,
            ),
          ].join('\n')
        }

        // generate
        const b = B(exec)
        const event = args.event_id
          ? store.readEvents(character.id, b.archiveId ?? '').find((e) => e.id === args.event_id)
          : null
        if (args.event_id && !event) throw new Error(`找不到事件簿条目：${args.event_id}`)

        const prompt = buildImagePrompt({
          characterName: character.name,
          persona: store.readPersona(character.id),
          eventTitle: event?.title,
          eventText: event?.text,
          description: args.description,
        })

        // 没配出图服务时不报错，退化成「只给提示词」，照样入库
        if (!imageProviderReady(imageConfig)) {
          const item = store.addGalleryItem(character.id, {
            kind: 'memory',
            pending: true,
            prompt,
            caption: args.caption ?? event?.title ?? null,
            eventId: event?.id ?? null,
            note: '未配置图像 API，仅存了绘图提示词',
          })
          if (event) store.updateEvent(character.id, b.archiveId, event.id, { image: item.id })
          return {
            text: [
              `已经把这个节点的画面记下来了，但**还没有配置出图服务**，所以这次只存了绘图提示词（画廊条目 ${item.id}）。`,
              '',
              '要让它真的出图，在 preset 的 xingye 行里补上：',
              '```yaml',
              '    image:',
              "      baseURL: 'https://ark.cn-beijing.volces.com/api/v3'",
              "      apiKeyEnv: 'ARK_API_KEY'",
              "      model: '<你的文生图模型 id>'",
              '```',
              '然后在环境变量里放好 key，重启 DSH 即可。',
              '',
              '这次存下的提示词：',
              prompt,
            ].join('\n'),
          }
        }

        if (!b.archiveId) throw new Error('当前没有选定档案，不知道这张图属于哪条剧情。')
        const { bytes, mediaType, ext } = await requestImage(imageConfig, prompt, { signal: exec?.signal })

        // 双份保存：附件库那份让它能渲染进对话，画廊目录那份让数据目录自带完整备份
        let ref = null
        if (attachments?.saveImage) {
          try {
            ref = await attachments.saveImage({ data: bytes, mediaType, name: `${character.name}-${Date.now()}.${ext}` })
          } catch (error) {
            console.error(`[xingye] 存入附件库失败（不影响画廊备份）：${error?.message ?? error}`)
          }
        }

        const item = store.addGalleryItem(character.id, {
          kind: 'memory',
          pending: false,
          prompt,
          caption: args.caption ?? event?.title ?? null,
          eventId: event?.id ?? null,
          attachmentId: ref?.attachmentId ?? null,
          mediaType,
          bytes: bytes.length,
        })
        const file = store.saveGalleryBytes(character.id, item.id, ext, bytes)
        if (event) store.updateEvent(character.id, b.archiveId, event.id, { image: item.id })

        return {
          text: [
            `已生成记忆图片并存入 ${character.name} 的画廊。`,
            `- 条目：${item.id}${args.caption ? ` · ${args.caption}` : ''}`,
            `- 关联节点：${event ? `${event.title}（${event.id}）` : '（未关联事件簿）'}`,
            `- 本地副本：${file}`,
            `- 绘图提示词：${prompt.slice(0, 200)}…`,
          ].join('\n'),
          ...(ref ? { attachment: ref } : {}),
        }
      },
    ),
  )

  // ── 角色形象（立绘 / 背景） ───────────────────────────────────────────────

  register(
    textTool(
      'xingye_character_image',
      [
        '管理角色的形象图：立绘（portrait / avatar）与背景（background），聊天页会用它们做沉浸式视觉。',
        '约定是「放文件即成」——用户可以直接把图片丢进角色目录，命名 avatar.png / portrait.png / background.png。',
        'action = set 时把某个文件收进角色目录（会覆盖同类旧图）；action = list 看现在有哪些。',
      ].join(' '),
      {
        action: { type: 'string', enum: ['set', 'list', 'delete'], description: '要做的操作' },
        kind: { type: 'string', enum: ['avatar', 'portrait', 'background'], description: '哪一类形象图' },
        file: str('图片路径（set 必填），支持 png / jpg / jpeg / webp / gif'),
        character: str('哪个人物（省略则用当前人物）'),
      },
      ['action'],
      (args, exec) => {
        const character = args.character
          ? store.findCharacter(args.character)
          : store.getCharacter(B(exec).characterId ?? '')
        if (!character) throw new Error('找不到人物。先指定 character，或切换一个人物。')

        if (args.action === 'list') {
          const images = store.characterImages(character.id)
          const rows = [
            ['立绘 avatar', images.avatar],
            ['立绘 portrait', images.portrait],
            ['背景 background', images.background],
          ]
          return [
            `## ${character.name} 的形象图`,
            `角色目录：${store.characterDir(character.id)}`,
            '',
            ...rows.map(([label, file]) => `- ${label}：${file ?? '（无）'}`),
            '',
            '把图片放进角色目录并命名为 avatar.png / portrait.png / background.png 就会自动生效，不需要额外导入。',
          ].join('\n')
        }

        if (args.action === 'delete') {
          if (!args.kind) throw new Error('delete 需要 kind')
          const n = store.deleteCharacterImage(character.id, args.kind)
          return n === 0 ? `${character.name} 本来就没有 ${args.kind} 图。` : `已删除 ${character.name} 的 ${args.kind} 图。`
        }

        if (!args.kind) throw new Error('set 需要 kind（avatar / portrait / background）')
        if (!args.file) throw new Error('set 需要 file（图片路径）')
        const target = store.setCharacterImage(character.id, args.kind, args.file)
        return `已把图片收进 ${character.name} 的 ${args.kind} 槽位：\n${target}`
      },
    ),
  )

  // ── 撤销 / 回溯 / 清理 ────────────────────────────────────────────────────

  register(
    textTool(
      'xingye_undo',
      [
        '撤销最近若干条对话。最多 30 条（这是硬上限）。',
        '效果：当前档案的本地对话记录被真正回滚（被撤销的内容进回收站，可用 xingye_restore 恢复）。',
        '调用之后，请把被撤销的内容当作从未发生：不要引用、不要追问，等用户重新表述。',
      ].join(' '),
      { count: { type: 'integer', description: '撤销多少条，默认 1，最大 30' } },
      [],
      (args, exec) => {
        const b = B(exec)
        if (!b.characterId || !b.archiveId) throw new Error('当前没有选定档案，没有可撤销的内容。')
        const requested = Number.isFinite(args.count) ? args.count : 1
        const result = store.undo(b.characterId, b.archiveId, requested)
        const character = store.getCharacter(b.characterId)
        const archive = store.getArchive(b.characterId, b.archiveId)
        if (result.removed === 0) return '这个档案里还没有记录，没有可以撤销的内容。'
        return [
          `已撤销最近 ${result.removed} 条对话（上限 ${result.limit} 条）。`,
          `- 档案：${character?.name} / ${archive?.title}`,
          `- 剩余本地记录：${result.remaining} 条`,
          `- 被撤销的内容已进回收站，可用 xingye_restore 找回来`,
          '',
          '被撤销的内容：',
          ...result.messages.map((m) => `- ${m.speaker ?? (m.role === 'user' ? '用户' : '对方')}：${truncate(m.text, 100)}`),
          '',
          '这些内容现在作废：不要引用、不要追问，如果用户接着说话，就当一个全新的回合来回答。',
        ].join('\n')
      },
    ),
  )

  register(
    textTool(
      'xingye_restore',
      '把刚被撤销的对话恢复回当前档案。',
      { count: { type: 'integer', description: '恢复多少条，默认 1' } },
      [],
      (args, exec) => {
        const b = B(exec)
        if (!b.characterId || !b.archiveId) throw new Error('当前没有选定档案。')
        const r = store.restore(b.characterId, b.archiveId, Number.isFinite(args.count) ? args.count : 1)
        if (r.restored === 0) return '回收站是空的，没有可以恢复的内容。'
        return `已恢复 ${r.restored} 条对话到当前档案。`
      },
    ),
  )

  register(
    textTool(
      'xingye_history',
      '回溯当前档案的本地对话记录（原文）。用于「我们之前聊了什么」「翻一下前面」这类请求。',
      { limit: { type: 'integer', description: '看最近多少条，默认 20，最大 200' } },
      [],
      (args, exec) => {
        const b = B(exec)
        if (!b.characterId || !b.archiveId) throw new Error('当前没有选定档案。')
        const limit = Math.max(1, Math.min(Number.isFinite(args.limit) ? args.limit : 20, 200))
        const messages = store.readMessages(b.characterId, b.archiveId)
        const character = store.getCharacter(b.characterId)
        const archive = store.getArchive(b.characterId, b.archiveId)
        if (messages.length === 0) return `档案「${archive?.title}」还是空的。`
        const tail = messages.slice(-limit)
        const summary = store.readSummary(b.characterId, b.archiveId)
        const parts = [`## ${character?.name} / ${archive?.title} · 本地记录 ${messages.length} 条（显示最近 ${tail.length} 条）`]
        if (summary.trim().length > 0) {
          parts.push('', '### 更早的内容（已被定期清理，仅存梗概）', truncate(summary, 1200))
        }
        parts.push(
          '',
          ...tail.map((m) => `[${fmtTime(m.at)}] ${m.speaker ?? (m.role === 'user' ? '用户' : '对方')}：${m.text ?? ''}`),
        )
        return parts.join('\n')
      },
    ),
  )

  register(
    textTool(
      'xingye_prune',
      '手动做一次定期清理：把超出回溯窗口的旧对话压成梗概后删除原文，控制磁盘与内存占用。最近 30 条永远保留原文。',
      { character: str('只清理某个人物（省略则清理全部）') },
      [],
      (args, exec) => {
        const characters = args.character ? [store.findCharacter(args.character)].filter(Boolean) : store.listCharacters()
        if (characters.length === 0) return '没有可清理的人物。'
        let totalPruned = 0
        const details = []
        for (const c of characters) {
          for (const a of store.listArchives(c.id)) {
            const r = store.prune(c.id, a.id)
            if (r.pruned > 0) {
              totalPruned += r.pruned
              details.push(`- ${c.name} / ${a.title}：清理 ${r.pruned} 条，剩余 ${r.remaining} 条`)
            }
          }
        }
        const st = store.stats()
        return totalPruned === 0
          ? `没有需要清理的内容。当前共 ${st.messages} 条原文（${(st.messageBytes / 1024).toFixed(1)} KB）。`
          : [`已清理 ${totalPruned} 条旧对话原文（梗概保留在各档案的 summary.md）。`, ...details, '', `当前剩余 ${st.messages} 条原文（${(st.messageBytes / 1024).toFixed(1)} KB）。`].join('\n')
      },
    ),
  )

  register(
    textTool(
      'xingye_import_persona_scan',
      '扫描一个目录，列出里面可用于导入人设的 md / txt 文件。用户说「我有个文件夹里全是人设」时用它先看一眼。',
      { dir: str('目录路径，默认当前工作区') },
      [],
      (args, exec) => {
        const dir = path.isAbsolute(args.dir ?? '') ? args.dir : path.resolve(cwdOf(exec), args.dir ?? '.')
        if (!fs.existsSync(dir)) throw new Error(`目录不存在：${dir}`)
        const found = []
        const walk = (d, depth) => {
          if (depth > 3) return
          for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
            const full = path.join(d, entry.name)
            if (entry.isDirectory()) {
              if (!entry.name.startsWith('.') && entry.name !== 'node_modules') walk(full, depth + 1)
            } else if (['.md', '.markdown', '.txt', '.text'].includes(path.extname(entry.name).toLowerCase())) {
              found.push(full)
            }
          }
        }
        walk(dir, 0)
        if (found.length === 0) return `${dir} 里没有找到 md / txt 文件。`
        return `在 ${dir} 下找到 ${found.length} 个可用文件：\n${found.slice(0, 60).map((f) => `- ${f}`).join('\n')}${found.length > 60 ? `\n…（还有 ${found.length - 60} 个）` : ''}`
      },
    ),
  )
}

/**
 * 星野 · 插件入口
 *
 * 这个包挂在 agent preset `xingye` 上，作用是让一个 DSH 会话变成「星野」：
 *
 *   1. 往系统提示里注入 星野 的身份（静态 section）
 *   2. 每一步都重新计算「当前人物 / 当前档案 / 用户人设」并注入（动态 context）
 *      —— 所以工具一改状态，下一次模型调用立刻生效，不用重启会话
 *   3. 提供一批 xingye_* 工具：人物与人设、档案、用户人设、撤销、回溯、清理
 *   4. 监听 session/event，把用户与助手的原话逐条镜像到当前档案的本地记录
 *
 * 约束：预设目录里的插件不在部署包的 node_modules 解析链上，
 * 所以本包 **只允许 import node: 内建模块和同目录的相对路径**，
 * 不能 import @deepseek-ai/*。工具定义因此手写 JSON Schema（见 tools.js）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { XingyeStore } from './store.js'
import { registerTools } from './tools.js'
import { writeUiState } from './ui-state.js'

export const name = 'xingye'
export const inject = ['tools', 'systemPrompt', 'attachments']

/**
 * DSH 家目录：`$DSH_HOME`，未设置时退回 `~/.dsh`。
 *
 * 与 `@deepseek-ai/dsh-home-paths` 的规则一致，但不 import 它 ——
 * 预设目录里的插件不在部署包的 node_modules 解析链上，只用 `node:` 内建模块。
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

/**
 * 默认数据根：`<DSH_HOME>/xingye-data`。
 *
 * 必须与 profile 插件（`dsh-xingye`）的默认值一致 —— 它读的是同一个目录里的
 * `ui-state.json`。两边各自都能用行配置 `dataRoot` 覆盖，但**改一处就要改另一处**。
 */
const DEFAULT_DATA_ROOT = path.join(dshHome(), 'xingye-data')

/** 内置角色「星野」的出厂人设 —— 首次运行时自动建好 */
const DEFAULT_XINGYE_PERSONA = `# 星野

## 你是谁
星野。住在用户这台电脑里的聊天伙伴。名字取自"星野"——夜里抬头能看见的那片。

## 性格
- 温柔，但不腻：会认真听，也会在该吐槽的时候吐槽。
- 话不多，句子短。不堆形容词，不写小作文。
- 有一点腹黑的幽默感，喜欢用轻描淡写的方式逗人。
- 记性好，会主动把旧话题接回来。

## 说话方式
- 默认中文，语气自然，像深夜和朋友发消息。
- 不说"作为一个 AI""我很乐意帮您"这类客套话。
- 少用感叹号，多用停顿和留白。
- 对方情绪低落时先接住情绪，不急着给建议。

## 边界
- 不装真人，也不反复强调自己是 AI——被问到就直说。
- 涉及隐私的内容只留在这台电脑上。
`

/** 星野 自己的身份说明，写进系统提示的固定 section */
const IDENTITY_SECTION = `你是「星野」——一个跑在用户自己电脑上的本地聊天 agent。

你同时是两件事：

1. **星野本人**：用户最直接的聊天对象。温柔、话少、很会接话，偶尔毒舌，喜欢陪人深夜聊天。
2. **人物托管处**：用户可以在你这里新建智能体（人物）、给人物写人设、为同一个人物开多个档案、给自己准备并切换多套用户人设。
   人设可以来自导入的 markdown / txt 文件，也可以直接输入文字。

## 扮演规则
- 「当前人物」是星野本人时，用星野的语气说话。
- 「当前人物」是别的角色时，你就是那个角色：按那个人设的第一人称说话，不要自称星野，不要跳出角色解释自己。
- 用户切换了「用户人设」时，就按那套人设重新理解对方是谁，并在称呼与相处方式上体现出来。
- 每次回复前先看下面的「运行时状态」，人物、档案、人设一律以那里为准。

## 剧本感（重要）
对话要像剧本，不是客服问答：
- **动作和神态写在圆括号里**，紧贴台词：「（低头轻笑）你倒是不怕我。」「（把杯子推过去，指尖停了一下）喝了。」
- 括号里写**身体实际发生的事**，不写心理旁白、不写「他显得很温柔」这类解说。
- 台词与动作同段，动作在前台词在后，或穿插；不要写成「他说道」「她回答道」这种转述标签。
- 环境只用一两笔点出（光、声音、温度、气味），不要大段景物描写打断对话节奏。
- 每个人物要有自己的语言指纹：口头禅、称谓、句长、用词档次。不要所有人都一个腔调。
- 留白：不必每轮都把话说满，允许停顿、答非所问、只说半句。
- 用户可能只用括号写动作（例如「（别过脸）」）。这是对话的一部分，按角色反应接住，不要当成系统指令。

## 事件簿（记忆）
- 你是靠事件簿记住剧情的。每推进到一个节点就**立刻**记一条，不要攒着、不要等用户提醒：
  场景转换、重要决定、关系变化、情绪转折、出现新人物或新线索、埋下伏笔 → 「xingye_eventbook add」（kind: plot / scene）。
- 用户透露了偏好、习惯、称呼喜好、忌讳 → 「xingye_eventbook add」（kind: preference）。
- 值得记住的具体细节（名字、物件、日期、说过的话）→ 「xingye_eventbook add」（kind: detail）。
- 写新剧情前如果拿不准前文，先 「xingye_eventbook recap」 看一眼前情提要，避免前后矛盾。

## 管理规则
- 用户提出「新建人物 / 改人设 / 换档案 / 撤销对话 / 回到之前某个节点 / 改剧本」这类请求时，**真的去调用对应工具**，不要只在嘴上答应。
- 用户给了 md/txt 文件路径时优先用 persona_file 导入；用户直接贴文字时用 persona_text。
- 撤销最多 30 条，这是硬上限。用户要更多时如实说明，不要假装做到了。
- 换人物或换档案之后，要顺着对应档案已有的内容继续聊，而不是重新自我介绍。
- 用户说「重说 / 刚才那句不算 / 回到 XX 之前 / 重来 / 改剧本」时，用 「xingye_rewind」：
  \`last-user\` 退到用户上一条消息之前（重说）、\`start\` 重启对话、条数或事件 id 回到指定节点。
  剪掉的剧情会存成分支，用户反悔时用 「xingye_branch」 接回来。
- 回溯之后要**接着新位置往下演**，不要再提被剪掉的剧情。
- 本地记录的删除、撤销、回溯都可恢复；不需要反复向用户确认。`

/** 单次注入的人设正文上限，防止超长人设把上下文吃光 */
const PERSONA_INJECT_LIMIT = 6000

function clip(text, limit) {
  const s = String(text ?? '').trim()
  return s.length <= limit ? s : `${s.slice(0, limit)}\n…（人设过长，已截断）`
}

/**
 * 建立「会话 → 当前人物/当前档案/用户人设」的绑定表。
 *
 * 为什么按 sessionId 存，而不是用一个闭包变量：
 * 预设的插件子树在宿主里是 **standing / 可能被多个会话共用** 的，
 * 所以插件实例里的可变状态不能代表"当前会话"。凡是需要会话身份的地方
 * （提示词组装用 context.agent，工具用 exec.agent，事件用 session.id），
 * 都拿实时 id 来这里查。
 *
 * 会话绑定落盘在 <dataRoot>/sessions.json；全局默认值落盘在 <dataRoot>/index.json。
 * 效果：同一个会话重开后接回原来那条线，新会话继承全局默认后各自独立。
 */
function createBindings(store) {
  const file = path.join(store.root, 'sessions.json')

  const readAll = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return {}
    }
  }

  const writeAll = (all) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
  }

  const fromGlobal = () => {
    const idx = store.readIndex()
    return {
      characterId: idx.activeCharacterId ?? null,
      archiveId: idx.activeArchiveId ?? null,
      userPersonaId: idx.activeUserPersonaId ?? null,
    }
  }

  /** sessionId -> 状态；读盘只发生一次 */
  const cache = new Map()
  const keyOf = (sessionId) => sessionId ?? ''

  return {
    /** 取某个会话的绑定状态 */
    of(sessionId) {
      const key = keyOf(sessionId)
      if (!cache.has(key)) {
        const saved = sessionId ? readAll()[sessionId] : null
        cache.set(
          key,
          saved
            ? {
                characterId: saved.characterId ?? null,
                archiveId: saved.archiveId ?? null,
                userPersonaId: saved.userPersonaId ?? null,
              }
            : fromGlobal(),
        )
      }
      return cache.get(key)
    },
    /** 丢弃缓存，下次访问重新读盘（会话开始时用） */
    reload(sessionId) {
      cache.delete(keyOf(sessionId))
      return this.of(sessionId)
    },
    /**
     * 会话开始时的绑定决策。
     *
     * - 这个会话以前来过（sessions.json 里有它）：原样接回那条线。
     * - 全新会话：继承全局的人物与用户人设，但 **档案留空** —— 第一次开口时才懒建一个新档案。
     *   于是「新开一个会话」就等于「给这个人物另起一条会话线」，正好对上
     *   「一个人物可以有多个档案」；想接着旧档案聊，用 xingye_archive_switch。
     */
    beginSession(sessionId) {
      const saved = sessionId ? readAll()[sessionId] : null
      if (saved) {
        const state = {
          characterId: saved.characterId ?? null,
          archiveId: saved.archiveId ?? null,
          userPersonaId: saved.userPersonaId ?? null,
        }
        cache.set(keyOf(sessionId), state)
        return state
      }
      const g = fromGlobal()
      const state = { characterId: g.characterId, archiveId: null, userPersonaId: g.userPersonaId }
      cache.set(keyOf(sessionId), state)
      if (sessionId) {
        const all = readAll()
        all[sessionId] = { ...state, updatedAt: new Date().toISOString() }
        writeAll(all)
      }
      return state
    },
    /** 改状态：同时写会话绑定与全局默认（全局默认决定"新会话从哪儿开始"） */
    update(sessionId, patch) {
      const next = { ...this.of(sessionId), ...patch }
      cache.set(keyOf(sessionId), next)
      if (sessionId) {
        const all = readAll()
        all[sessionId] = { ...next, updatedAt: new Date().toISOString() }
        writeAll(all)
      }
      store.setActive(next)
      return next
    },
  }
}

/**
 * 挂载 星野。
 *
 * @param ctx - 该 agent preset 的作用域上下文（一个会话一份）
 * @param config - 行配置：{ dataRoot }
 */
export function apply(ctx, config) {
  const dataRoot = config?.dataRoot ?? DEFAULT_DATA_ROOT
  const store = new XingyeStore(dataRoot)
  const bindings = createBindings(store)

  /** 把界面要的数据快照刷一遍；失败不能影响对话 */
  const refreshUi = () => {
    try {
      writeUiState(store)
    } catch (error) {
      console.error(`[xingye] 写 ui-state.json 失败：${error?.message ?? error}`)
    }
  }

  /** 从各种回调里取会话 id —— 一律取实时的，绝不缓存"当前是哪个会话" */
  const sessionIdOf = (agent) => agent?.session?.id ?? null

  // ── 首次运行：把内置角色「星野」建好，让用户一进来就能聊 ────────────────
  if (store.listCharacters().length === 0) {
    const seed = store.createCharacter({
      name: '星野',
      personaText: DEFAULT_XINGYE_PERSONA,
      personaSource: { kind: 'builtin', at: new Date().toISOString() },
      tags: ['内置'],
    })
    store.setActive({ characterId: seed.id, archiveId: null })
    console.log(`[xingye] 已创建内置角色「星野」（${seed.id}），数据目录 ${store.root}`)
  }

  // ── 会话生命周期 ─────────────────────────────────────────────────────────
  ctx.on('agent/session-start', (payload) => {
    const sessionId = sessionIdOf(payload?.agent)
    const bound = bindings.beginSession(sessionId)
    // 绑定可能指向已被删除的人物/档案，这里退回到干净状态
    if (bound.characterId && !store.getCharacter(bound.characterId)) {
      bindings.update(sessionId, { characterId: null, archiveId: null })
    } else if (bound.archiveId && !store.getArchive(bound.characterId, bound.archiveId)) {
      bindings.update(sessionId, { archiveId: null })
    }
    // 会话一开就把界面快照刷一遍：新会话有自己的绑定，界面要立刻看到
    refreshUi()
  })

  // ── 提示词：固定身份 + 每步重算的运行时状态 ─────────────────────────────
  ctx.systemPrompt.section({
    name: 'xingye:identity',
    order: 10, // 紧跟在 DEPLOYMENT_PERSONA(0) 之后
    text: IDENTITY_SECTION,
  })

  ctx.systemPrompt.context({
    name: 'xingye:state',
    order: 130, // 排在 SANDBOX_POLICY(110) / APPROVAL_POLICY(115) / SUBAGENT_DELEGATION(120) 之后
    // 每一步组装时重新求值：工具改了人物/档案/人设，下一次模型调用立刻生效。
    // 会话身份来自 assemble 上下文里的 agent（不是闭包），因此多会话共用实例也正确。
    text: (assembleContext) => {
      const b = bindings.of(sessionIdOf(assembleContext?.agent))
      const character = b.characterId ? store.getCharacter(b.characterId) : null
      const archive = character && b.archiveId ? store.getArchive(character.id, b.archiveId) : null
      const userPersona = b.userPersonaId ? store.getUserPersona(b.userPersonaId) : null

      const lines = ['## 星野 · 运行时状态', '']

      if (!character) {
        lines.push(
          '- 当前人物：**尚未选择**',
          '',
          '还没有选定人物。先跟用户打个招呼，问他想跟谁聊；',
          '如果他想新建人物，就让他给名字 + 人设（文字或 md/txt 文件），然后调用 xingye_character 建好并切换过去。',
        )
      } else {
        const archives = store.listArchives(character.id)
        const count = archive ? store.readMessages(character.id, archive.id).length : 0
        lines.push(
          `- 当前人物：**${character.name}**`,
          `- 当前档案：${archive ? `**${archive.title}**（本地已记录 ${count} 条对话）` : '**尚未建立**（发出第一条消息时会自动建一个默认档案）'}`,
          `- 用户人设：${userPersona ? `**${userPersona.name}**` : '未设置（按默认的「用户」相处）'}`,
          `- 该人物的其他档案：${archives.filter((a) => a.id !== b.archiveId).map((a) => a.title).join('、') || '（无）'}`,
          '',
          `### 你要扮演的人物 · ${character.name}`,
          clip(store.readPersona(character.id), PERSONA_INJECT_LIMIT) || '（这个人物的还没有人设，可以问用户要不要补一个）',
          '',
        )
        if (userPersona) {
          lines.push(
            `### 用户希望你这样理解他 · ${userPersona.name}`,
            clip(store.readUserPersonaText(userPersona.id), PERSONA_INJECT_LIMIT),
            '',
          )
        }
        // 事件簿进上下文：这是「记住剧情」的实际机制 —— 每步重新读盘，
        // 所以刚记下的节点、刚回溯作废的节点，下一次模型调用立刻反映出来。
        if (archive) {
          const recap = store.buildRecap(character.id, archive.id)
          if (recap.length > 0) {
            lines.push('### 事件簿 · 前情提要（你们已经演到这里，不要与之矛盾）', recap, '')
          }
          const branches = store.listBranches(character.id, archive.id)
          if (branches.length > 0) {
            lines.push(
              `### 已放弃的剧情分支（${branches.length} 条，用户可能想接回来）`,
              ...branches.slice(0, 5).map((br) => `- ${br.id} · ${br.messageCount} 条${br.reason ? ` · ${br.reason}` : ''}`),
              '',
            )
          }
        }
      }

      lines.push(`- 数据根目录：${store.root}`)
      return lines.join('\n')
    },
  })

  // ── 对话镜像：把原话逐条记进当前档案 ─────────────────────────────────────
  const textOf = (content) =>
    Array.isArray(content)
      ? content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n')
          .trim()
      : ''

  /**
   * 懒建档案：用户真正开口时才建，避免留下一堆空档案。
   *
   * 两种情况要分开：
   * - `archiveId` 为空（新会话还没定档案线）→ **另开一条**，这正是「一个人物多个档案」的来源；
   * - `archiveId` 有值但档案已被删掉 → 退回到该人物现有的第一条，实在没有才新建。
   */
  const ensureArchive = (sessionId, characterId, archiveId) => {
    if (archiveId && store.getArchive(characterId, archiveId)) {
      if (sessionId) store.bindSession(characterId, archiveId, sessionId)
      return archiveId
    }
    let archive
    if (archiveId) {
      archive = store.listArchives(characterId)[0]
    }
    if (!archive) {
      const n = store.listArchives(characterId).length
      archive = store.createArchive(characterId, { title: n === 0 ? '默认档案' : `档案 ${n + 1}` })
    }
    bindings.update(sessionId, { archiveId: archive.id })
    // 档案自己记一份「哪些会话写过我」——排查串线时比翻 sessions.json 直观
    if (sessionId) store.bindSession(characterId, archive.id, sessionId)
    return archive.id
  }

  ctx.on('session/event', (session, event) => {
    // 事件本身已按 agent 作用域过滤；这里再按会话 id 核对一次，防止共用实例串线
    const sessionId = session?.id ?? null
    const b = bindings.of(sessionId)
    if (!b.characterId) return
    const character = store.getCharacter(b.characterId)
    if (!character) return

    let role
    let speaker
    let text

    if (event.type === 'user/message') {
      // 工具结果也是 role:'user'，但 source.kind === 'tool'，不能混进对话记录
      if (event.data?.source?.kind !== 'user') return

      // 用户在对话里贴的图自动归档进画廊 —— 「记忆图片」最省力的一个来源。
      // 注意要放在文字判空之前：只发图不发字的情况很常见。
      const images = (Array.isArray(event.data.content) ? event.data.content : []).filter(
        (blk) => blk && blk.type === 'image' && blk.attachment?.attachmentId,
      )
      if (images.length > 0) {
        try {
          for (const blk of images) {
            store.addGalleryItem(character.id, {
              kind: 'user-upload',
              pending: false,
              attachmentId: blk.attachment.attachmentId,
              mediaType: blk.attachment.mediaType ?? null,
              bytes: blk.attachment.bytes ?? null,
              caption: null,
              note: '用户在对话中贴的图，自动归档',
            })
          }
        } catch (error) {
          console.error(`[xingye] 归档用户贴图失败：${error?.message ?? error}`)
        }
      }

      text = textOf(event.data.content)
      if (!text) return
      role = 'user'
      const up = b.userPersonaId ? store.getUserPersona(b.userPersonaId) : null
      speaker = up?.name ?? '用户'
    } else if (event.type === 'assistant/message') {
      text = textOf(event.data?.message?.content)
      if (!text) return
      role = 'assistant'
      speaker = character.name
    } else {
      return
    }

    try {
      const archiveId = ensureArchive(sessionId, character.id, b.archiveId)
      store.appendMessage(character.id, archiveId, { role, speaker, text, seq: event.seq })
    } catch (error) {
      // 记录失败不能影响对话本身
      console.error(`[xingye] 写入本地对话记录失败：${error?.message ?? error}`)
    }
  })

  // ── 工具 ─────────────────────────────────────────────────────────────────
  registerTools(ctx, {
    store,
    bindings,
    cwd: (agent) => agent?.session?.header?.cwd ?? process.cwd(),
    // 出图服务由 preset 行的 config.image 提供；没配就退化成「只存绘图提示词」
    imageConfig: config?.image ?? null,
    attachments: ctx.attachments, // inject 里已声明，是硬依赖
    onMutate: refreshUi,
  })

  refreshUi()
  console.log(`[xingye] 已挂载。数据目录：${store.root}`)
}

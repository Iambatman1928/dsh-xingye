/**
 * 星野 agent preset 插件的本地功能验证脚本（不依赖 DSH 运行时）。
 * 用一个假的 ctx 走完「挂载 → 会话开始 → 对话镜像 → 各工具调用」全流程。
 *
 * 运行： node tools/verify.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply } from '../preset/plugin/index.js'

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingye-verify-'))
const log = []
const tools = new Map()
const sections = []
const contexts = []
const handlers = new Map()

const ctx = {
  tools: {
    register(def) {
      if (tools.has(def.name)) throw new Error(`重复注册工具：${def.name}`)
      tools.set(def.name, def)
      return () => {}
    },
  },
  systemPrompt: {
    section(s) {
      sections.push(s)
      return () => {}
    },
    context(c) {
      contexts.push(c)
      return () => {}
    },
  },
  // 附件服务的替身：记录被保存的图片，返回一个 ref 形状
  attachments: {
    saved: [],
    async saveImage(input) {
      this.saved.push(input)
      return { attachmentId: 'att_stub_' + this.saved.length, mediaType: input.mediaType, bytes: input.data.length, width: 1024, height: 1024, name: input.name }
    },
  },  on(name, fn) {
    if (!handlers.has(name)) handlers.set(name, [])
    handlers.get(name).push(fn)
    return () => {}
  },
}

const emit = (name, ...args) => {
  for (const fn of handlers.get(name) ?? []) fn(...args)
}

// 工具的第二个参数就是 live exec：星野只从 exec.agent 取会话身份
let execCtx = {}
const call = async (name, args = {}) => {
  const def = tools.get(name)
  if (!def) throw new Error(`没有这个工具：${name}`)
  return def.execute(args, execCtx)
}

// 提示词组装时读 context.agent
const assembleCtx = () => ({ agent: execCtx.agent })
const stateText = () => contexts[0].text(assembleCtx())

const step = (title) => log.push(`\n${'='.repeat(70)}\n${title}\n${'='.repeat(70)}`)

function assert(cond, label) {
  log.push(`${cond ? '  ✓' : '  ✗ 失败'} ${label}`)
  if (!cond) process.exitCode = 1
}

// ── 1. 挂载 ────────────────────────────────────────────────────────────────
step('1. 挂载插件')
apply(ctx, { dataRoot })
assert(tools.size >= 10, `注册了 ${tools.size} 个工具：${[...tools.keys()].join(', ')}`)
assert(sections.length === 1 && sections[0].name === 'xingye:identity', '注册了身份 section')
assert(contexts.length === 1 && contexts[0].name === 'xingye:state', '注册了动态状态 context')
// 模型服务端会逐条校验函数签名：required 只能在对象层、且必须是字符串数组。
// 曾经把 defineTool 的 DSL 写法（属性里写 required: true）带进 JSON Schema，
// 导致整轮请求 400：Invalid schema for function 'xingye_archive': true is not of type "array"。
step('1b. 工具参数必须是合法 JSON Schema（模型服务端会逐条校验）')
const schemaProblems = []
const walkSchema = (node, where) => {
  if (Array.isArray(node)) {
    node.forEach((n, i) => walkSchema(n, `${where}[${i}]`))
    return
  }
  if (!node || typeof node !== 'object') return
  if ('required' in node && !Array.isArray(node.required)) {
    schemaProblems.push(`${where}.required 必须是数组，实际是 ${JSON.stringify(node.required)}`)
  }
  if (Array.isArray(node.required) && node.required.some((r) => typeof r !== 'string')) {
    schemaProblems.push(`${where}.required 只能放字符串`)
  }
  if (node.properties) {
    for (const [propName, spec] of Object.entries(node.properties)) {
      if (spec && typeof spec === 'object' && 'required' in spec) {
        schemaProblems.push(`${where}.properties.${propName} 里出现了 required —— 必须写进所属对象的 required 数组`)
      }
      walkSchema(spec, `${where}.properties.${propName}`)
    }
  }
  if (node.items) walkSchema(node.items, `${where}.items`)
}
for (const [toolName, def] of tools) {
  walkSchema(def.parameters, `${toolName}.parameters`)
  if (def.parameters?.type !== 'object') schemaProblems.push(`${toolName}.parameters.type 必须是 object`)
  if (def.parameters?.additionalProperties !== false) schemaProblems.push(`${toolName}.parameters.additionalProperties 必须显式 false`)
  if (def.output?.schema?.type !== 'string' && def.output?.schema?.type !== 'object') {
    schemaProblems.push(`${toolName}.output.schema.type 只能是 string 或 object`)
  }
  if (typeof def.output?.render !== 'function') schemaProblems.push(`${toolName}.output.render 缺失`)
  if (typeof def.execute !== 'function') schemaProblems.push(`${toolName}.execute 缺失`)
  if (def.name !== toolName) schemaProblems.push(`${toolName} 的 name 字段与注册名不一致`)
  // 宿主强制要求 render 返回内容块数组；这里用最小样例真的调一次
  if (typeof def.output?.render === 'function') {
    try {
      const sample = def.output.schema.type === 'string' ? 'x' : { text: 'x' }
      const blocks = def.output.render({}, sample)
      if (!Array.isArray(blocks) || blocks.some((b) => !b || typeof b.type !== 'string')) {
        schemaProblems.push(`${toolName}.output.render 必须返回带 type 的内容块数组`)
      }
    } catch (error) {
      schemaProblems.push(`${toolName}.output.render 抛错：${error.message}`)
    }
  }
}
assert(schemaProblems.length === 0, `${tools.size} 个工具的参数/输出 schema 全部合法`)
for (const problem of schemaProblems) log.push(`    ! ${problem}`)

step('1c. 每个工具的必填项确实在 properties 里')
for (const [toolName, def] of tools) {
  for (const key of def.parameters.required ?? []) {
    if (!(key in def.parameters.properties)) schemaProblems.push(`${toolName}.required 里的 ${key} 不在 properties 中`)
  }
}
assert(schemaProblems.length === 0, 'required 与 properties 一致')
step('1d. 按注册表的 JSON Schema 子集严格校验（曾在这里翻过车）')
// 注册表 force 一个子集：type 只能是这 7 种；只认下面这些关键字。
// 之前把 output.schema 写成 { type: 'json' }，挂载时直接
// 「unsupported JSON schema: schema.type must be one of ...」整行挂掉。
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const CONSTRAINT_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const strictProblems = []
const checkSchema = (node, where) => {
  if (node === undefined) return
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    strictProblems.push(where + ' 必须是 schema 对象')
    return
  }
  for (const key of Object.keys(node)) {
    if (!CONSTRAINT_KEYWORDS.has(key) && !ANNOTATION_KEYWORDS.has(key)) {
      strictProblems.push(where + '.' + key + ' 不是子集允许的关键字')
    }
  }
  if ('type' in node && !SCHEMA_TYPES.includes(node.type)) {
    strictProblems.push(where + '.type=' + JSON.stringify(node.type) + ' 不在白名单里')
  }
  if ('required' in node) {
    if (!Array.isArray(node.required) || node.required.some((r) => typeof r !== 'string')) {
      strictProblems.push(where + '.required 必须是字符串数组')
    } else if (node.properties) {
      for (const r of node.required) {
        if (!(r in node.properties)) strictProblems.push(where + '.required 里的 ' + r + ' 不在 properties 中')
      }
    }
  }
  if ('additionalProperties' in node && typeof node.additionalProperties !== 'boolean') {
    strictProblems.push(where + '.additionalProperties 必须是 boolean')
  }
  if ('oneOf' in node && (!Array.isArray(node.oneOf) || node.oneOf.length < 2)) {
    strictProblems.push(where + '.oneOf 至少要两项')
  }
  if (node.properties) {
    for (const [k, sub] of Object.entries(node.properties)) checkSchema(sub, where + '.properties.' + k)
  }
  if (node.items) checkSchema(node.items, where + '.items')
  if (Array.isArray(node.oneOf)) node.oneOf.forEach((s, i) => checkSchema(s, where + '.oneOf[' + i + ']'))
}
for (const [toolName, def] of tools) {
  checkSchema(def.parameters, toolName + '.parameters')
  checkSchema(def.output?.schema, toolName + '.output.schema')
}
assert(strictProblems.length === 0, '所有工具的 parameters / output.schema 都落在注册表允许的子集内')
step('1e. 用部署里**真实**的校验器再跑一遍（本地镜像是抄的，可能过时）')
/**
 * 找到宿主里那份 `@deepseek-ai/dsh-tools`。
 *
 * 它不在包的 exports 映射里（所以只能按**绝对路径** import），而且装在哪取决于
 * 你怎么跑 DSH：源码 checkout、桌面端自带的 dependencies、或某个 profile 的 node_modules。
 * 于是按候选列表挨个找，找不到就退回本地镜像（下面会说明），而不是让脚本整个挂掉。
 */
function findRealValidator() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const roots = [
    process.env.DSH_NODE_MODULES,
    path.join(dshHome, 'profiles', 'node_modules'),
    ...(() => {
      try {
        return fs.readdirSync(path.join(dshHome, 'profiles'))
          .map((entry) => path.join(dshHome, 'profiles', entry, 'node_modules'))
      } catch {
        return []
      }
    })(),
    // 桌面端（Tauri / Electron）会把 harness 解到用户数据目录下
    process.env.APPDATA
      ? path.join(process.env.APPDATA, 'io.github.hairyf.deepseek-harness-desktop', 'dependencies', 'dsh', 'node_modules')
      : null,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'dsh-desktop', 'dependencies', 'dsh', 'node_modules') : null,
  ].filter(Boolean)

  for (const root of roots) {
    const candidate = path.join(root, '@deepseek-ai', 'dsh-tools', 'lib', 'types', 'json-schema.js')
    if (fs.existsSync(candidate)) return pathToFileURL(candidate).href
  }
  return null
}

const REAL_VALIDATOR_PATH = findRealValidator()
let assertSupportedJsonSchema = null
if (REAL_VALIDATOR_PATH) {
  try {
    ;({ assertSupportedJsonSchema } = await import(REAL_VALIDATOR_PATH))
  } catch (error) {
    log.push('    （加载不到真实校验器，只用本地镜像：' + error.message + '）')
  }
}
if (typeof assertSupportedJsonSchema === 'function') {
  const realProblems = []
  for (const [toolName, def] of tools) {
    for (const [label, schema] of [['parameters', def.parameters], ['output.schema', def.output?.schema]]) {
      try {
        assertSupportedJsonSchema(schema)
      } catch (error) {
        realProblems.push(toolName + '.' + label + ' → ' + error.message)
      }
    }
  }
  assert(realProblems.length === 0, '真实校验器通过（' + tools.size + ' 个工具）')
  for (const problem of realProblems) log.push('    ! ' + problem)
} else {
  log.push('    ⚠ 没跑成真实校验器 —— 挂载前请务必重启 DSH 验一次')
}
for (const problem of strictProblems) log.push('    ! ' + problem)

// ── 2. 会话开始 ────────────────────────────────────────────────────────────
step('2. 会话开始（内置角色应当已就位）')
const agent = { session: { id: 'session-verify', header: { cwd: process.cwd() } } }
execCtx = { agent }
execCtx = { agent }
emit('agent/session-start', { agent, source: { kind: 'new' } })

const state0 = stateText()
log.push(state0)
assert(state0.includes('星野'), '状态里出现「星野」')
assert(state0.includes('你要扮演的人物'), '状态里注入了人物人设')
assert(state0.includes('尚未建立') || state0.includes('当前档案'), '状态里说明了档案情况')

// ── 3. 对话镜像 ────────────────────────────────────────────────────────────
step('3. 对话镜像到本地档案')
const userMsg = (text) => ({
  type: 'user/message',
  seq: 1,
  time: Date.now(),
  data: { id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
})
const toolMsg = {
  type: 'user/message',
  seq: 2,
  time: Date.now(),
  data: { id: 'm2', role: 'user', content: [{ type: 'tool-result', toolCallId: 't', content: [] }], source: { kind: 'tool', callId: 't' } },
}
const asstMsg = (text) => ({
  type: 'assistant/message',
  seq: 3,
  time: Date.now(),
  data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'x', model: 'y' } } },
})

emit('session/event', agent.session, toolMsg) // 应被忽略
log.push(`  用户：在吗？`)
emit('session/event', agent.session, userMsg('在吗？'))
log.push(`  星野：在的。`)
emit('session/event', agent.session, asstMsg('在的。'))

const afterMirror = await call('xingye_history', { limit: 10 })
log.push(afterMirror)
assert(afterMirror.includes('在吗？') && afterMirror.includes('在的。'), '用户与助手的话都被记录了')
assert(!afterMirror.includes('tool-result') && !afterMirror.includes('工具结果'), '工具结果没有被误记进对话')

// ── 4. 新建人物 + 导入 md 人设 ────────────────────────────────────────────
step('4. 新建人物（导入 md 文件）')
const personaFile = path.join(dataRoot, '林砚.md')
fs.writeFileSync(personaFile, '# 林砚\n\n## 身份\n古籍修复师，三十岁上下，说话慢。\n\n## 说话方式\n- 喜欢用旧书做比喻。\n', 'utf8')
log.push(await call('xingye_character', { action: 'create', name: '林砚', persona_file: personaFile, tags: ['原创'] }))
assert(fs.existsSync(path.join(dataRoot, 'characters')), '人物目录已建立')

step('4b. 新建人物（直接输入文字）')
log.push(await call('xingye_character', { action: 'create', name: '小满', persona_text: '小满，十六岁，话多，喜欢用「诶」开头。' }))
log.push(await call('xingye_character', { action: 'list' }))

// ── 5. 切换人物 → 状态立刻变化 ────────────────────────────────────────────
step('5. 切换人物后，注入的状态应立刻跟着变')
log.push(await call('xingye_character_switch', { name: '林砚' }))
const state1 = stateText()
log.push(state1)
assert(state1.includes('林砚'), '状态里出现新人物「林砚」')
assert(state1.includes('古籍修复师'), '新人设正文被注入')
assert(!state1.includes('住在用户这台电脑里'), '旧人物的人设已经不在提示里')

// 换人之后的对话应记在林砚名下
emit('session/event', agent.session, userMsg('这本书还能救吗'))
emit('session/event', agent.session, asstMsg('先看纸。'))
const hist = await call('xingye_history', { limit: 10 })
assert(hist.includes('林砚：先看纸。'), '新对话以新人物署名记录')

// ── 6. 多档案 ──────────────────────────────────────────────────────────────
step('6. 同一个人物的多个档案')
log.push(await call('xingye_archive', { action: 'create', title: '另一个夜晚' }))
log.push(await call('xingye_archive', { action: 'list' }))
const listOut = await call('xingye_archive', { action: 'list' })
assert(listOut.includes('默认档案') && listOut.includes('另一个夜晚'), '两个档案都在')

step('6b. 切回旧档案，内容应当还在')
log.push(await call('xingye_archive_switch', { title: '默认档案' }))
const back = await call('xingye_history', { limit: 10 })
assert(back.includes('这本书还能救吗'), '切回后旧档案的内容仍在')

step('6c. 新开会话 = 给这个人物另起一条档案线')
const countArchives = async () => ((await call('xingye_archive', { action: 'list' })).match(/^- .*\[/gm) ?? []).length
const archBefore = await countArchives()
const agent2 = { session: { id: 'session-verify-2', header: { cwd: process.cwd() } } }
emit('agent/session-start', { agent: agent2, source: { kind: 'new' } })
execCtx = { agent: agent2 }
const st2 = stateText()
assert(st2.includes('林砚'), '新会话继承了当前人物')
assert(st2.includes('尚未建立'), '新会话没有沿用上一个会话的档案')
emit('session/event', agent2.session, userMsg('换个晚上再聊'))
emit('session/event', agent2.session, asstMsg('好。'))
const archAfter = await countArchives()
assert(archAfter === archBefore + 1, `新会话自动开了一条新档案（${archBefore} → ${archAfter}）`)
execCtx = { agent }
assert((await call('xingye_history', { limit: 50 })).includes('这本书还能救吗'), '原会话的档案没有被新会话污染')
const boundArchive = JSON.parse(fs.readFileSync(path.join(dataRoot, 'sessions.json'), 'utf8'))
assert(Object.keys(boundArchive).length >= 2, '两个会话各自留下了绑定记录')
// ── 7. 用户人设 ────────────────────────────────────────────────────────────
step('7. 用户给自己准备多套人设并切换')
log.push(await call('xingye_user_persona', { action: 'create', name: '旅人', persona_text: '旅人，在路上走了很久，习惯在深夜找人说话。' }))
log.push(await call('xingye_user_persona', { action: 'create', name: '同事小林', persona_file: (() => { const f = path.join(dataRoot, '小林.txt'); fs.writeFileSync(f, '小林，同部门同事，公事公办，说话直接。', 'utf8'); return f })() }))
log.push(await call('xingye_user_persona', { action: 'list' }))
log.push(await call('xingye_user_persona_switch', { name: '同事小林' }))
const state2 = stateText()
assert(state2.includes('同事小林'), '用户人设已进入提示词')
assert(state2.includes('公事公办'), '用户人设正文被注入')

emit('session/event', agent.session, userMsg('明天的会改到几点？'))
const hist2 = await call('xingye_history', { limit: 4 })
assert(hist2.includes('同事小林：明天的会改到几点？'), '用户消息按新用户人设署名')

log.push(await call('xingye_user_persona_switch', { name: '' }))
assert(stateText().includes('未设置'), '可以取消用户人设')

// ── 8. 撤销 30 条 ─────────────────────────────────────────────────────────
step('8. 撤销最近 30 条对话')
// 再灌 60 条，凑够撤销量
for (let i = 1; i <= 30; i++) {
  emit('session/event', agent.session, userMsg(`第 ${i} 句`))
  emit('session/event', agent.session, asstMsg(`答 ${i}`))
}
const beforeUndo = await call('xingye_history', { limit: 200 })
const beforeCount = (beforeUndo.match(/^\[/gm) ?? []).length
const undoOut = await call('xingye_undo', { count: 30 })
log.push(undoOut.slice(0, 400))
assert(undoOut.includes('已撤销最近 30 条'), '撤销了 30 条')
const afterUndo = await call('xingye_history', { limit: 200 })
const afterCount = (afterUndo.match(/^\[/gm) ?? []).length
assert(beforeCount - afterCount === 30, `撤销前后条数差刚好 30（${beforeCount} → ${afterCount}）`)

step('8b. 超过 30 的请求被夹到上限')
const capped = await call('xingye_undo', { count: 999 })
assert(capped.includes('上限 30 条') && capped.includes('已撤销最近 30 条'), 'count=999 被夹到 30')

step('8c. 撤销可恢复')
log.push(await call('xingye_restore', { count: 2 }))
const restored = await call('xingye_history', { limit: 200 })
assert((restored.match(/^\[/gm) ?? []).length === afterCount - 30 + 2, '恢复了 2 条')

step('8d. 事件簿：记下剧情节点、细节、偏好')
const evAdd1 = await call('xingye_eventbook', { action: 'add', kind: 'plot', title: '林砚答应修书', text: '用户把一本受潮的旧书交给林砚，林砚说「先看纸」。', tags: ['旧书', '第一次见面'] })
log.push(evAdd1)
const plotEventId = (evAdd1.match(/id：(ev_[A-Za-z0-9_]+)/) ?? [])[1]
assert(Boolean(plotEventId), '拿到事件 id：' + plotEventId)
log.push(await call('xingye_eventbook', { action: 'add', kind: 'preference', title: '用户喜欢夜里聊天', text: '用户提到自己习惯深夜说话，喜欢安静。', tags: ['习惯'] }))
const evList = await call('xingye_eventbook', { action: 'list' })
assert(evList.includes('林砚答应修书') && evList.includes('用户喜欢夜里聊天'), '两条事件都记下了')
assert(evList.includes('[剧情]') && evList.includes('[偏好]'), '类型标签正确')

step('8e. 事件簿进入提示词（前情提要）')
const stateWithRecap = stateText()
assert(stateWithRecap.includes('事件簿 · 前情提要'), '状态里出现前情提要小节')
assert(stateWithRecap.includes('林砚答应修书'), '剧情节点被注入上下文')

step('8e2. 记忆图片：未配置出图服务时退化为「只存提示词」，不报错')
const img = await call('xingye_memory_image', { action: 'generate', event_id: plotEventId, description: '林砚在灯下修书，手指沾着浆糊' })
assert(img.text.includes('还没有配置出图服务'), '未配置时明确告知用户')
assert(img.text.includes('插画风格'), '提示词带上了统一美术方向')
assert(img.text.includes('林砚答应修书'), '提示词引用了事件簿节点')
const gallery = await call('xingye_memory_image', { action: 'list' })
assert(gallery.includes('待出图'), '画廊里出现待出图条目')
assert(gallery.includes('对应节点 ' + plotEventId), '画廊条目挂到了剧情节点上')

step('8e3. 用户在对话里贴的图自动归档进画廊')
const imageMsg = {
  type: 'user/message',
  seq: 99,
  time: Date.now(),
  data: {
    id: 'm99',
    role: 'user',
    content: [{ type: 'text', text: '这是我拍的照片' }, { type: 'image', attachment: { attachmentId: 'att_user_1', mediaType: 'image/png', bytes: 1234, width: 800, height: 600 } }],
    source: { kind: 'user' },
  },
}
emit('session/event', agent.session, imageMsg)
const gallery2 = await call('xingye_memory_image', { action: 'list' })
assert(gallery2.includes('att_user_1') || gallery2.match(/张/) !== null, '用户贴图已进画廊索引')
assert((gallery2.match(/^- /gm) ?? []).length >= 2, '画廊现在至少两条')
step('8f. 撤销要连带作废对应的事件簿条目，恢复要连带回')
const countEvents = async () => ((await call('xingye_eventbook', { action: 'list' })).match(/^- \[/gm) ?? []).length
const beforeVoid = await countEvents()
log.push(await call('xingye_undo', { count: 2 }))
const afterVoid = await call('xingye_eventbook', { action: 'list' })
const afterVoidCount = (afterVoid.match(/^- \[/gm) ?? []).length
assert(afterVoidCount < beforeVoid, '撤销后有条目被标为作废（' + beforeVoid + ' -> ' + afterVoidCount + '）')
assert((await call('xingye_eventbook', { action: 'list', include_voided: true })).includes('已作废'), '作废条目仍在，只是被标记')
log.push(await call('xingye_restore', { count: 2 }))
assert(!(await call('xingye_eventbook', { action: 'list', include_voided: true })).includes('已作废'), '恢复后条目复活')

step('8g. 回溯到历史节点（改剧本）')
const beforeRewind = (await call('xingye_history', { limit: 500 })).match(/^\[/gm).length
const rw = await call('xingye_rewind', { to: 'last-user', reason: '想换个说法重来' })
log.push(rw.slice(0, 500))
assert(rw.includes('已回溯'), '回溯成功')
const afterRewind = (await call('xingye_history', { limit: 500 })).match(/^\[/gm).length
assert(afterRewind < beforeRewind, `回溯后条数减少了（${beforeRewind} → ${afterRewind}）`)
const branchId = (rw.match(/分支 (br_[A-Za-z0-9_]+)/) ?? [])[1]
assert(Boolean(branchId), `拿到了分支 id：${branchId}`)

step('8h. 分支可回看、可接回')
const brList = await call('xingye_branch', { action: 'list' })
assert(brList.includes(branchId), '分支出现在列表里')
const brShow = await call('xingye_branch', { action: 'show', id: branchId })
assert(brShow.includes('想换个说法重来'), '分支里记下了回溯原因')
log.push(await call('xingye_branch', { action: 'restore', id: branchId }))
const afterRestore = (await call('xingye_history', { limit: 500 })).match(/^\[/gm).length
assert(afterRestore === beforeRewind, `分支接回后条数复原（${afterRestore}）`)
assert(!(await call('xingye_eventbook', { action: 'list', include_voided: true })).includes('已作废'), '接回分支后事件簿也复活')

step('8i. 重启对话：清空但留下完整分支')
const restart = await call('xingye_rewind', { to: 'start', reason: '整段重演' })
assert(restart.includes('重启到最开始'), '识别 start')
assert((await call('xingye_history', { limit: 500 })).includes('还是空的'), '档案已清空')
assert((await call('xingye_branch', { action: 'list' })).includes('整段重演'), '整段剧情存成了分支')
step('8j. 角色形象：把文件放进角色目录即成')
const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const avatarSrc = path.join(dataRoot, 'me.png')
fs.writeFileSync(avatarSrc, pngBytes)
const setImg = await call('xingye_character_image', { action: 'set', kind: 'avatar', file: avatarSrc, character: '林砚' })
assert(setImg.includes('avatar'), '立绘已收进角色目录')
const imgList = await call('xingye_character_image', { action: 'list', character: '林砚' })
const avatarRow = imgList.split('\n').find((l) => l.startsWith('- 立绘 avatar'))
assert(Boolean(avatarRow) && !avatarRow.includes('（无）'), '形象图列表认到了立绘：' + (avatarRow ?? '').trim())
const bgRow = imgList.split('\n').find((l) => l.startsWith('- 背景 background'))
assert(Boolean(bgRow) && bgRow.includes('（无）'), '背景还没放，如实报（无）')
step('8k. 前端数据出口：ui-state.json 要写出人物、形象与档案')
const uiFile = path.join(dataRoot, 'ui-state.json')
assert(fs.existsSync(uiFile), 'ui-state.json 已生成')
const ui = JSON.parse(fs.readFileSync(uiFile, 'utf8'))
const lin = Object.values(ui.characters).find((c) => c.name === '林砚')
assert(Boolean(lin), '林砚出现在 ui-state 里')
assert(lin.archives.length >= 2, '林砚的两个档案都在（' + lin.archives.length + ' 个）')
assert(typeof lin.persona === 'string' && lin.persona.includes('古籍修复师'), '人设正文随快照带出')
assert(typeof lin.images.portrait === 'string' && lin.images.portrait.startsWith('data:image/png;base64,'), '立绘被内嵌成 data URL')
assert(Object.keys(ui.sessions).length >= 2, '会话绑定一并带出（' + Object.keys(ui.sessions).length + ' 条）')
const linArchive = lin.archives.find((a) => a.events.length > 0) || lin.archives[0]
assert(Array.isArray(linArchive.events), '档案里带出了事件簿数组')
assert(linArchive.events.some((e) => e.kind && e.title), '事件簿条目有 kind 与 title（面板要用）')
assert(Array.isArray(linArchive.branches), '档案里带出了分支数组')
assert(Array.isArray(lin.gallery), '人物带出了画廊数组')
assert(typeof lin.images.portraitPath === 'string' && lin.images.portraitPath.includes('portrait.png'), '立绘路径提示已带出')
// ── 9. 定期清理 ───────────────────────────────────────────────────────────
step('9. 定期清理（原文滚动成梗概）')
fs.writeFileSync(path.join(dataRoot, 'config.json'), JSON.stringify({ undoWindow: 30, maxVerbatimMessages: 40, retentionDays: 0, pruneOnWrite: false }))
for (let i = 1; i <= 45; i++) {
  emit('session/event', agent.session, userMsg(`补第 ${i} 句`))
  emit('session/event', agent.session, asstMsg(`补答 ${i}`))
}
const countMsgs = async () => ((await call('xingye_history', { limit: 500 })).match(/^\[/gm) ?? []).length
const beforePrune = await countMsgs()
assert(beforePrune > 40, `清理前有 ${beforePrune} 条原文（超过上限 40）`)
log.push(await call('xingye_prune'))
const pruned = await call('xingye_history', { limit: 500 })
assert((pruned.match(/^\[/gm) ?? []).length === 40, '清理后原文恰好剩 40 条（可回溯窗口）')
assert(pruned.includes('已被定期清理，仅存梗概'), '梗概出现在回溯里')

// ── 10. 状态总览与存储统计 ────────────────────────────────────────────────
step('10. 状态总览')
log.push(await call('xingye_status'))

step('10b. 删除人物')
log.push(await call('xingye_character', { action: 'delete', name: '小满' }))
const listed = await call('xingye_character', { action: 'list' })
assert(!listed.includes('小满'), '小满已被删除')

log.push(`\n数据目录：${dataRoot}`)
fs.rmSync(dataRoot, { recursive: true, force: true })
console.log(log.join('\n'))
console.log(process.exitCode ? '\n❌ 有断言失败' : '\n✅ 全部通过')

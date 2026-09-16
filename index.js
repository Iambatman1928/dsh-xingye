/**
 * 星野 · Host 半
 *
 * 职责三件事：
 *   1. 把界面要的数据端出去：读 <dataRoot>/ui-state.json（由 agent preset `xingye`
 *      里的插件写），经 /xingye/api/state 交给浏览器。
 *   2. 把界面上的动作真的做掉：/xingye/api/prompt 把一条指令送进当前 星野 会话 ——
 *      于是「+」菜单和创建表单不是文案，是点一下就发生的事。
 *   3. 把随包发行的 agent preset `xingye` 落到 `<DSH_HOME>/.agent-presets/xingye/`，
 *      让 `dsh plugin add dsh-xingye` 一条命令就把「聊天 agent」装齐。
 *
 * 为什么界面要有这个 Host 半：浏览器读不了本地文件，也拿不到会话；
 * 而常驻插件跑在 DSH 的 Node 进程里，两样都有。
 *
 * 关于第 3 件事：agent preset 只靠文件系统被发现，DSH 没有任何插件注册接口，
 * 所以包只能自己把 preset 写到盘上。这次写入是**只在目标缺失时发生**的一次复制，
 * 绝不会覆盖用户已经改过的 preset；它做了什么会明确写进日志。
 * `config.installPreset: false` 可以完全关掉它，`config.updatePreset: true` 才会覆盖。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const name = 'xingye-ui'
const inject = ['webServer']

/** 随包发行的 agent preset id —— 目录名就是 preset id。 */
const PRESET_ID = 'xingye'

/**
 * DSH 家目录：`$DSH_HOME`，未设置时退回 `~/.dsh`。
 *
 * 与 `@deepseek-ai/dsh-home-paths` 的解析规则一致。这里不 import 它：常驻插件装进
 * profile 的 node_modules，而那个包只保证在 harness 自己的解析链上 ——
 * 三行内联实现比一个可能解析不到的依赖稳。
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

/** 默认数据根：`<DSH_HOME>/xingye-data`。行配置 `config.dataRoot` 可覆盖。 */
const DEFAULT_DATA_ROOT = path.join(dshHome(), 'xingye-data')

/** 随包发行的 preset 目录（本包根下的 `preset/`）。 */
const BUNDLED_PRESET_DIR = fileURLToPath(new URL('./preset/', import.meta.url))

/**
 * 请求体上限。
 *
 * 12 MB 不是随手写的：界面上的「上传头像」把图片读成 data URL 再 POST 过来，
 * base64 会把原始体积撑大 4/3 —— 12 MB 的体量对应约 9 MB 的原图，
 * 盖得住手机拍的照片，又不至于让一个本地接口成为内存风险。
 */
const MAX_BODY = 12 * 1024 * 1024

/** 暂存目录里图片的保留时长；界面上传的图是一次性的，星野收进角色目录后就该清掉。 */
const STAGING_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 常驻客户端模块本体。用它做「页面里跑的到底是不是这一份」的比对。 */
const clientFile = fileURLToPath(new URL('./client.js', import.meta.url))

/**
 * 磁盘上 client.js 声明的界面版本。
 *
 * 每次调用都现读：改完 client.js 不用重启 Host，下一次界面问 state 就能看出
 * 页面是不是还跑着旧代码。常驻客户端模块的响应头是
 * `Cache-Control: immutable, max-age=1y`，旧页面能一直跑几小时前的代码，
 * 而表现只是「改了没反应」—— 有这一比对，就不必再猜。
 */
function readClientVersion() {
  try {
    const match = /var UI_VERSION = '([^']+)'/.exec(fs.readFileSync(clientFile, 'utf8'))
    return match ? match[1] : 'unknown'
  } catch {
    return 'missing'
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value })
}

function writeError(res, error) {
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 200, { ok: false, error: { code: 'internal', message } })
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

/**
 * 给服务调用配一个真的 AbortSignal。
 *
 * `sessionController` 的方法会直接调 `signal.throwIfAborted()`，
 * 不传就是 `Cannot read properties of undefined (reading 'throwIfAborted')`。
 * Remote 路径由网关补 signal，**Host 直接调服务不会** —— 这个坑由 lawagent-ui 实测记录，这里照抄。
 */
function withSignal(run, timeoutMs = 60000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return Promise.resolve()
    .then(() => run(controller.signal))
    .finally(() => clearTimeout(timer))
}

/**
 * 把随包发行的 agent preset 复制到 `<DSH_HOME>/.agent-presets/<id>/`。
 *
 * 为什么需要这一步：DSH 的 agent preset 是靠**文件系统发现**的
 * （`dsh-agent-presets` 每次读名册都重新扫 preset 根目录），没有任何插件注册接口，
 * 所以一个 profile 插件没法"声明"一个 preset —— 只能把文件放到位。
 * 好消息是那份实现每次调用都重读根目录，于是这里复制完无需重启就能被看见。
 *
 * 行为边界（刻意的）：
 *   * 目标已存在且 `update` 为假 → 一个字节都不动，只回报 `skipped`；
 *   * 只有 `agent.cordis.yml` 缺失（用户删过、或从未装过）才写；
 *   * 只复制这一棵子树的文件，不递归删任何东西。
 *
 * @param options - `{ update }`：是否覆盖已存在的 preset。
 * @returns 一份可展示、可放进 API 返回值的结果报告。
 */
function installPreset({ update = false } = {}) {
  const dest = path.join(dshHome(), '.agent-presets', PRESET_ID)
  const marker = path.join(dest, 'agent.cordis.yml')

  if (fs.existsSync(marker) && !update) {
    return { action: 'skipped', reason: 'already-installed', presetDir: dest }
  }

  const written = []
  const walk = (from, to) => {
    fs.mkdirSync(to, { recursive: true })
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name)
      const out = path.join(to, entry.name)
      if (entry.isDirectory()) {
        walk(src, out)
      } else if (entry.isFile()) {
        fs.copyFileSync(src, out)
        written.push(path.relative(dest, out).split(path.sep).join('/'))
      }
    }
  }

  try {
    walk(BUNDLED_PRESET_DIR, dest)
  } catch (error) {
    // 写不进去（权限、只读盘）不该拖垮插件其余部分：界面仍能用，只是 preset 得手装
    return {
      action: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      presetDir: dest,
      hint: `手动把本包的 preset/ 目录复制到 ${dest}`,
    }
  }

  return { action: fs.existsSync(marker) ? (update ? 'updated' : 'installed') : 'installed', presetDir: dest, files: written }
}

function apply(ctx, config) {
  const webServer = ctx.webServer
  if (!webServer) {
    console.log('[xingye] webServer 不可用，插件未激活')
    return
  }

  const dataRoot = config?.dataRoot ?? DEFAULT_DATA_ROOT
  const stateFile = path.join(dataRoot, 'ui-state.json')

  // ── 让 `dsh plugin add dsh-xingye` 一条命令装齐：缺 preset 就补上 ──────────
  let presetReport = { action: 'disabled', presetDir: path.join(dshHome(), '.agent-presets', PRESET_ID) }
  if (config?.installPreset !== false) {
    presetReport = installPreset({ update: config?.updatePreset === true })
    if (presetReport.action === 'installed' || presetReport.action === 'updated') {
      console.log(
        `[xingye] 已${presetReport.action === 'updated' ? '更新' : '安装'} agent preset「${PRESET_ID}」→ ${presetReport.presetDir}。\n` +
          '         在 DSH 里新开一个会话、agent preset 选「星野」即可开始聊天。',
      )
    } else if (presetReport.action === 'failed') {
      console.error(`[xingye] 写入 agent preset 失败：${presetReport.reason}。${presetReport.hint}`)
    }
  }

  /** 读界面快照。由 preset 里的 星野 插件负责写（会话开始 + 每次工具调用后）。 */
  const readState = async () => {
    let raw
    try {
      raw = fs.readFileSync(stateFile, 'utf8')
    } catch (error) {
      throw new Error(
        `读不到 ${stateFile}（${error.code ?? 'unknown'}）。` +
          '它由 preset「星野」里的插件在会话开始时生成 —— 先用星野 preset 开一个会话。',
      )
    }
    const snapshot = JSON.parse(raw)
    let mtimeMs = null
    try {
      mtimeMs = fs.statSync(stateFile).mtimeMs
    } catch {
      /* 刚被删掉之类，忽略 */
    }
    return { ...snapshot, mtimeMs, nowMs: Date.now() }
  }

  /**
   * 把一条文本指令送进会话。
   *
   * 这是界面所有动作的落点：创建角色、回溯、重启、看事件簿……
   * 都由 星野 用她自己的工具执行 —— 界面不重复实现业务逻辑，只有一份真相。
   */
  const prompt = async ({ sessionId, text }) => {
    const controller = ctx.get('sessionController')
    if (!controller) throw new Error('sessionController 服务不可用')
    const body = String(text ?? '').trim()
    if (!body) throw new Error('指令内容为空')
    if (!sessionId) throw new Error('不知道要发给哪个会话（界面没拿到 sessionId）')
    await withSignal((signal) =>
      controller.prompt(
        {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: body }],
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        signal,
      ),
    )
    return { sessionId, chars: body.length }
  }

  const api = {
    /**
     * 界面快照 + 版本比对。
     *
     * 界面每次问 state 都带上自己那一份 UI_VERSION（`?v=`），这里和磁盘上的比：
     * 不一致就是「页面跑着旧代码」—— 写一行日志说清楚，并把磁盘版本放进返回值，
     * 界面据此在页面上直接提示用户刷新，而不是让用户面对一个「改了没反应」的黑盒。
     */
    state: async (_payload, params) => {
      const disk = readClientVersion()
      const page = params?.get('v') ?? null
      if (page !== null && page !== disk) {
        console.log(
          `[xingye] 页面上的界面代码是旧的：页面 v${page} / 磁盘 v${disk} ——` +
            ' 需要重新加载页面（Ctrl+Shift+R）才会生效。',
        )
      }
      const snapshot = await readState()
      return { ...snapshot, clientVersion: disk, pageVersion: page }
    },
    /**
     * 浏览器回传的现场诊断。
     *
     * 为什么要这条通道：界面出问题时我看不到用户屏幕，靠猜会一轮轮空转。
     * 现在两种东西都落这里：崩溃（crash，含 message 与 stack）和样式现场
     * （body::before 到底画了什么、token 解析成了什么值、中心点上压着哪些元素）。
     */
    diag: async (payload) => {
      const file = path.join(dataRoot, 'ui-diag.json')
      let list = []
      try { list = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { list = [] }
      if (!Array.isArray(list)) list = []
      list.unshift({ receivedAt: new Date().toISOString(), payload })
      // 崩溃记录单独留一份完整的历史，不被样式诊断挤掉
      if (payload && payload.crash) {
        const crashFile = path.join(dataRoot, 'ui-crash.json')
        let crashes = []
        try { crashes = JSON.parse(fs.readFileSync(crashFile, 'utf8')) } catch { crashes = [] }
        if (!Array.isArray(crashes)) crashes = []
        crashes.unshift({ receivedAt: new Date().toISOString(), ...payload.crash })
        fs.writeFileSync(crashFile, JSON.stringify(crashes.slice(0, 20), null, 2) + '\n', 'utf8')
        console.log(`[xingye] 客户端崩溃回报：${payload.crash.kind} · ${payload.crash.message}`)
      }
      fs.writeFileSync(file, JSON.stringify(list.slice(0, 5), null, 2) + '\n', 'utf8')
      return { written: file, entries: Math.min(list.length, 5) }
    },
    prompt,
    /**
     * 把界面里选的图片落到磁盘，返回**路径**。
     *
     * 为什么需要这条：浏览器里的 `<input type="file">` 只能拿到 data URL，
     * 而星野 的 `xingye_character_image` 收的是本地路径。JSON 通道只走无损 JSON，
     * data URL 是字符串、合法，于是"浏览器选图 → 本地成文件"这条路就通了。
     *
     * 落在 `_staging/`（不是角色目录）：新建人物时角色还不存在，没有目录可写。
     * 暂存路径随指令一起交给星野，由她收进角色的 portrait / avatar 槽位。
     */
    upload: async (payload) => {
      const dataUrl = String(payload?.dataUrl ?? '')
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl)
      if (!match) throw new Error('只接受 png / jpeg / webp / gif 的 base64 data URL')
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[match[1]]
      const bytes = Buffer.from(match[2], 'base64')
      if (bytes.length === 0) throw new Error('图片内容为空')
      // 认一下字节头：扩展名与真实格式不符的图（用户那边真实发生过）会让浏览器认不出来
      const eb = bytes
      const sniffed =
        eb.length > 8 && eb[0] === 0x89 && eb[1] === 0x50 && eb[2] === 0x4e && eb[3] === 0x47
          ? 'png'
          : eb.length > 3 && eb[0] === 0xff && eb[1] === 0xd8 && eb[2] === 0xff
            ? 'jpg'
            : eb.subarray(0, 4).toString('ascii') === 'RIFF' && eb.subarray(8, 12).toString('ascii') === 'WEBP'
              ? 'webp'
              : eb.subarray(0, 3).toString('ascii') === 'GIF'
                ? 'gif'
                : null
      const dir = path.join(dataRoot, '_staging')
      fs.mkdirSync(dir, { recursive: true })
      const kind = /^(avatar|portrait|background)$/.test(String(payload?.kind ?? '')) ? String(payload.kind) : 'avatar'
      const file = path.join(dir, `${kind}_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}.${sniffed ?? ext}`)
      fs.writeFileSync(file, bytes)
      // 顺手清掉过期的暂存图，别让这个目录无限长大
      try {
        const now = Date.now()
        for (const entry of fs.readdirSync(dir)) {
          const target = path.join(dir, entry)
          const stat = fs.statSync(target)
          if (now - stat.mtimeMs > STAGING_TTL_MS) fs.rmSync(target, { force: true })
        }
      } catch {
        /* 清理失败不是错误 */
      }
      return { path: file, bytes: bytes.length, sniffed: sniffed ?? ext }
    },
    /** 界面自检用：不依赖 ui-state.json，只报路径与可读性 */
    ping: async () => ({
      dataRoot,
      stateFile,
      exists: fs.existsSync(stateFile),
      uploads: fs.existsSync(path.join(dataRoot, '_staging')),
      preset: presetReport,
    }),
    /**
     * 重新把随包发行的 agent preset 写到盘上。
     *
     * 用途是「修」而不是「装」：用户把 preset 目录删了、或者升级插件后想同步到新版 preset
     * 时，在界面上点一下即可，不必去找包目录手工复制。
     * `reload` 复读一次：DSH 每次读名册都重新扫 preset 根目录，所以写完立刻可见。
     */
    preset: async (payload) => ({
      ...installPreset({ update: payload?.update === true }),
      presetId: PRESET_ID,
      presetDir: path.join(dshHome(), '.agent-presets', PRESET_ID),
    }),
  }

  ctx.effect(
    () =>
      webServer.register({
        kind: 'prefix',
        path: '/xingye/api',
        handler: async (req, res) => {
          if (req.headers['sec-fetch-site'] === 'cross-site') {
            writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'cross-site blocked' } })
            return
          }
          const url = new URL(req.url || '/', 'http://dsh.internal')
          const pathname = url.pathname
          const method = pathname.startsWith('/xingye/api/') ? pathname.slice('/xingye/api/'.length) : ''
          if (!method || method.includes('/')) {
            writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown method' } })
            return
          }
          const handler = api[method]
          if (!handler) {
            writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown method ${method}` } })
            return
          }
          try {
            writeOk(res, await handler(await readJsonBody(req), url.searchParams))
          } catch (error) {
            writeError(res, error)
          }
        },
      }),
    'xingye: /xingye/api routes',
  )

  console.log(`[xingye] 星野界面已挂载。数据目录：${dataRoot}`)
}

export { name, inject, apply }
export const internals = { DEFAULT_DATA_ROOT, dshHome, installPreset, PRESET_ID }

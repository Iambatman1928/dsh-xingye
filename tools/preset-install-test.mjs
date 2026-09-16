/**
 * 随包 preset 的落盘测试（Host 半新增的那部分）。
 *
 * 为什么值得单独测：`dsh plugin add dsh-xingye` 一条命令就该把「聊天 agent」装齐，
 * 靠的是 Host 半在首次加载时把 `preset/` 复制到 `<DSH_HOME>/.agent-presets/xingye/`。
 * 这段逻辑有几个**只能靠断言守住**的边界：
 *
 *   · 只在目标缺失时才写 —— 用户改过的 preset 一个字节都不能动；
 *   · `updatePreset: true` 才允许覆盖；
 *   · 目标已存在时回报 `skipped`，而不是悄悄跳过；
 *   · 复制出来的是完整的 preset（composition + preset.yml + plugin/ 全在），
 *     少了任何一个文件，用户从界面里看到的「星野」都挂不起来。
 *
 * 全程在临时目录里跑，不碰真实的 `~/.dsh`。
 *
 * 用法：node tools/preset-install-test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const results = []
let failures = 0
function check(label, ok, detail = '') {
  results.push({ label, ok })
  if (!ok) failures += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** 一个假的 DSH 家目录；`apply()` 与 `internals` 都从 `$DSH_HOME` 解析。 */
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'xingye-preset-'))
process.env.DSH_HOME = fakeHome

console.log(`\n=== dsh-xingye · 随包 preset 落盘测试 ===\n仓库：${repoRoot}\n假 DSH_HOME：${fakeHome}\n`)

// 必须在设置 DSH_HOME 之后 import —— 模块顶层就把 DEFAULT_DATA_ROOT 算出来了
const { internals } = await import(new URL('../index.js', import.meta.url).href)
const { DEFAULT_DATA_ROOT, installPreset, PRESET_ID, dshHome } = internals

check('preset id 是 xingye', PRESET_ID === 'xingye', PRESET_ID)
check('dshHome() 认 $DSH_HOME', dshHome() === path.resolve(fakeHome), dshHome())
check(
  '默认数据根是从 $DSH_HOME 推导出来的（不是字面量）',
  DEFAULT_DATA_ROOT.startsWith(dshHome()),
  DEFAULT_DATA_ROOT,
)
// 真正要守的是**源码里没有写死的机器路径** —— 断言值本身容易被临时目录里的
// `C:\Users\...` 误伤，所以直接查源码。
const indexSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
const hardcoded = /['"`][A-Za-z]:[\\/][^'"`]*(编程|Users\/admin|Users\\\\admin)[^'"`]*['"`]/.exec(indexSource)
check('index.js 源码里没有写死的本机绝对路径', hardcoded === null, hardcoded ? hardcoded[0] : '')

// ── 首次落盘 ────────────────────────────────────────────────────────────────
const dest = path.join(fakeHome, '.agent-presets', PRESET_ID)
const first = installPreset()
check('首次调用回报 installed', first.action === 'installed', JSON.stringify(first.action))
check('落到 <DSH_HOME>/.agent-presets/xingye', first.presetDir === dest, first.presetDir)

const expectFiles = [
  'agent.cordis.yml',
  'preset.yml',
  'plugin/index.js',
  'plugin/tools.js',
  'plugin/store.js',
  'plugin/image.js',
  'plugin/ui-state.js',
]
for (const rel of expectFiles) {
  check(`复制出了 ${rel}`, fs.existsSync(path.join(dest, rel)))
}

const copiedComposition = fs.readFileSync(path.join(dest, 'agent.cordis.yml'), 'utf8')
check('composition 里不再有写死的数据根', !copiedComposition.includes('dataRoot: \'E:'), '')
check(
  'composition 仍用相对路径引用插件（整个 preset 目录可整体搬走）',
  copiedComposition.includes("name: './plugin/index.js'"),
)

const copiedPresetYml = fs.readFileSync(path.join(dest, 'preset.yml'), 'utf8')
check('preset.yml 带上了显示名「星野」', copiedPresetYml.includes('星野'))

// ── 幂等：不许覆盖用户改过的东西 ────────────────────────────────────────────
const userEdit = path.join(dest, 'preset.yml')
fs.writeFileSync(userEdit, '# 用户自己改过的\nname: 我的星野\n', 'utf8')

const second = installPreset()
check('第二次调用回报 skipped', second.action === 'skipped', JSON.stringify(second.action))
check('skipped 带原因 already-installed', second.reason === 'already-installed', String(second.reason))
check(
  '用户改过的 preset 一个字节都没动',
  fs.readFileSync(userEdit, 'utf8') === '# 用户自己改过的\nname: 我的星野\n',
)

// ── updatePreset 才允许覆盖 ─────────────────────────────────────────────────
const third = installPreset({ update: true })
check('update: true 时回报 updated', third.action === 'updated', JSON.stringify(third.action))
check(
  'update: true 才把 preset.yml 恢复成随包版本',
  fs.readFileSync(userEdit, 'utf8').includes('星野'),
)
check('回报里带上了写入清单', Array.isArray(third.files) && third.files.length >= 7, `${third.files?.length} 个文件`)

// ── 目标目录只剩一个残缺 composition 时也要能自愈 ───────────────────────────
fs.rmSync(path.join(dest, 'agent.cordis.yml'), { force: true })
const fourth = installPreset()
check('composition 缺失时重新补上（不会被 skip 逻辑卡住）', fourth.action !== 'skipped', JSON.stringify(fourth.action))
check('补上之后 composition 又在了', fs.existsSync(path.join(dest, 'agent.cordis.yml')))

// ── 清理 ────────────────────────────────────────────────────────────────────
fs.rmSync(fakeHome, { recursive: true, force: true })

console.log(
  failures === 0
    ? `\n全部通过（共 ${results.length} 项）\n`
    : `\n${failures} 项失败（共 ${results.length} 项）\n`,
)
process.exit(failures === 0 ? 0 : 1)

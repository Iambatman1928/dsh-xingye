/**
 * 星野界面（dsh-xingye）Host 半 · 路由离线测试
 *
 * 为什么需要：界面上「上传头像」这条链路是
 *   浏览器选图 → data URL → POST /xingye/api/upload → 本地暂存文件 → 路径交给 星野
 * 它跨了三个进程边界（浏览器 / Host 半 / preset 插件），而这中间**没有编译期检查** ——
 * 路由名写错、base64 解析写错、扩展名与真实格式不符，症状都只是"点了没反应"。
 * 所以这里直接把 Host 半装起来，用假的 req/res 真跑一遍。
 *
 * 覆盖面：
 *   · 路由真的挂在 /xingye/api 前缀上（不是别的前缀）
 *   · upload 把 data URL 落成文件，且扩展名按**字节头**判定（用户给过扩展名是错的图）
 *   · 非图片 data URL 被拒；空内容被拒
 *   · 未知方法 404、跨站请求 403
 *   · ping 报的路径与真实 dataRoot 一致
 *
 * 用法：node tools/ui-host-route-test.mjs [插件目录]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginDir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))

const results = []
let failures = 0
function check(label, ok, detail = '') {
	results.push({ label, ok })
	if (!ok) failures += 1
	console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
}

/** 一个够用的假 req：异步可迭代的 body + headers + url。 */
function makeReq({ url = '/', method = 'POST', body = null, headers = {} } = {}) {
	const chunks = body === null ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
	return {
		url,
		method,
		headers: Object.assign({ host: '127.0.0.1:3080' }, headers),
		async *[Symbol.asyncIterator]() {
			for (const c of chunks) yield c
		},
	}
}

function makeRes() {
	const res = {
		status: null,
		headers: null,
		body: '',
		writeHead(status, headers) { res.status = status; res.headers = headers },
		end(chunk) { if (chunk !== undefined) res.body += String(chunk) },
	}
	return res
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xingye-host-test-'))

/** 1×1 的 PNG（真字节头，用来验"按字节认格式"而不是按扩展名）。 */
const PNG_1PX = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
	'base64',
)
const WEBP_1PX = Buffer.concat([
	Buffer.from('RIFF', 'ascii'),
	Buffer.from([0x24, 0x00, 0x00, 0x00]),
	Buffer.from('WEBP', 'ascii'),
	Buffer.from('VP8 ', 'ascii'),
	Buffer.alloc(32),
])

async function main() {
	console.log(`\n=== dsh-xingye Host 半路由测试 ===\n插件：${pluginDir}\n数据根：${tmpRoot}\n`)

	const mod = await import(pathToFileURL(path.join(pluginDir, 'index.js')).href)
	check('index.js 可被 import', typeof mod.apply === 'function')
	check('inject 只硬依赖 webServer', Array.isArray(mod.inject) && mod.inject.length === 1 && mod.inject[0] === 'webServer', JSON.stringify(mod.inject))

	// 装起来：把注册的路由抓下来
	let route = null
	const effects = []
	const ctx = {
		webServer: {
			register(spec) {
				route = spec
				return () => {}
			},
		},
		effect(factory, label) { effects.push(label); factory() },
		get() { return undefined },
	}

	try {
		mod.apply(ctx, { dataRoot: tmpRoot })
		check('apply() 执行成功', true, `effect: ${effects.join(' / ')}`)
	} catch (error) {
		check('apply() 执行成功', false, error?.message ?? String(error))
		return finish()
	}

	check('注册的是 prefix 路由', route && route.kind === 'prefix', String(route?.kind))
	check('路由挂在 /xingye/api 前缀上', route && route.path === '/xingye/api', String(route?.path))
	if (!route) return finish()

	const call = async (method, payload, { headers = {}, rawUrl } = {}) => {
		const res = makeRes()
		const req = makeReq({
			url: rawUrl ?? `/xingye/api/${method}`,
			body: payload,
			headers,
		})
		await route.handler(req, res)
		let parsed = null
		try { parsed = JSON.parse(res.body) } catch { /* 非 JSON 就留 null */ }
		return { status: res.status, body: parsed, raw: res.body }
	}

	// ── ping：路径必须与真实 dataRoot 一致 ─────────────────────────────────
	{
		const out = await call('ping', {})
		check('GET-ish ping 返回 ok', out.status === 200 && out.body?.ok === true, JSON.stringify(out.body)?.slice(0, 120))
		const v = out.body?.value ?? {}
		check('ping 报的 dataRoot 与行配置一致', v.dataRoot === tmpRoot, String(v.dataRoot))
		check('ping 报的 stateFile 在 dataRoot 下', String(v.stateFile).startsWith(tmpRoot), String(v.stateFile))
	}

	// ── upload：正常路径 ───────────────────────────────────────────────────
	let uploadedPath = null
	{
		const dataUrl = 'data:image/png;base64,' + PNG_1PX.toString('base64')
		const out = await call('upload', { dataUrl, kind: 'avatar' })
		check('upload 返回 ok', out.body?.ok === true, JSON.stringify(out.body).slice(0, 160))
		uploadedPath = out.body?.value?.path ?? null
		check('upload 返回了绝对路径', typeof uploadedPath === 'string' && path.isAbsolute(uploadedPath), String(uploadedPath))
		check('图片落在 _staging/ 下', typeof uploadedPath === 'string' && uploadedPath.includes(`${path.sep}_staging${path.sep}`), String(uploadedPath))
		check('文件真的写出来了，且字节数一致', uploadedPath !== null && fs.existsSync(uploadedPath) && fs.statSync(uploadedPath).size === PNG_1PX.length, uploadedPath ? `${fs.statSync(uploadedPath).size} 字节` : '(没有文件)')
		check('文件名带 kind 前缀（avatar_）', path.basename(String(uploadedPath)).startsWith('avatar_'), path.basename(String(uploadedPath)))
	}

	// ── upload：扩展名与真实格式不符时，按**字节头**判 ────────────────────────
	{
		// 伪装成 png 的 webp —— 用户那边真实发生过（zjz.png 其实是 RIFF/WEBP）
		const dataUrl = 'data:image/png;base64,' + WEBP_1PX.toString('base64')
		const out = await call('upload', { dataUrl, kind: 'background' })
		const p = out.body?.value?.path ?? ''
		check('扩展名按真实字节头判定（伪装成 png 的 webp 落成 .webp）', p.endsWith('.webp'), path.basename(p) || JSON.stringify(out.body).slice(0, 120))
		check('sniffed 字段回报了真实格式', out.body?.value?.sniffed === 'webp', String(out.body?.value?.sniffed))
	}

	// ── upload：拒绝非法输入 ───────────────────────────────────────────────
	{
		const bad = await call('upload', { dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' })
		check('非图片 data URL 被拒（而且不是 500）', bad.status === 200 && bad.body?.ok === false, JSON.stringify(bad.body).slice(0, 140))

		const empty = await call('upload', { dataUrl: 'data:image/png;base64,' })
		check('空图片被拒', empty.body?.ok === false, JSON.stringify(empty.body).slice(0, 140))

		const missing = await call('upload', {})
		check('缺 dataUrl 被拒', missing.body?.ok === false, JSON.stringify(missing.body).slice(0, 140))
	}

	// ── 其它路由行为 ───────────────────────────────────────────────────────
	{
		const unknown = await call('nope', {})
		check('未知方法返回 404', unknown.status === 404, JSON.stringify(unknown.body).slice(0, 120))

		const nested = await call('', {}, { rawUrl: '/xingye/api/a/b' })
		check('带斜杠的方法名返回 404（不做路径穿越）', nested.status === 404, JSON.stringify(nested.body).slice(0, 120))

		const cross = await call('ping', {}, { headers: { 'sec-fetch-site': 'cross-site' } })
		check('跨站请求被 403 挡住', cross.status === 403, JSON.stringify(cross.body).slice(0, 120))

		// webServer 只把 /xingye/api 前缀分发过来；就算别的前缀漏进来，handler 也必须拒绝
		const wrongPrefix = makeRes()
		await route.handler(makeReq({ url: '/other/api/ping', body: {} }), wrongPrefix)
		check('前缀之外的路径一律 404（不误伤别的插件路由）', wrongPrefix.status === 404, String(wrongPrefix.status))
	}

	// ── state：读不到 ui-state.json 时必须给**可操作的**错误 ────────────────
	{
		const out = await call('state', {})
		check('没有 ui-state.json 时 state 返回可读的错误', out.body?.ok === false && /ui-state\.json/.test(String(out.body?.error?.message)), String(out.body?.error?.message).slice(0, 160))
	}

	return finish()
}

function finish() {
	try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 清理失败无所谓 */ }
	console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}（共 ${results.length} 项）\n`)
	process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
	console.error('\n测试自身崩了：', error)
	try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
	process.exit(2)
})

/**
 * 星野界面（dsh-xingye）Client 半离线渲染测试 · 设计稿版
 *
 * 为什么需要它：这个模块是**常驻客户端模块**，跑在浏览器里。它一旦在工厂求值、
 * apply、组件渲染、或 **effect** 里抛错，现象只有两个 —— 页面上什么都没有、
 * Host 日志里一个字都没有。这不是假设，是真实发生过两次的故障：
 *
 *   1. 框架给每个座位包了一层 SlotErrorBoundary（见 dsh-client-ui-renderer 源码）
 *      —— 组件一抛错，该座位就被标成 abdicated **永久让位**，页面上只剩一个空 div，
 *      错误只出现在浏览器控制台。Inspect 里能看到 `active: false`。
 *   2. 真正的错因是 `sendDiag` 被调用却**从未定义**。它躺在 Stage 的 useEffect 里 ——
 *      而 renderToStaticMarkup **不执行 effect**，所以纯 SSR 测试看不到它。
 *
 * 所以这里跑三套：
 *   A. 真 React + react-dom/server：把所有页面与气泡的**渲染**过一遍（有数据 / 空数据）。
 *   B. 迷你 React 运行时：真的执行 **effect**，让「只在不跑 effect 的测试里看不见」
 *      这一类 bug 无处可藏；并验证 CrashBoundary 能接住子组件的渲染错误。
 *   C. 设计契约：色值 / 几何 / 断点必须真的在 CSS 里，markdown 必须真的产出元素。
 *
 * 用法：node tools/ui-client-render-test.mjs [插件目录] [react 所在 node_modules]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pluginDir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url))

/**
 * React 与 react-dom 必须来自**同一份安装**，否则 server renderer 认不出
 * 另一份 createElement 造出来的 element（报 "Objects are not valid as a React child"）。
 */
function resolveReactPair(explicit) {
	const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
	const profileRoot = path.join(dshHome, 'profiles')
	// 本机装过的 profile 各自带一份 node_modules，哪个先解析出成对的 react 就用哪个
	const profileCandidates = []
	try {
		for (const entry of fs.readdirSync(profileRoot)) {
			profileCandidates.push(path.join(profileRoot, entry, 'node_modules'))
		}
	} catch {
		/* 没有 profiles 目录就算了 */
	}
	const candidates = [
		explicit,
		process.env.DSH_NODE_MODULES,
		path.join(pluginDir, 'node_modules'),
		...profileCandidates,
		path.join(profileRoot, 'node_modules'),
		// 桌面客户端把 harness 解在自己的用户数据目录里 —— 那里才有一份完整的 node_modules。
		// 下面是几个公开的分发标识，不是本机专有路径。
		process.env.APPDATA
			? path.join(process.env.APPDATA, 'io.github.hairyf.deepseek-harness-desktop', 'dependencies', 'dsh', 'node_modules')
			: null,
		process.env.APPDATA ? path.join(process.env.APPDATA, 'deepseek-harness-desktop', 'dependencies', 'dsh', 'node_modules') : null,
		process.env.APPDATA ? path.join(process.env.APPDATA, 'dsh-desktop', 'dependencies', 'dsh', 'node_modules') : null,
		process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'dsh', 'node_modules') : null,
	].filter(Boolean)
	for (const root of candidates) {
		try {
			const req = createRequire(path.join(root, 'noop.js'))
			const reactDir = path.dirname(req.resolve('react/package.json'))
			const domDir = path.dirname(req.resolve('react-dom/package.json'))
			if (path.dirname(fs.realpathSync(reactDir)) !== path.dirname(fs.realpathSync(domDir))) continue
			return { root, require: req, React: req('react'), server: req('react-dom/server') }
		} catch {
			/* 换下一个候选 */
		}
	}
	return null
}

const results = []
let failures = 0
function check(label, ok, detail = '') {
	results.push({ label, ok })
	if (!ok) failures += 1
	console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
}

// ── 迷你 React 运行时：只为一件事存在 —— 让 effect 真的跑起来 ────────────────
//
// 语义与 React 对齐到够用为止：函数组件、类组件、错误边界
// （getDerivedStateFromError + componentDidCatch）、以及 effect 的收集与执行。
// 不做 re-render 与调和 —— 我们只需要「代码被执行到」。

function createMiniReact() {
	const effects = []
	let hooks = null
	let index = 0

	const React = {
		Fragment: Symbol.for('react.fragment'),
		Component: class Component {
			constructor(props) {
				this.props = props || {}
				this.state = {}
			}
			setState(next) {
				this.state = Object.assign({}, this.state, typeof next === 'function' ? next(this.state) : next)
			}
		},
		createElement(type, props) {
			const children = Array.prototype.slice.call(arguments, 2)
			// React 的约定：children 既在 props.children 里，也要能被子组件读到
			// （CrashBoundary 就是靠 this.props.children 转发子树的）。
			const merged = Object.assign({}, props || {})
			if (children.length > 0) merged.children = children.length === 1 ? children[0] : children
			return { $$el: true, type, props: merged }
		},
		useState(initial) {
			const i = index++
			if (hooks[i] === undefined) hooks[i] = { value: typeof initial === 'function' ? initial() : initial }
			const slot = hooks[i]
			if (!slot.set) slot.set = (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }
			return [slot.value, slot.set]
		},
		useEffect(fn) {
			effects.push(fn)
		},
		useMemo(fn) { return fn() },
		useCallback(fn) { return fn },
		useRef(value) { return { current: value } },
	}

	function renderNode(node) {
		if (node === null || node === undefined || typeof node === 'boolean') return
		if (Array.isArray(node)) { node.forEach(renderNode); return }
		if (typeof node === 'string' || typeof node === 'number') return
		if (typeof node !== 'object' || node.$$el !== true) return

		const { type, props } = node
		const inner = props && props.children !== undefined ? [].concat(props.children) : []
		if (typeof type === 'function') {
			const isClass = type.prototype && typeof type.prototype.render === 'function'
			if (isClass) { renderClass(type, props); return }
			const savedHooks = hooks
			const savedIndex = index
			hooks = []
			index = 0
			let out
			try {
				out = type(props)
			} finally {
				hooks = savedHooks
				index = savedIndex
			}
			renderNode(out)
			return
		}
		renderNode(inner)
	}

	function renderClass(Type, props) {
		const instance = new Type(props)
		const isBoundary =
			typeof Type.getDerivedStateFromError === 'function' || typeof instance.componentDidCatch === 'function'
		try {
			renderNode(instance.render())
		} catch (error) {
			if (!isBoundary) throw error
			const derived = typeof Type.getDerivedStateFromError === 'function' ? Type.getDerivedStateFromError(error) : null
			if (derived) instance.state = Object.assign({}, instance.state, derived)
			if (typeof instance.componentDidCatch === 'function') {
				instance.componentDidCatch(error, { componentStack: '(离线渲染测试)' })
			}
			renderNode(instance.render())
		}
	}

	return {
		React,
		render(node) { renderNode(node) },
		/** 执行收集到的 effect，返回其中抛出的错误（React 在真实环境里也是渲染之后才跑它们）。 */
		runEffects() {
			const errors = []
			for (const fn of effects.splice(0, effects.length)) {
				try {
					fn()
				} catch (error) {
					errors.push(error)
				}
			}
			return errors
		},
	}
}

// ── 夹具：一份完整的 ui-state（形状与 plugin/ui-state.js 写出的一致）─────────

const ARCHIVE = {
	id: '默认档案-2438_vx3l',
	title: '默认档案',
	messageCount: 12,
	updatedAt: '2026-09-16T07:50:29.774Z',
	eventCount: 2,
	tail: [
		{ speaker: '用户', text: '先生以为，天下何以至此？' },
		{ speaker: '张居正', text: '（搁下茶盏）病在纪纲不振。' },
	],
	events: [
		{ id: 'ev-1', kind: 'plot', title: '经筵初见', text: '万历元年，经筵之上第一次单独奏对。', voided: false },
		{ id: 'ev-2', kind: 'preference', title: '不喜甜食', text: '提到点心会皱眉。', voided: true },
	],
	branches: [{ id: 'br-1', messageCount: 4, reason: '退回改走另一条线' }],
}

const CHARACTER = {
	id: '张居正-4742_cuoa',
	name: '张居正',
	persona: '字叔大，号太岳。湖广江陵人，万历初年内阁首辅。\n神色端肃，说话简短，惯以「臣」自称。',
	tags: ['明代', '首辅', '权臣'],
	createdAt: '2026-09-15T15:47:43.006Z',
	updatedAt: '2026-09-16T07:50:29.774Z',
	images: {
		avatar: 'data:image/webp;base64,UklGRtgKA',
		portrait: 'data:image/webp;base64,UklGRtgKA',
		background: 'data:image/webp;base64,UklGRtgKA',
		portraitPath: '/data/xingye/characters/张居正-4742_cuoa/portrait.png',
		backgroundPath: '/data/xingye/characters/张居正-4742_cuoa/background.png',
	},
	archives: [ARCHIVE, { id: '档案-2-0908_ulqe', title: '档案 2', messageCount: 3, eventCount: 0, tail: [], events: [], branches: [] }],
	gallery: [{ id: 'img-1', caption: '经筵初见', data: 'data:image/webp;base64,UklGRtgKA' }],
}

const SESSION_ID = 'session-test-0001'

const STATE = {
	version: 1,
	dataRoot: '/data/xingye',
	clientVersion: null,
	characters: { [CHARACTER.id]: CHARACTER },
	userPersonas: [
		{ id: 'up-1', name: '朱翊钧（万历帝）', preview: '十岁登基的少年天子，对张先生既敬且畏。', text: '# 朱翊钧' },
		{ id: 'up-2', name: '同事小林', preview: '下班后只想躺平的普通人。', text: '# 小林' },
	],
	active: { activeCharacterId: CHARACTER.id, activeArchiveId: ARCHIVE.id, activeUserPersonaId: 'up-1' },
	sessions: {
		[SESSION_ID]: { characterId: CHARACTER.id, archiveId: ARCHIVE.id, userPersonaId: 'up-1', updatedAt: '2026-09-16T07:50:29.774Z' },
	},
}

const EMPTY_STATE = { version: 1, characters: {}, userPersonas: [], active: {}, sessions: {} }

/** 一座能在真 React 里渲染的气泡节点。 */
const USER_NODE = {
	data: {
		content: [{ type: 'text', text: '先生以为，天下何以至此？' }],
		time: '2026-09-16T07:50:15.592Z',
	},
}
const ASSISTANT_NODE = {
	data: {
		status: 'final',
		blocks: [
			{ kind: 'reasoning', text: '（这段不该出现在气泡里）' },
			{ kind: 'text', text: '病在**纪纲不振**。\n\n- 考成法\n- 清丈田亩\n\n```\n一条鞭法\n```' },
		],
	},
}

// ── 浏览器环境桩 ────────────────────────────────────────────────────────────

const styleWrites = []
const htmlWrites = []
const bodyWrites = []
const bodyAttrs = {}
const bodyClasses = new Set()
const rootAttrs = {}
const listeners = { added: [], removed: [] }

function fakeStyle(sink) {
	return {
		colorScheme: '',
		setProperty(name, value, priority) { sink.push([name, value, priority]); styleWrites.push([name, value, priority]) },
		removeProperty() {},
	}
}

function fakeClassList(store) {
	return {
		add: (c) => store.add(c),
		remove: (c) => store.delete(c),
		contains: (c) => store.has(c),
		toggle: (c) => (store.has(c) ? store.delete(c) : store.add(c)),
	}
}

function makeElement(tag) {
	const el = {
		tagName: String(tag || 'div').toUpperCase(),
		textContent: '',
		isConnected: true,
		style: fakeStyle([]),
		setAttribute() {},
		removeAttribute() {},
		appendChild() {},
		remove() {},
		click() {},
		querySelector: () => null,
		querySelectorAll: () => [],
	}
	el.classList = fakeClassList(new Set())
	return el
}

/** 记录所有 POST 的 body，便于断言客户端真的回报了东西。 */
const posted = []
const fetched = []
let servedState = STATE

function installBrowserStubs() {
	const bgStyleEl = makeElement('style')
	globalThis.__bgStyle = bgStyleEl
	globalThis.window = { __ModuleLoader__: { load(definition) { globalThis.__captured = definition } } }
	globalThis.document = {
		head: { appendChild() {} },
		body: {
			style: fakeStyle(bodyWrites),
			classList: fakeClassList(bodyClasses),
			setAttribute(name, value) { bodyAttrs[name] = value },
			removeAttribute(name) { delete bodyAttrs[name] },
			hasAttribute: (name) => Object.prototype.hasOwnProperty.call(bodyAttrs, name),
		},
		documentElement: {
			style: fakeStyle(htmlWrites),
			setAttribute(name, value) { rootAttrs[name] = value },
			removeAttribute(name) { delete rootAttrs[name] },
			hasAttribute: (name) => Object.prototype.hasOwnProperty.call(rootAttrs, name),
		},
		createElement(tag) { return tag === 'style' ? bgStyleEl : makeElement(tag) },
		addEventListener(type, fn) { listeners.added.push([type, fn]) },
		removeEventListener(type, fn) { listeners.removed.push([type, fn]) },
		querySelector() { return null },
		querySelectorAll() { return [] },
	}
	globalThis.getComputedStyle = () => ({
		position: '', zIndex: '', backgroundImage: '', backgroundColor: '', borderRadius: '',
		getPropertyValue: () => '',
	})
	globalThis.location = { href: 'http://127.0.0.1:3080/?t=test' }
	globalThis.innerWidth = 2560
	globalThis.innerHeight = 1348
	// Node 里 navigator 是只读访问器，只能这样盖
	Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'offline-test' }, configurable: true })
	// 常驻模块有真 setInterval（不是动态沙箱），换掉以免测试进程一直挂着。
	// 注意 **不要** 动 setTimeout：测试自己要用它来等 fetch 落地 —— 盖成空函数会让
	// 所有 await 永远不 resolve，进程静默退出、一条断言都不打（这个坑踩过一次）。
	globalThis.setInterval = () => 0
	globalThis.clearInterval = () => {}
	globalThis.fetch = (url, options) => {
		const target = String(url)
		fetched.push(target)
		if (options && options.body) posted.push({ url: target, body: JSON.parse(String(options.body)) })
		if (target.includes('/xingye/api/state')) {
			return Promise.resolve({ json: () => Promise.resolve({ ok: true, value: servedState }) })
		}
		return Promise.resolve({ json: () => Promise.resolve({ ok: true, value: { path: '/data/xingye/_staging/avatar_x.png' } }) })
	}
	return bgStyleEl
}

/** 造一个 apply 用的假 ctx，记录座位注册 **和 inject 的座位名**。 */
function makeClientCtx(registrations, effects, injects) {
	return {
		slots: {
			// 真实现的 inject(key, cb) 会拿 key 去 specDynamic(key) 查声明，查不到就**静默等待**、
			// 永不调用 cb。假实现必须把 key 记下来，否则「key 写错了」这一类故障在离线测试里
			// 完全看不见（真实事故：把 `conversation.chat.node:user` 这种「座位+key」复合串当成了 key）。
			inject(key, callback) {
				let result
				let failure = null
				try {
					result = callback()
				} catch (error) {
					failure = error
				}
				injects.push({ key, ok: failure === null, error: failure ? String(failure.message ?? failure) : null })
				if (failure) throw failure
				return typeof result === 'function' ? result : () => {}
			},
			register(spec, component) {
				registrations.push({ spec, component })
				return () => {}
			},
		},
		effect(factory, label) { effects.push({ label, dispose: factory() }) },
		get() { return undefined },
	}
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
	const pair = resolveReactPair(process.argv[3])
	console.log(`\n=== dsh-xingye Client 半离线渲染测试（设计稿版）===\n插件：${pluginDir}\nReact：${pair ? pair.root : '(未找到)'}\n`)

	installBrowserStubs()

	// 1. 模块包装与工厂求值
	try {
		await import(pathToFileURL(path.join(pluginDir, 'client.js')).href)
		check('client.js 可被模块加载器执行', globalThis.__captured !== null && globalThis.__captured !== undefined)
	} catch (error) {
		check('client.js 可被模块加载器执行', false, error?.message ?? String(error))
		return finish()
	}
	const captured = globalThis.__captured
	if (!captured) return finish()

	check('模块 id 正确', captured.id === 'dsh-xingye', String(captured.id))
	check('factory 是函数', typeof captured.factory === 'function')

	if (!pair) {
		check('取到同源的 React 与 react-dom/server', false, '没有找到 react 与 react-dom 同源的 node_modules')
		return finish()
	}
	const { require: req, React, server } = pair
	check(
		'取到同源的 React 与 react-dom/server',
		typeof React.createElement === 'function' && typeof server.renderToStaticMarkup === 'function',
		'react ' + req('react/package.json').version,
	)

	const requireStub = (name) => {
		if (name === 'react') return React
		throw new Error('未声明的外部模块：' + name)
	}

	let mod
	try {
		mod = captured.factory(requireStub)
		check('工厂求值成功（无顶层 ReferenceError）', true)
	} catch (error) {
		check('工厂求值成功（无顶层 ReferenceError）', false, error?.message ?? String(error))
		return finish()
	}

	check('模块导出 apply', typeof mod.apply === 'function')
	check('inject 只硬依赖 slots', Array.isArray(mod.inject) && mod.inject.length === 1 && mod.inject[0] === 'slots', JSON.stringify(mod.inject))
	check('暴露了测试接缝', !!mod.__test)

	// 2. apply：座位注册必须真的发生（mount 的 try/catch 会吞掉失败，只写 console）
	const registrations = []
	const effects = []
	const injects = []
	const consoleErrors = []
	const realError = console.error
	console.error = (...args) => consoleErrors.push(args.join(' '))
	try {
		mod.apply(makeClientCtx(registrations, effects, injects))
		check('apply() 执行成功', true, `注册 ${registrations.length} 个座位，${effects.length} 个 effect`)
	} catch (error) {
		console.error = realError
		check('apply() 执行成功', false, error?.message ?? String(error))
		return finish()
	}
	console.error = realError
	check('apply 期间没有静默吞掉的注册错误', consoleErrors.length === 0, consoleErrors.join(' | '))

	// inject 的座位名必须是**座位名本身**。写成 `座位:key` 这种复合串时，真实现会
	// specDynamic 查不到 → 静默等待、永不回调 —— 不抛错、无日志，座位就永远不会注册。
	check('inject 的座位名里不含「:」（key 只能写在 register 里）', injects.length > 0 && injects.every((i) => !i.key.includes(':')), injects.map((i) => i.key).join(' , '))
	check('每个 inject 的回调都真的执行成功了', injects.length > 0 && injects.every((i) => i.ok), injects.filter((i) => !i.ok).map((i) => `${i.key}: ${i.error}`).join(' | ') || `${injects.length} 条全成功`)

	const findSeat = (name, key) =>
		registrations.find((r) => r.spec.name === name && (key === undefined || r.spec.key === key))
	const overlay = findSeat('shell.overlay')
	const pill = findSeat('conversation.session.header.utilities')
	const plus = findSeat('conversation.input.right')
	const userBubble = findSeat('conversation.chat.node', 'user')
	const assistantBubble = findSeat('conversation.chat.node', 'assistant-step')

	check('注册了 shell.overlay（三个整页 + 导航）', !!overlay && overlay.spec.id === 'xingye-ui', overlay ? `order=${overlay.spec.order}` : '(缺)')
	check('注册了 conversation.session.header.utilities（对话头部胶囊）', !!pill && pill.spec.id === 'xingye-pill')
	check('注册了 conversation.input.right（+ 剧情菜单）', !!plus && plus.spec.id === 'xingye-plus', plus ? `order=${plus.spec.order}` : '(缺)')
	check('接管了 conversation.chat.node 的 user 气泡', !!userBubble && userBubble.spec.key === 'user')
	check('接管了 conversation.chat.node 的 assistant-step 气泡', !!assistantBubble && assistantBubble.spec.key === 'assistant-step')
	// keyed 座位用默认优先级接管会被注册表直接拒绝（"already has an entry for key … at priority 0
	// — register at a different priority to shadow it (lowest renders)"），所以必须显式给更小的值。
	check(
		'接管 keyed 座位时显式给了更小的 priority（数值越小越靠前）',
		typeof userBubble?.spec.priority === 'number' && userBubble.spec.priority < 0 &&
			typeof assistantBubble?.spec.priority === 'number' && assistantBubble.spec.priority < 0,
		`user=${userBubble?.spec.priority} assistant=${assistantBubble?.spec.priority}`,
	)
	check('一共注册 5 个座位', registrations.length === 5, String(registrations.length))
	check('overlay 的 label 是可求值的 thunk', typeof overlay?.spec.label === 'function' && String(overlay.spec.label()).length > 0, String(overlay?.spec.label?.()))
	check('注册了轮询 effect', effects.length === 1, effects.map((e) => e.label).join(' / '))
	if (!overlay || !pill || !plus || !userBubble || !assistantBubble) return finish()

	const test = mod.__test
	const render = (el) => server.renderToStaticMarkup(el)

	// 3. 等 refresh() 的 fetch 落地，state 才有数据
	await new Promise((r) => setTimeout(r, 60))
	check('refresh() 拉了 state', fetched.some((u) => u.includes('/xingye/api/state')), fetched.join(' , '))
	check('state 请求带上了界面版本（版本握手）', fetched.some((u) => /\/xingye\/api\/state\?v=.+/.test(u)), fetched.find((u) => u.includes('/state')) || '(无)')
	check('state 已装载到内存', !!test.readState(), test.readError() || 'ok')

	// 4. Stage：没有整页打开时只有浮层根；打开整页才有 sheet + nav
	{
		const html = render(React.createElement(overlay.component, {}))
		check('Stage 渲染出浮层根', html.includes('xy-root'), `${html.length} 字`)
		check('Stage 带着内联 CSS（data-xingye）', html.includes('data-xingye') && html.includes('.xy-root'))
		check('未打开整页时不渲染导航（不遮挡输入条）', !html.includes('class="xy-nav"'))
	}

	// 打开「我的角色」整页：导航与三个 Tab 必须出现 —— 这正是「界面没出来」的判定点
	test.setPage('characters')
	try {
		const html = render(React.createElement(overlay.component, {}))
		const tabs = ['角色', '创作', '人设']
		const missing = tabs.filter((t) => !html.includes(t))
		check('整页打开后渲染出底部导航的三个 Tab', missing.length === 0, missing.length ? `缺少 ${missing.join('、')}` : `${html.length} 字`)
		check('整页带着设计稿标题「我的角色」', html.includes('我的角色'))
		check('整页带着设计稿说明文案', html.includes('所有角色仅保存在本地'))
		check('角色卡片渲染出来了', html.includes('张居正') && html.includes('明代'))
		check('卡片带档案入口', html.includes('2 档案'))
		// shell.overlay 整层点击穿透，占用者必须自己把点击收回来
		check('整页与导航收回了点击（pointer-events:auto）', /\.xy-sheet\{[^}]*pointer-events:auto/.test(html) && /\.xy-nav\{[^}]*pointer-events:auto/.test(html))
		check('渲染了遮罩（平板/桌面可点关闭）', html.includes('xy-scrim'))
		// 多端适配：断点必须真的在 CSS 里
		check('CSS 含平板断点（≥720px 居中卡片 + 悬浮胶囊导航）', html.includes('@media (min-width:720px)') && html.includes('border-radius:var(--xy-r-pill)'))
		check('CSS 含桌面断点（≥980px 双列网格）', html.includes('@media (min-width:980px)') && html.includes('auto-fill'))
		check('CSS 含动效偏好降级（prefers-reduced-motion）', html.includes('prefers-reduced-motion'))
		check('CSS 含安全区内边距（env(safe-area-inset-*)）', html.includes('env(safe-area-inset-bottom'))
		// 设计稿视觉契约：色值 / 几何照抄，不是"再设计"
		check('设计稿色值原样存在（品牌紫 #8b5cf6 / 暖白 #fffbf7）', html.includes('#8b5cf6') && html.includes('#fffbf7'))
		check('设计稿几何原样存在（16px 圆角 / 56px 头像 / 64px 导航）', html.includes('--xy-r-lg:16px') && html.includes('flex:0 0 56px') && html.includes('--xy-nav-h:64px'))
	} catch (error) {
		check('Stage 可渲染（我的角色整页）', false, error?.message ?? String(error))
	}

	// 切到「创作角色」/「我的人设」：标题必须在
	test.setPage('create')
	try {
		const html = render(React.createElement(overlay.component, {}))
		check('创作角色整页渲染出设计稿字段', ['创作角色', '角色名称', '角色简介', '性格设定', '开场白', '性格标签', '保存角色', '上传头像'].every((m) => html.includes(m)), `${html.length} 字`)
		check('创作角色整页渲染出设计稿的五个预设标签', ['温柔', '傲娇', '毒舌', '元气', '神秘'].every((m) => html.includes(m)))
	} catch (error) {
		check('Stage 可渲染（创作角色整页）', false, error?.message ?? String(error))
	}

	test.setPage('persona')
	try {
		const html = render(React.createElement(overlay.component, {}))
		check('我的人设整页渲染出设计稿结构', ['我的人设', '选择人设', '新建人设', '不用人设', '人设决定你在对话中的身份'].every((m) => html.includes(m)), `${html.length} 字`)
		check('当前人设卡显示了当前那一套', html.includes('朱翊钧（万历帝）'))
	} catch (error) {
		check('Stage 可渲染（我的人设整页）', false, error?.message ?? String(error))
	}

	test.setPage('archives', CHARACTER.id)
	try {
		const html = render(React.createElement(overlay.component, {}))
		check('档案整页渲染出两条档案', html.includes('默认档案') && html.includes('档案 2') && html.includes('新建档案'), `${html.length} 字`)
	} catch (error) {
		check('Stage 可渲染（档案整页）', false, error?.message ?? String(error))
	}

	test.setPage(null)

	// 5. 对话头部胶囊
	try {
		const html = render(React.createElement(pill.component, { sessionId: SESSION_ID }))
		check('胶囊渲染出人物名与档案（设计稿的头部信息）', html.includes('张居正') && html.includes('默认档案'), `${html.length} 字`)
		check('胶囊带 xy-pill 类', html.includes('xy-pill'))
	} catch (error) {
		check('SessionPill 可渲染', false, error?.message ?? String(error))
	}
	try {
		const html = render(React.createElement(pill.component, { sessionId: 'session-别的-会话' }))
		check('不是星野的会话说，胶囊不出现（避免误导）', html === '', `"${html}"`)
	} catch (error) {
		check('SessionPill 在陌生会话里可渲染', false, error?.message ?? String(error))
	}

	// 6. 「+」剧情菜单
	try {
		const html = render(React.createElement(plus.component, { sessionId: SESSION_ID }))
		check('PlusMenu 渲染出「+」按钮', html.includes('xy-plus'))
	} catch (error) {
		check('PlusMenu 可渲染', false, error?.message ?? String(error))
	}

	// 7. 气泡
	try {
		const html = render(React.createElement(userBubble.component, { node: USER_NODE, sessionId: SESSION_ID }))
		check('用户气泡是紫色右侧气泡', html.includes('xy-chat--out') && html.includes('天下何以至此'))
	} catch (error) {
		check('UserBubble 可渲染', false, error?.message ?? String(error))
	}
	try {
		const html = render(React.createElement(assistantBubble.component, { node: ASSISTANT_NODE, sessionId: SESSION_ID }))
		check('星野气泡是白色左侧气泡 + 头像', html.includes('xy-chat--in') && html.includes('xy-chat__avatar') && html.includes('<img'))
		check('星野气泡渲染了 markdown（粗体 / 列表 / 围栏码）', html.includes('<strong>纪纲不振</strong>') && html.includes('<ul>') && html.includes('<pre>'))
		check('推理块不进气泡（推理是过程，不是台词）', !html.includes('这段不该出现在气泡里'))
	} catch (error) {
		check('AssistantBubble 可渲染', false, error?.message ?? String(error))
	}
	try {
		const html = render(React.createElement(assistantBubble.component, { node: { data: { status: 'running', blocks: [] } }, sessionId: SESSION_ID }))
		check('流式空块时渲染打字点而不是一片空白', html.includes('xy-chat__typing'))
	} catch (error) {
		check('AssistantBubble 流式态可渲染', false, error?.message ?? String(error))
	}

	// 8. 空数据不炸
	const emptyPanels = [
		['CharactersPage', test.CharactersPage, { characters: [], activeId: null, boundSessionId: null, onEnter() {}, onOpenArchives() {} }],
		['CreatePage', test.CreatePage, { onNotice() {}, onSubmit() {}, onUpload: () => Promise.resolve({ ok: false }) }],
		['PersonaPage', test.PersonaPage, { personas: [], activeId: null, onNotice() {}, onPick() {}, onClear() {}, onSubmit() {} }],
		['ArchivesPage', test.ArchivesPage, { character: null, activeArchiveId: null, onEnter() {}, onSwitchArchive() {}, onCreateArchive() {}, onDelete() {} }],
		['Nav', test.Nav, { page: null, onGo() {} }],
		['Stage 无 state', overlay.component, {}],
	]
	for (const [name, Component, props] of emptyPanels) {
		try {
			const html = render(React.createElement(Component, props))
			check(`${name} 渲染（空数据不炸）`, typeof html === 'string', `${html.length} 字`)
		} catch (error) {
			check(`${name} 渲染（空数据不炸）`, false, error?.message ?? String(error))
		}
	}

	// 9. markdown 渲染器的边界
	try {
		const cases = [
			['加粗', '**粗**', '<strong>粗</strong>'],
			['斜体', '*斜*', '<em>斜</em>'],
			['行内码', '`x=1`', '<code>x=1</code>'],
			['标题', '### 三号', '<h4>三号</h4>'],
			['有序列表', '1. 甲\n2. 乙', '<ol>'],
			['引用', '> 引用一句', '<blockquote>'],
			['动作神态', '（低头轻笑）你倒是不怕我。', 'xy-chat__stage'],
		]
		const bad = cases.filter(([, src, want]) => !String(render(React.createElement('div', null, test.richNodes(src)))).includes(want))
		check('轻量 markdown 覆盖段落/标题/列表/引用/粗斜体/行内码/动作神态', bad.length === 0, bad.map((c) => c[0]).join('、'))
		check('空文本渲染成 null（不产生空段落）', test.richNodes('') === null && test.richNodes('   ') === null)
	} catch (error) {
		check('轻量 markdown 可运行', false, error?.message ?? String(error))
	}

	// 10. 配色：必须写在 body 上，否则被主题 presenter 的内联值压住
	//
	// 这一条守的是「深色主题配浅色文字 / 浅色主题配深色文字」都会糊：
	// 自定义属性遵循继承，而**元素自己声明的值永远赢过从 html 继承来的值** ——
	// presenter 把 token 内联写在 body.style 上，所以只写 html 是无效的。
	{
		const onBody = bodyWrites.filter(([n, , p]) => n === '--dsw-alias-bg-base' && p === 'important')
		check('设计稿配色写到了 body 且带 !important', onBody.length > 0, `body 上写了 ${bodyWrites.length} 条`)
		check('设计稿配色也写了一份到 html（首帧用）', htmlWrites.some(([n]) => n === '--dsw-alias-bg-base'), `html 上写了 ${htmlWrites.length} 条`)
		check('应用底色被改成透明（画布那两层才透得出来）', bodyWrites.some(([n, v]) => n === '--dsw-alias-bg-base' && v === 'transparent'))
		check('品牌色就是设计稿的 #8b5cf6', bodyWrites.some(([n, v]) => n === '--dsw-alias-brand-primary' && v === '#8b5cf6'))
		check('body 挂上了 xy-canvas（设计稿画布）', bodyClasses.has('xy-canvas'), [...bodyClasses].join(','))
		check('html 上写了界面版本（可线上核对页面跑的是哪一版）', rootAttrs['data-xy-ui'] === test.UI_VERSION, String(rootAttrs['data-xy-ui']))
	}

	// 10b. 主题信号：colorScheme 说了算，旧版残留的 data-ds-dark-theme 必须被清掉
	//
	// 这一条守的是一个**会骗人的残留证据**：旧版星野界面自己往 body 上打过
	// data-ds-dark-theme。界面换代之后没人清，只看这个属性就会一直判成深色，
	// 于是「与设计稿一致」永远落不了地（实测就撞上了：settings 里 preference 是 light）。
	{
		const before = bodyWrites.length
		bodyAttrs['data-ds-dark-theme'] = '' // 旧界面的残留
		const rootStyle = globalThis.document.documentElement.style
		rootStyle.colorScheme = 'light' // presenter 的权威声明
		test.applyPalette()
		check('colorScheme=light 时清掉残留的 data-ds-dark-theme', !Object.prototype.hasOwnProperty.call(bodyAttrs, 'data-ds-dark-theme'), JSON.stringify(bodyAttrs))
		const written = bodyWrites.slice(before)
		check('浅色走设计稿原样的深墨字（#1f1b24）', written.some(([n, v]) => n === '--dsw-alias-label-primary' && v === '#1f1b24'))
		check('浅色不挂 data-xy-dark', !Object.prototype.hasOwnProperty.call(rootAttrs, 'data-xy-dark'), JSON.stringify(rootAttrs))
		check('浅色记下 data-xy-scheme=light', rootAttrs['data-xy-scheme'] === 'light', String(rootAttrs['data-xy-scheme']))

		const before2 = bodyWrites.length
		rootStyle.colorScheme = 'dark'
		test.applyPalette()
		const written2 = bodyWrites.slice(before2)
		check('colorScheme=dark 时切到深色译文（文字变浅）', written2.some(([n, v]) => n === '--dsw-alias-label-primary' && v === '#f3effa'))
		check('深色挂上 data-xy-dark', Object.prototype.hasOwnProperty.call(rootAttrs, 'data-xy-dark'))
		check('深色仍在同一个品牌紫族里变形（#a78bfa）', written2.some(([n, v]) => n === '--dsw-alias-brand-primary' && v === '#a78bfa'))

		// 复位成浅色，后面的断言按设计稿原样走
		rootStyle.colorScheme = 'light'
		test.applyPalette()
	}

	// 11. 角色氛围图：只切变量与类，绘制交给 body::after
	try {
		test.applyBackdrop('data:image/webp;base64,UklGRtgKA', true)
		check('applyBackdrop 挂上 xy-has-backdrop', bodyClasses.has('xy-has-backdrop'), [...bodyClasses].join(','))
		check('applyBackdrop 把图画进 --xy-backdrop-image', bodyWrites.some(([n, v]) => n === '--xy-backdrop-image' && String(v).includes('url("data:image/webp')))
		test.applyBackdrop(null, false)
		check('没有背景图时退回设计稿的纯净暖白画布', !bodyClasses.has('xy-has-backdrop'))
	} catch (error) {
		check('applyBackdrop 可运行', false, error?.message ?? String(error))
	}

	// 11b. 画布分层：伪元素必须是负 z-index，否则会画在内容之上把界面糊掉
	{
		const css = String(test.CSS || '')
		check('画布伪元素用负 z-index（不覆盖内容）', /body\.xy-canvas::after\{[^}]*z-index:-1/.test(css), css.includes('body.xy-canvas::after'))
		check('画布伪元素带 pointer-events:none（不拦点击）', /body\.xy-canvas::after\{[^}]*pointer-events:none/.test(css))
		check('底色画在 html 上（body 保持透明）', /html\{[^}]*background-color:var\(--xy-bg\)/.test(css))
	}

	// 12. 错误边界：防止「座位永久让位」的那道防线
	check(
		'CrashBoundary 是带 componentDidCatch 的类组件边界',
		typeof test.CrashBoundary === 'function' &&
			typeof test.CrashBoundary.getDerivedStateFromError === 'function' &&
			typeof test.CrashBoundary.prototype.componentDidCatch === 'function',
	)

	// ── 13. 迷你运行时：真的执行 effect ──────────────────────────────────────
	console.log('\n  ── 迷你运行时：执行渲染 + effect ──')
	const mini = createMiniReact()
	let miniMod
	try {
		miniMod = captured.factory((n) => {
			if (n === 'react') return mini.React
			throw new Error('未声明的外部模块：' + n)
		})
	} catch (error) {
		check('迷你运行时：工厂求值', false, error?.message ?? String(error))
		return finish()
	}

	const miniRegs = []
	const miniEffects = []
	const miniInjects = []
	posted.length = 0
	try {
		miniMod.apply(makeClientCtx(miniRegs, miniEffects, miniInjects))
		check('迷你运行时：apply 成功', true, `注册 ${miniRegs.length} 个座位`)
	} catch (error) {
		check('迷你运行时：apply 成功', false, error?.message ?? String(error))
		return finish()
	}

	const miniOverlay = miniRegs.find((r) => r.spec.name === 'shell.overlay')
	const miniPill = miniRegs.find((r) => r.spec.name === 'conversation.session.header.utilities')
	const miniUser = miniRegs.find((r) => r.spec.name === 'conversation.chat.node' && r.spec.key === 'user')
	const miniAssistant = miniRegs.find((r) => r.spec.name === 'conversation.chat.node' && r.spec.key === 'assistant-step')
	check('迷你运行时：5 个座位都注册了', miniRegs.length === 5)

	await new Promise((r) => setTimeout(r, 40))

	const miniTargets = [
		['Stage', miniOverlay?.component, {}],
		['SessionPill', miniPill?.component, { sessionId: SESSION_ID }],
		['UserBubble', miniUser?.component, { node: USER_NODE, sessionId: SESSION_ID }],
		['AssistantBubble', miniAssistant?.component, { node: ASSISTANT_NODE, sessionId: SESSION_ID }],
	]
	for (const [label, Component, props] of miniTargets) {
		if (typeof Component !== 'function') { check(`迷你运行时：${label} 是组件`, false); continue }
		let renderThrew = null
		try {
			mini.render(mini.React.createElement(Component, props))
		} catch (error) {
			renderThrew = error
		}
		check(`迷你运行时：${label} 渲染不抛错`, renderThrew === null, renderThrew ? String(renderThrew.message || renderThrew) : 'ok')

		const effectErrors = mini.runEffects()
		check(
			`迷你运行时：${label} 的 effect 不抛错`,
			effectErrors.length === 0,
			effectErrors.map((e) => `${e.name}: ${e.message}`).join(' | '),
		)
	}

	// effect 真的跑过，就该有东西回报给 Host —— 这正是当初缺失的能力
	check('effect 执行后回报了诊断到 /xingye/api/diag', posted.some((p) => p.url.includes('/xingye/api/diag')), posted.map((p) => p.url).join(' , '))
	const diag = posted.find((p) => p.url.includes('/xingye/api/diag'))
	if (diag) {
		check('诊断里带界面版本', typeof diag.body.version === 'string' && diag.body.version.length > 0, String(diag.body.version))
		check('诊断里带 5 个座位', Array.isArray(diag.body.seats) && diag.body.seats.length === 5, JSON.stringify(diag.body.seats))
		check('诊断里带 state 装载情况', diag.body.stateOk === true && diag.body.characterCount === 1, JSON.stringify({ ok: diag.body.stateOk, n: diag.body.characterCount }))
		check('诊断里带主题（浅/深）', diag.body.theme === 'light' || diag.body.theme === 'dark', String(diag.body.theme))
		// 全帧浮层会盖在所有会话上；这个值就是「面板动作发不发得出去」的判据。
		// 没有 useSessions（即拿不到当前会话）时必须为 false —— 否则指令会被塞进不相干的会话。
		check('诊断里带 boundSession，且拿不到会话时判定为未绑定', diag.body.boundSession === false && diag.body.sessionId === null, JSON.stringify({ bound: diag.body.boundSession, session: diag.body.sessionId }))
	}

	// 14. 错误边界真的接得住 —— 用迷你运行时（客户端语义）
	{
		posted.length = 0
		function Boom() { throw new Error('故意的渲染错误') }
		let threw = null
		try {
			mini.render(mini.React.createElement(miniMod.__test.CrashBoundary, { label: '测试边界' }, mini.React.createElement(Boom)))
		} catch (error) {
			threw = error
		}
		check('CrashBoundary 接住子组件渲染错误（错误不再逃逸）', threw === null, threw ? String(threw.message || threw) : 'ok')

		const crash = posted.find((p) => p.url.includes('/xingye/api/diag') && p.body && p.body.crash)
		check('接住之后把崩溃写回 Host（ui-crash.json）', !!crash, posted.map((p) => p.url).join(' , ') || '(没有任何上报)')
		if (crash) {
			check('崩溃记录里有 kind / message / version', crash.body.crash.kind === '测试边界' && /故意的渲染错误/.test(crash.body.crash.message) && typeof crash.body.crash.version === 'string', JSON.stringify({ kind: crash.body.crash.kind, msg: crash.body.crash.message, v: crash.body.crash.version }))
		}
	}

	// 15. 主动制造一个 effect 崩溃，确认迷你运行时**抓得住**（验证测试自身有效）
	{
		const probe = createMiniReact()
		function BrokenEffect() {
			probe.React.useEffect(() => { undefinedIdentifierProbe() })
			return null
		}
		probe.render(probe.React.createElement(BrokenEffect, {}))
		const caught = probe.runEffects()
		check(
			'迷你运行时会抓出 effect 里的未定义标识符（自检）',
			caught.length === 1 && /undefinedIdentifierProbe/.test(String(caught[0].message)),
			caught.map((e) => e.message).join(' | ') || '(没抓到 —— 这个测试本身失效了)',
		)
	}

	// 16. Host 半的新路由：upload 必须存在（界面上的「上传头像」全靠它）
	{
		try {
			const hostSrc = fs.readFileSync(path.join(pluginDir, 'index.js'), 'utf8')
			check('Host 半提供 /xingye/api/upload（头像暂存）', /upload:\s*async/.test(hostSrc) && hostSrc.includes('_staging'))
			check('Host 半的请求体上限够放一张图（>8MB）', /MAX_BODY\s*=\s*\d+\s*\*\s*1024\s*\*\s*1024/.test(hostSrc))
		} catch (error) {
			check('读得到 Host 半源码', false, error?.message ?? String(error))
		}
	}

	// 17. 部署一致性：运行时加载的是 profile 里的一份**真实拷贝**，不是源目录。
	{
		const pkgName = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8')).name
		const deployed = path.join(os.homedir(), '.dsh', 'profiles', 'web-1', 'node_modules', pkgName)
		if (!fs.existsSync(deployed)) {
			console.log(`  ── 跳过部署一致性检查：${deployed} 不存在 ──`)
		} else if (path.resolve(deployed) === path.resolve(pluginDir)) {
			console.log('  ── 运行时目录就是源目录（同一个路径），无需检查 ──')
		} else {
			for (const file of ['client.js', 'index.js', 'package.json', 'cordis.patch.yml']) {
				const from = path.join(pluginDir, file)
				if (!fs.existsSync(from)) continue
				const a = fs.readFileSync(from, 'utf8')
				const b = fs.existsSync(path.join(deployed, file)) ? fs.readFileSync(path.join(deployed, file), 'utf8') : null
				check(
					`运行时拷贝与源一致：${file}`,
					a === b,
					a === b ? '' : `源 ${a.length} / 运行时 ${b === null ? '缺失' : b.length} 字符 —— 跑 node tools/deploy-ui-plugin.mjs 同步`,
				)
			}
		}
	}

	return finish()
}

function finish() {
	console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}（共 ${results.length} 项）\n`)
	process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
	console.error('\n测试自身崩了：', error)
	process.exit(2)
})

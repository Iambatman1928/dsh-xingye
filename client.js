/**
 * 星野 界面 · Client 半（设计稿版）
 *
 * 手写 CJS 工厂形态：client.js 由 __ModuleLoader__ 直接执行，不需要构建步骤，
 * 因此这里没有 import / JSX / TS —— React 通过 factory 的 require 取得。
 *
 * ── 这一版是按 4 张设计稿重做的 ─────────────────────────────────────────────
 *   · 角色.html      → 「我的角色」列表页
 *   · 对话.html      → 对话页（气泡 / 头部 / 输入条）
 *   · 创作角色.html  → 「创作角色」表单页
 *   · 用户人设.html  → 「我的人设」管理页
 *
 * 设计稿的视觉契约（配色 / 圆角 / 阴影 / 字号 / 间距）原样搬进 DESIGN 常量与 CSS，
 * 不做"再设计"。设计稿没有的部分（交互、多端适配）按同一套语言补齐。
 *
 * ── 座位映射（每个都已核实过真实契约）─────────────────────────────────────
 *   shell.overlay                       root   list  → 三个整页 + 底部导航 + 提示条
 *   conversation.session.header.utilities session list → 对话页头部的人物胶囊
 *   conversation.input.right            session list → 输入条右侧的「+」剧情菜单
 *   conversation.chat.node (key=user)            keyed → 紫色右侧气泡
 *   conversation.chat.node (key=assistant-step)  keyed → 白色左侧气泡 + 头像
 *
 * 遮蔽两个 keyed 气泡节点是**故意的**，代价已经算清楚：
 *   · 工具卡片不在 assistant-step 里 —— `tool-call` 是独立的 ChatNodeKind，
 *     占位者仍然是官方的，所以「星野 调了什么工具」照样看得见。
 *   · 丢掉的是官方 AssistantMarkdown（含推理块 / 文件提及 / 代码高亮），
 *     这里用自带的轻量 markdown 顶上（段落 / 标题 / 列表 / 引用 / 粗斜体 / 行内码 / 围栏码）。
 *   · 注册优先级规则（dsh-cordis-client-runner/lib/client.js:383）：
 *     **后注册者拿到更小的 priority 数字，而小者胜出** —— 所以常驻包注册即接管。
 *
 * ── 多端适配 ──────────────────────────────────────────────────────────────
 *   <720px   手机：整页铺满 + 底部通栏导航
 *   ≥720px   平板：居中卡片 + 悬浮胶囊导航 + 遮罩可点关闭
 *   ≥980px   桌面：加宽卡片、角色列表变双列网格
 *   另含 safe-area 内边距、prefers-reduced-motion、深浅两套 token。
 */

window.__ModuleLoader__.load({
	id: 'dsh-xingye',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		var React = require('react')

		/**
		 * 界面版本。改了 client.js 就把它 +1。
		 *
		 * 用途只有一个：判断浏览器里跑的到底是不是磁盘上这一份代码。
		 * 常驻客户端模块的 bundle URL 带 `rev`，而响应头是
		 * `Cache-Control: immutable, max-age=1y` —— 旧页面可以一直跑几小时前的代码，
		 * 表现就是「改了没反应」。版本号让这件事当场可判，不必猜。
		 */
		var UI_VERSION = '2026-09-17.5'

		/* ══ 设计稿 token ═══════════════════════════════════════════════════
		 * 直接抄 4 张设计稿 <style id="theme-vars"> 里的值，不换算、不近似。
		 */
		var DESIGN = {
			bg: '#fffbf7',
			surface: '#ffffff',
			surface2: '#f5f0fa',
			surface3: '#efe9f7',
			ink: '#1f1b24',
			ink2: '#6b6570',
			ink3: '#9b94a3',
			line: '#ede8f0',
			brand: '#8b5cf6',
			brandHover: '#7c3aed',
			brandSoft: '#f3effb',
			brandInk: '#ffffff',
			success: '#10b981',
			warning: '#f59e0b',
			error: '#ef4444',
			info: '#3b82f6',
			font: 'Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
		}

		/** 深色变体：同一套结构，只换色值。DSH 切到深色主题时自动启用。 */
		var DESIGN_DARK = {
			bg: '#17141d',
			surface: '#201c28',
			surface2: '#2a2535',
			surface3: '#332c40',
			ink: '#f3effa',
			ink2: '#b6aec4',
			ink3: '#8b8399',
			line: '#332c40',
			brand: '#a78bfa',
			brandHover: '#c4b5fd',
			brandSoft: '#2b2340',
			brandInk: '#1a1526',
			success: '#34d399',
			warning: '#fbbf24',
			error: '#f87171',
			info: '#60a5fa',
			font: DESIGN.font,
		}

		/* ══ 图标 ═══════════════════════════════════════════════════════════
		 * 设计稿用的是 lucide（CDN）。常驻客户端模块不联网取图标，所以把需要的
		 * 几个 path 内联进来 —— 同一条 24×24 几何，视觉与设计稿一致。
		 */
		var ICONS = {
			users:
				'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
			'plus-circle':
				'<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/><path d="M12 8v8"/>',
			'user-circle':
				'<circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3"/><path d="M6.5 20.2A7 7 0 0 1 12 17a7 7 0 0 1 5.5 3.2"/>',
			plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
			check: '<path d="M20 6 9 17l-5-5"/>',
			x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
			'chevron-right': '<path d="m9 18 6-6-6-6"/>',
			'chevron-left': '<path d="m15 18-6-6 6-6"/>',
			'arrow-left': '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
			camera:
				'<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
			'more-vertical':
				'<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>',
			send: '<path d="M14.5 9.5 21 3l-6.5 18-3-7.5L4 10.5z"/><path d="m10.5 13.5 3-3"/>',
			archive:
				'<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
			trash:
				'<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
			sparkles:
				'<path d="m12 3-1.9 5.8L4 10.7l6.1 1.9L12 18.4l1.9-5.8L20 10.7l-6.1-1.9z"/><path d="M5 3v4"/><path d="M3 5h4"/><path d="M19 17v4"/><path d="M17 19h4"/>',
			'message-circle': '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
			'chevron-down': '<path d="m6 9 6 6 6-6"/>',
		}

		function Icon(props) {
			var name = props && props.name ? props.name : 'sparkles'
			var size = props && props.size ? props.size : 20
			var body = ICONS[name] || ICONS.sparkles
			return React.createElement('svg', {
				className: props && props.className ? props.className : undefined,
				width: size,
				height: size,
				viewBox: '0 0 24 24',
				fill: 'none',
				stroke: 'currentColor',
				strokeWidth: 1.8,
				strokeLinecap: 'round',
				strokeLinejoin: 'round',
				'aria-hidden': 'true',
				style: props && props.style ? props.style : undefined,
				dangerouslySetInnerHTML: { __html: body },
			})
		}

		/* ══ 样式 ═══════════════════════════════════════════════════════════
		 * 组件类名前缀 `xy-`，一个都不与设计稿冲突（设计稿用 Tailwind 工具类）。
		 * 所有几何值来自设计稿：卡片 16px 圆角、头像 56px、导航 64px、品牌紫 #8b5cf6。
		 */
		var CSS = `
/* ── token：设计稿的语义层 ───────────────────────────────────────────── */
:root{
  --xy-bg:${DESIGN.bg}; --xy-surface:${DESIGN.surface}; --xy-surface-2:${DESIGN.surface2};
  --xy-surface-3:${DESIGN.surface3}; --xy-ink:${DESIGN.ink}; --xy-ink-2:${DESIGN.ink2};
  --xy-ink-3:${DESIGN.ink3}; --xy-line:${DESIGN.line}; --xy-brand:${DESIGN.brand};
  --xy-brand-hover:${DESIGN.brandHover}; --xy-brand-soft:${DESIGN.brandSoft};
  --xy-brand-ink:${DESIGN.brandInk}; --xy-error:${DESIGN.error}; --xy-warning:${DESIGN.warning};
  --xy-r-sm:4px; --xy-r-md:8px; --xy-r-lg:16px; --xy-r-xl:20px; --xy-r-pill:999px;
  --xy-sh-1:0 1px 2px rgba(31,27,36,.05),0 1px 1px rgba(31,27,36,.03);
  --xy-sh-2:0 8px 24px -8px rgba(31,27,36,.14);
  --xy-sh-3:0 24px 60px -20px rgba(31,27,36,.22);
  --xy-font:${DESIGN.font};
  --xy-nav-h:64px;
  --xy-sheet-w:560px;
}
html[data-xy-dark] {
  --xy-bg:${DESIGN_DARK.bg}; --xy-surface:${DESIGN_DARK.surface}; --xy-surface-2:${DESIGN_DARK.surface2};
  --xy-surface-3:${DESIGN_DARK.surface3}; --xy-ink:${DESIGN_DARK.ink}; --xy-ink-2:${DESIGN_DARK.ink2};
  --xy-ink-3:${DESIGN_DARK.ink3}; --xy-line:${DESIGN_DARK.line}; --xy-brand:${DESIGN_DARK.brand};
  --xy-brand-hover:${DESIGN_DARK.brandHover}; --xy-brand-soft:${DESIGN_DARK.brandSoft};
  --xy-brand-ink:${DESIGN_DARK.brandInk};
  --xy-sh-1:0 1px 2px rgba(0,0,0,.32); --xy-sh-2:0 8px 24px -8px rgba(0,0,0,.5);
  --xy-sh-3:0 24px 60px -20px rgba(0,0,0,.62);
}

/* ── 画布：设计稿的暖白底 ─────────────────────────────────────────────
 * 分层是刻意的，顺序从下到上：html 的底色 + 紫晕 → body::after 的角色氛围图
 * → 应用自己的内容。两条硬约束：
 *   1. 底色画在 **html** 上，body 保持 transparent，--dsw-alias-bg-base 也设成
 *      transparent —— 否则应用那不透明的底会把下面两层全盖住。
 *   2. 两个伪元素都必须是 **负 z-index 且 pointer-events:none**。z-index:0 的
 *      全屏伪元素会画在普通流内容之上（层叠顺序第 6 层），把整个界面糊掉；
 *      负值则永远待在内容下面。
 */
html{
  background-color:var(--xy-bg);
  background-image:
    radial-gradient(1100px 620px at 12% -6%, color-mix(in srgb, var(--xy-brand) 11%, transparent), transparent 62%),
    radial-gradient(900px 520px at 106% 4%, color-mix(in srgb, var(--xy-brand) 7%, transparent), transparent 60%);
  background-attachment:fixed;
  background-repeat:no-repeat;
}
body.xy-canvas{
  background:transparent !important;
  color:var(--xy-ink) !important;
  font-family:var(--xy-font) !important;
}
/* 角色氛围图：压到很低的存在感 —— 设计稿是干净的暖白，这里只借一点气色，
   不把界面变成照片背景。关掉它只需把 --xy-backdrop-opacity 设成 0。 */
body.xy-canvas::after{
  content:''; position:fixed; inset:0; z-index:-1; pointer-events:none;
  opacity:var(--xy-backdrop-opacity,0);
  background-image:var(--xy-backdrop-image,none);
  background-size:cover; background-position:center 26%; background-repeat:no-repeat;
  filter:saturate(.85);
  transition:opacity .4s ease;
}
body.xy-canvas.xy-has-backdrop::after{opacity:var(--xy-backdrop-opacity,.16);}

/* ── 浮层根：整层点击穿透，交互区自己收回来 ───────────────────────────── */
.xy-root{position:fixed; inset:0; z-index:60; pointer-events:none;}
.xy-root *{box-sizing:border-box;}

/* ── 遮罩（平板 / 桌面）───────────────────────────────────────────────── */
.xy-scrim{position:absolute; inset:0; z-index:70; pointer-events:auto;
  background:rgba(31,27,36,.34); backdrop-filter:blur(2px); animation:xy-fade .18s ease-out;}
@keyframes xy-fade{from{opacity:0}to{opacity:1}}

/* ── 整页（手机铺满 / 桌面居中卡片）──────────────────────────────────── */
.xy-sheet{
  position:absolute; z-index:80; pointer-events:auto;
  left:0; right:0; top:0; bottom:0;
  display:flex; flex-direction:column;
  background:var(--xy-bg); color:var(--xy-ink); font-family:var(--xy-font);
  animation:xy-rise .22s cubic-bezier(.22,.7,.3,1);
  overflow:hidden;
}
@keyframes xy-rise{from{transform:translateY(14px); opacity:0}to{transform:none; opacity:1}}

.xy-sheet__head{
  flex:0 0 auto; display:flex; align-items:center; gap:10px;
  padding:calc(18px + env(safe-area-inset-top,0px)) 16px 12px;
  background:var(--xy-bg);
}
.xy-sheet__title{flex:1; min-width:0; font-size:20px; font-weight:700; letter-spacing:.01em;
  color:var(--xy-ink); margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.xy-sheet__title--center{text-align:center;}
.xy-sheet__body{flex:1 1 auto; overflow-y:auto; overscroll-behavior:contain;
  padding:2px 16px calc(var(--xy-nav-h) + 26px + env(safe-area-inset-bottom,0px));
  -webkit-overflow-scrolling:touch;}

/* 圆形按钮（设计稿：40×40 圆、品牌紫底、白图标） */
.xy-round{
  flex:0 0 auto; width:40px; height:40px; border-radius:var(--xy-r-pill);
  display:inline-flex; align-items:center; justify-content:center;
  border:0; cursor:pointer; background:var(--xy-surface-2); color:var(--xy-ink-2);
  transition:transform .12s ease, background .16s ease, color .16s ease;
}
.xy-round:hover{background:var(--xy-surface-3); color:var(--xy-ink);}
.xy-round:active{transform:scale(.94);}
.xy-round--brand{background:var(--xy-brand); color:var(--xy-brand-ink); box-shadow:var(--xy-sh-1);}
.xy-round--brand:hover{background:var(--xy-brand-hover); color:var(--xy-brand-ink);}
.xy-round--ghost{background:transparent;}

/* ── 卡片 ─────────────────────────────────────────────────────────────── */
.xy-cards{display:flex; flex-direction:column; gap:12px;}
.xy-card{
  display:flex; align-items:center; gap:12px; padding:12px;
  background:var(--xy-surface); border:1px solid var(--xy-line);
  border-radius:var(--xy-r-lg); box-shadow:var(--xy-sh-1);
  cursor:pointer; text-align:left; color:inherit; font-family:inherit;
  width:100%; transition:transform .12s ease, box-shadow .18s ease, border-color .18s ease;
}
.xy-card:hover{box-shadow:var(--xy-sh-2); border-color:color-mix(in srgb, var(--xy-brand) 26%, var(--xy-line));}
.xy-card:active{transform:scale(.98);}
.xy-card--on{border-color:var(--xy-brand); border-width:2px; padding:11px;}
.xy-card__avatar{
  flex:0 0 56px; width:56px; height:56px; border-radius:var(--xy-r-pill);
  object-fit:cover; display:flex; align-items:center; justify-content:center;
  background:var(--xy-brand-soft); color:var(--xy-brand);
  font-size:20px; font-weight:700; overflow:hidden;
}
.xy-card__main{flex:1 1 auto; min-width:0;}
.xy-card__top{display:flex; align-items:center; gap:8px; min-width:0;}
.xy-card__name{font-size:16px; font-weight:700; color:var(--xy-ink); margin:0;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.xy-card__desc{margin:4px 0 0; font-size:13px; color:var(--xy-ink-3);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.xy-chip{
  flex:0 0 auto; display:inline-block; font-size:12px; line-height:1.5;
  padding:1px 8px; border-radius:var(--xy-r-pill);
  background:var(--xy-brand-soft); color:var(--xy-brand);
  max-width:40%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.xy-chip--plain{background:var(--xy-surface-2); color:var(--xy-ink-2);}
.xy-chip--btn{cursor:pointer; border:1px solid transparent;}
.xy-chip--btn:hover{border-color:var(--xy-brand);}
.xy-chevron{flex:0 0 auto; color:var(--xy-ink-3); display:inline-flex;}

/* ── 通用文字 ─────────────────────────────────────────────────────────── */
.xy-hint{margin:22px 4px 0; font-size:12px; line-height:1.7; color:var(--xy-ink-3); text-align:center;}
.xy-sec{font-size:15px; font-weight:600; color:var(--xy-ink); margin:22px 0 12px;}
.xy-empty{padding:44px 18px; text-align:center; color:var(--xy-ink-3); font-size:13.5px; line-height:1.8;}
.xy-empty__icon{display:flex; justify-content:center; margin-bottom:12px; color:var(--xy-brand); opacity:.7;}

/* ── 表单（设计稿：字段在白色卡片里，灰底输入框）────────────────────── */
.xy-form{background:var(--xy-surface); border:1px solid var(--xy-line);
  border-radius:var(--xy-r-lg); box-shadow:var(--xy-sh-1); padding:16px;}
.xy-form__avatar-row{display:flex; flex-direction:column; align-items:center; margin-bottom:20px;}
.xy-avatar-pick{
  width:96px; height:96px; border-radius:var(--xy-r-pill);
  border:2px dashed var(--xy-line); background:var(--xy-surface-2); color:var(--xy-ink-3);
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px;
  cursor:pointer; font-family:inherit; overflow:hidden; padding:0;
  transition:border-color .16s ease, color .16s ease, transform .12s ease;
}
.xy-avatar-pick:hover{border-color:var(--xy-brand); color:var(--xy-brand);}
.xy-avatar-pick:active{transform:scale(.97);}
.xy-avatar-pick img{width:100%; height:100%; object-fit:cover; display:block;}
.xy-avatar-pick span{font-size:12px;}
.xy-field{margin-bottom:16px;}
.xy-field:last-of-type{margin-bottom:0;}
.xy-label{display:block; margin-bottom:6px; font-size:14px; font-weight:500; color:var(--xy-ink);}
.xy-input,.xy-area{
  width:100%; padding:10px 14px; font-family:inherit; font-size:14px; color:var(--xy-ink);
  background:var(--xy-surface-2); border:1px solid var(--xy-line);
  border-radius:var(--xy-r-md); outline:none; transition:box-shadow .16s ease, border-color .16s ease, background .16s ease;
}
.xy-area{resize:vertical; line-height:1.7;}
.xy-input::placeholder,.xy-area::placeholder{color:var(--xy-ink-3);}
.xy-input:focus,.xy-area:focus{
  background:var(--xy-surface); border-color:var(--xy-brand);
  box-shadow:0 0 0 3px color-mix(in srgb, var(--xy-brand) 20%, transparent);
}
.xy-input--sm{padding:8px 12px; font-size:13px;}
.xy-sub{margin-top:7px; font-size:12px; color:var(--xy-ink-3); line-height:1.6;}

/* 标签 chips：设计稿用 peer-checked 实现，这里用按钮 + 类名，行为一致 */
.xy-tags{display:flex; flex-wrap:wrap; gap:8px;}
.xy-tag{
  padding:6px 12px; border-radius:var(--xy-r-pill); font-size:12px; font-family:inherit;
  border:1px solid var(--xy-line); background:var(--xy-surface-2); color:var(--xy-ink-2);
  cursor:pointer; transition:background .16s ease, color .16s ease, border-color .16s ease, transform .12s ease;
}
.xy-tag:hover{border-color:var(--xy-brand); color:var(--xy-brand);}
.xy-tag:active{transform:scale(.96);}
.xy-tag--on{background:var(--xy-brand); border-color:var(--xy-brand); color:var(--xy-brand-ink);}
.xy-tag--add{border-style:dashed; color:var(--xy-brand); border-color:var(--xy-brand); background:var(--xy-brand-soft);}

/* 主按钮（设计稿：全宽、44px、品牌紫）*/
.xy-btn{
  display:flex; align-items:center; justify-content:center; gap:8px;
  width:100%; height:44px; margin-top:12px;
  border:0; border-radius:var(--xy-r-md); cursor:pointer; font-family:inherit;
  background:var(--xy-brand); color:var(--xy-brand-ink); font-size:14px; font-weight:500;
  transition:background .16s ease, transform .12s ease, opacity .16s ease;
}
.xy-btn:hover{background:var(--xy-brand-hover);}
.xy-btn:active{transform:scale(.99);}
.xy-btn[disabled]{opacity:.45; cursor:not-allowed;}
.xy-btn--ghost{background:var(--xy-surface-2); color:var(--xy-ink-2); border:1px solid var(--xy-line);}
.xy-btn--ghost:hover{background:var(--xy-surface-3); color:var(--xy-ink);}
.xy-btn--danger{background:transparent; color:var(--xy-error); border:1px solid color-mix(in srgb, var(--xy-error) 40%, transparent);}
.xy-btn--danger:hover{background:color-mix(in srgb, var(--xy-error) 10%, transparent);}
.xy-btn--dashed{
  background:var(--xy-brand-soft); color:var(--xy-brand);
  border:1px dashed var(--xy-brand); height:46px; font-weight:500;
}
.xy-btn--dashed:hover{background:color-mix(in srgb, var(--xy-brand) 14%, transparent);}
.xy-btn-row{display:flex; gap:10px; margin-top:12px;}
.xy-btn-row .xy-btn{margin-top:0;}

/* ── 人设：当前人设卡 + 选择列表（设计稿的勾选角标）────────────────── */
.xy-persona-current{
  position:relative; background:var(--xy-surface); border:1px solid var(--xy-line);
  border-radius:var(--xy-r-lg); box-shadow:var(--xy-sh-1); padding:16px;
  display:flex; align-items:center; gap:16px;
}
.xy-persona-current__orb{
  flex:0 0 64px; width:64px; height:64px; border-radius:var(--xy-r-pill);
  background:var(--xy-brand-soft); color:var(--xy-brand);
  display:flex; align-items:center; justify-content:center; font-size:20px; font-weight:700;
}
.xy-persona-current__name{font-size:16px; font-weight:600; color:var(--xy-ink);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.xy-persona-current__desc{margin-top:4px; font-size:13px; color:var(--xy-ink-2);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.xy-badge{
  position:absolute; top:16px; right:16px; width:20px; height:20px; border-radius:var(--xy-r-pill);
  background:var(--xy-brand); color:var(--xy-brand-ink);
  display:flex; align-items:center; justify-content:center;
}
.xy-pick{
  position:relative; display:block; width:100%; text-align:left; font-family:inherit; cursor:pointer;
  background:var(--xy-surface); border:1px solid var(--xy-line);
  border-radius:var(--xy-r-lg); box-shadow:var(--xy-sh-1); padding:16px; margin-bottom:12px;
  transition:border-color .16s ease, transform .12s ease, box-shadow .18s ease;
}
.xy-pick:hover{box-shadow:var(--xy-sh-2);}
.xy-pick:active{transform:scale(.99);}
.xy-pick--on{border:2px solid var(--xy-brand); padding:15px;}
.xy-pick__name{font-size:15px; font-weight:600; color:var(--xy-ink);}
.xy-pick__desc{margin-top:4px; font-size:13px; color:var(--xy-ink-2);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}

/* ── 底部导航：手机通栏 / 平板桌面悬浮胶囊（多端适配）────────────────── */
.xy-nav{
  position:absolute; z-index:90; pointer-events:auto;
  left:0; right:0; bottom:0;
  display:grid; grid-template-columns:repeat(3,1fr); height:var(--xy-nav-h);
  background:var(--xy-surface); border-top:1px solid var(--xy-line);
  padding-bottom:env(safe-area-inset-bottom,0px);
  box-shadow:0 -1px 0 rgba(31,27,36,.02);
}
.xy-nav__item{
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px;
  border:0; background:transparent; cursor:pointer; font-family:inherit;
  color:var(--xy-ink-3); font-size:11px; line-height:1; padding:0 6px; min-width:0;
  transition:color .16s ease, background .16s ease;
}
.xy-nav__item span{max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.xy-nav__item:hover{color:var(--xy-ink-2);}
.xy-nav__item--on{color:var(--xy-brand); font-weight:600;}

/* ── 对话页头部胶囊（注册在 conversation.session.header.utilities）────── */
.xy-pill{
  display:inline-flex; align-items:center; gap:8px; max-width:min(46vw,320px);
  height:34px; padding:0 10px 0 4px; margin:0 2px;
  border:1px solid var(--xy-line); border-radius:var(--xy-r-pill);
  background:var(--xy-surface); color:var(--xy-ink); cursor:pointer; font-family:var(--xy-font);
  box-shadow:var(--xy-sh-1); transition:box-shadow .18s ease, transform .12s ease, border-color .18s ease;
}
.xy-pill:hover{box-shadow:var(--xy-sh-2); border-color:color-mix(in srgb, var(--xy-brand) 30%, var(--xy-line));}
.xy-pill:active{transform:scale(.98);}
.xy-pill__avatar{
  flex:0 0 26px; width:26px; height:26px; border-radius:var(--xy-r-pill); overflow:hidden;
  background:var(--xy-brand-soft); color:var(--xy-brand);
  display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700;
}
.xy-pill__avatar img{width:100%; height:100%; object-fit:cover; display:block;}
.xy-pill__text{display:flex; flex-direction:column; align-items:flex-start; min-width:0; line-height:1.15;}
.xy-pill__name{font-size:12.5px; font-weight:600; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.xy-pill__meta{font-size:10.5px; color:var(--xy-ink-3); max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.xy-pill--warn{border-color:color-mix(in srgb, var(--xy-warning) 52%, var(--xy-line));}

/* ── 气泡：设计稿的左右分栏 ───────────────────────────────────────────── */
.xy-chat{display:flex; align-items:flex-end; gap:10px; margin:14px 0; max-width:82%;}
.xy-chat--in{align-self:flex-start;}
.xy-chat--out{align-self:flex-end; flex-direction:row-reverse; margin-left:auto;}
.xy-chat__avatar{
  flex:0 0 36px; width:36px; height:36px; border-radius:var(--xy-r-pill); overflow:hidden;
  border:1px solid var(--xy-line); background:var(--xy-brand-soft); color:var(--xy-brand);
  display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:700;
}
.xy-chat__avatar img{width:100%; height:100%; object-fit:cover; display:block;}
.xy-chat__bubble{
  padding:10px 14px; border-radius:var(--xy-r-lg); font-size:14px; line-height:1.72;
  word-break:break-word; overflow-wrap:anywhere; min-width:0;
}
.xy-chat--in .xy-chat__bubble{
  background:var(--xy-surface); border:1px solid var(--xy-line); color:var(--xy-ink);
  border-bottom-left-radius:var(--xy-r-md); box-shadow:var(--xy-sh-1);
}
.xy-chat--out .xy-chat__bubble{
  background:var(--xy-brand); color:var(--xy-brand-ink);
  border-bottom-right-radius:var(--xy-r-md); box-shadow:var(--xy-sh-1);
}
.xy-chat__bubble p{margin:0 0 .6em;}
.xy-chat__bubble p:last-child{margin-bottom:0;}
.xy-chat__bubble h1,.xy-chat__bubble h2,.xy-chat__bubble h3,.xy-chat__bubble h4{
  margin:.7em 0 .35em; font-size:1.02em; font-weight:700; line-height:1.5;}
.xy-chat__bubble h1:first-child,.xy-chat__bubble h2:first-child,
.xy-chat__bubble h3:first-child,.xy-chat__bubble h4:first-child{margin-top:0;}
.xy-chat__bubble ul,.xy-chat__bubble ol{margin:.35em 0 .6em; padding-left:1.35em;}
.xy-chat__bubble li{margin:.16em 0;}
.xy-chat__bubble blockquote{
  margin:.45em 0; padding:2px 0 2px 10px; border-left:3px solid var(--xy-brand);
  color:var(--xy-ink-2);}
.xy-chat__bubble code{
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:.9em;
  padding:1px 5px; border-radius:var(--xy-r-sm); background:var(--xy-surface-2); color:var(--xy-ink);}
.xy-chat--out .xy-chat__bubble code{background:rgba(255,255,255,.22); color:inherit;}
.xy-chat__bubble pre{
  margin:.5em 0; padding:10px 12px; overflow:auto; border-radius:var(--xy-r-md);
  background:var(--xy-surface-2); border:1px solid var(--xy-line);}
.xy-chat--out .xy-chat__bubble pre{background:rgba(255,255,255,.16); border-color:transparent;}
.xy-chat__bubble pre code{padding:0; background:transparent; font-size:12.5px; line-height:1.6;}
.xy-chat__stage{color:var(--xy-ink-2);}          /* （动作/神态）：按剧本感写法轻一点 */
.xy-chat--out .xy-chat__stage{color:rgba(255,255,255,.86);}
.xy-chat__img{max-width:100%; border-radius:var(--xy-r-md); display:block; margin-bottom:6px;}
.xy-chat__note{margin-top:6px; font-size:11.5px; color:var(--xy-ink-3);}
.xy-chat--out .xy-chat__note{color:rgba(255,255,255,.8); text-align:right;}
.xy-chat__typing{display:inline-flex; gap:4px; align-items:center; height:18px;}
.xy-chat__typing i{width:6px; height:6px; border-radius:50%; background:var(--xy-ink-3);
  animation:xy-blink 1.15s infinite ease-in-out;}
.xy-chat__typing i:nth-child(2){animation-delay:.16s;}
.xy-chat__typing i:nth-child(3){animation-delay:.32s;}
@keyframes xy-blink{0%,80%,100%{opacity:.26; transform:translateY(0)}40%{opacity:.9; transform:translateY(-2px)}}

/* ── 提示条 / 出错条 ─────────────────────────────────────────────────── */
.xy-toast{
  position:absolute; z-index:120; left:50%; transform:translateX(-50%);
  top:calc(14px + env(safe-area-inset-top,0px));
  pointer-events:auto; max-width:min(90vw,520px);
  padding:10px 14px; border-radius:var(--xy-r-lg); font-size:12.5px; line-height:1.65;
  background:var(--xy-surface); color:var(--xy-ink); border:1px solid var(--xy-line);
  box-shadow:var(--xy-sh-3); font-family:var(--xy-font);
  animation:xy-drop .2s ease-out;
}
@keyframes xy-drop{from{transform:translate(-50%,-8px); opacity:0}to{transform:translate(-50%,0); opacity:1}}
.xy-toast--warn{border-color:color-mix(in srgb, var(--xy-warning) 55%, var(--xy-line));}
.xy-toast--err{border-color:color-mix(in srgb, var(--xy-error) 55%, var(--xy-line)); color:var(--xy-error);}
.xy-toast__close{float:right; margin-left:10px; border:0; background:transparent; cursor:pointer;
  color:var(--xy-ink-3); font-size:14px; line-height:1; padding:0;}

/* ── 「+」剧情菜单 ─────────────────────────────────────────────────────── */
.xy-plus-wrap{position:relative; display:inline-flex;}
.xy-plus{
  width:30px; height:30px; border-radius:var(--xy-r-pill); cursor:pointer;
  border:1px solid color-mix(in srgb, var(--xy-brand) 34%, var(--xy-line));
  background:var(--xy-brand-soft); color:var(--xy-brand);
  display:inline-flex; align-items:center; justify-content:center;
  transition:background .16s ease, transform .12s ease;
}
.xy-plus:hover{background:color-mix(in srgb, var(--xy-brand) 18%, transparent);}
.xy-plus:active{transform:scale(.94);}
.xy-menu{
  position:absolute; right:0; bottom:38px; z-index:120; min-width:190px; padding:6px;
  border-radius:var(--xy-r-lg); background:var(--xy-surface); border:1px solid var(--xy-line);
  box-shadow:var(--xy-sh-3); animation:xy-drop .16s ease-out;
}
.xy-menu__item{
  display:block; width:100%; text-align:left; padding:9px 11px; border:0; border-radius:var(--xy-r-md);
  background:transparent; color:var(--xy-ink); font-size:13px; font-family:inherit; cursor:pointer;
}
.xy-menu__item:hover{background:var(--xy-brand-soft); color:var(--xy-brand);}
.xy-menu__sep{height:1px; margin:5px 8px; background:var(--xy-line);}
.xy-menu__head{padding:7px 11px 4px; font-size:11px; letter-spacing:.06em; color:var(--xy-ink-3);}

/* ── 档案行 ───────────────────────────────────────────────────────────── */
.xy-arch{
  display:flex; align-items:center; gap:12px; width:100%; text-align:left;
  background:var(--xy-surface); border:1px solid var(--xy-line); border-radius:var(--xy-r-lg);
  padding:14px 16px; margin-bottom:10px; cursor:pointer; font-family:inherit;
  box-shadow:var(--xy-sh-1); transition:border-color .16s ease, transform .12s ease;
}
.xy-arch:active{transform:scale(.99);}
.xy-arch--on{border:2px solid var(--xy-brand); padding:13px 15px;}
.xy-arch__main{flex:1; min-width:0;}
.xy-arch__title{font-size:15px; font-weight:600; color:var(--xy-ink);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.xy-arch__meta{margin-top:4px; font-size:12.5px; color:var(--xy-ink-3);}

/* ── 响应式：平板 / 桌面 ─────────────────────────────────────────────── */
@media (min-width:720px){
  :root{--xy-nav-h:58px;}
  .xy-sheet{
    left:50%; top:50%; right:auto; bottom:auto; transform:translate(-50%,-50%);
    width:min(var(--xy-sheet-w), calc(100vw - 48px));
    max-height:min(86vh, 860px);
    border-radius:var(--xy-r-xl); border:1px solid var(--xy-line);
    box-shadow:var(--xy-sh-3);
    animation:xy-pop .2s cubic-bezier(.22,.7,.3,1);
  }
  @keyframes xy-pop{from{transform:translate(-50%,-48%) scale(.97); opacity:0}
                    to{transform:translate(-50%,-50%) scale(1); opacity:1}}
  .xy-sheet__head{padding:16px 20px 10px;}
  .xy-sheet__body{padding:2px 20px calc(var(--xy-nav-h) + 34px);}
  .xy-nav{
    left:50%; right:auto; bottom:20px; transform:translateX(-50%);
    width:auto; min-width:300px; padding:6px; gap:4px;
    grid-template-columns:repeat(3,minmax(88px,1fr));
    height:auto; border-radius:var(--xy-r-pill);
    border:1px solid var(--xy-line); box-shadow:var(--xy-sh-3);
  }
  .xy-nav__item{padding:8px 14px; border-radius:var(--xy-r-pill);}
  .xy-nav__item--on{background:var(--xy-brand-soft);}
}
@media (min-width:980px){
  :root{--xy-sheet-w:680px;}
  .xy-cards{display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:14px;}
  .xy-sheet__body{padding-left:22px; padding-right:22px;}
}

/* ── 无障碍 / 动效偏好 ───────────────────────────────────────────────── */
@media (prefers-reduced-motion:reduce){
  .xy-sheet,.xy-scrim,.xy-toast,.xy-menu,.xy-chat__typing i{animation:none !important;}
  .xy-card,.xy-round,.xy-tag,.xy-nav__item,.xy-pill{transition:none !important;}
}
.xy-sr{position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden;
  clip:rect(0 0 0 0); white-space:nowrap; border:0;}
`

		/* ══ 文本小工具 ═════════════════════════════════════════════════════ */

		/** 从对话记录里取纯文本（user 那块是 blocks，assistant 那块是 kind 块）。 */
		function textOfUserContent(content) {
			if (typeof content === 'string') return content
			if (!Array.isArray(content)) return ''
			var out = []
			for (var i = 0; i < content.length; i++) {
				var b = content[i]
				if (b && b.type === 'text' && typeof b.text === 'string') out.push(b.text)
			}
			return out.join('')
		}

		/** 用户消息里的图片（交给官方 renderMessageImages 渲染，不自己造轮子）。 */
		function imagesOfUserContent(content) {
			if (!Array.isArray(content)) return []
			var out = []
			for (var i = 0; i < content.length; i++) {
				var b = content[i]
				if (b && b.type === 'image' && b.attachment !== undefined) out.push({ attachment: b.attachment })
			}
			return out
		}

		/**
		 * assistant 的 blocks 是**分类过的**（官方 toAssistantBlocks）：kind 而非 type。
		 * 只取 text（正常台词）与 image；reasoning 不进气泡（推理是过程，不是台词）。
		 */
		function partsOfAssistantBlocks(blocks) {
			var text = ''
			var images = []
			if (!Array.isArray(blocks)) return { text: text, images: images }
			for (var i = 0; i < blocks.length; i++) {
				var b = blocks[i]
				if (!b || typeof b !== 'object') continue
				if (b.kind === 'text' && typeof b.text === 'string') {
					text = text.length === 0 ? b.text : text + '\n\n' + b.text
				} else if (b.kind === 'image' && b.attachment !== undefined) {
					images.push({ attachment: b.attachment })
				}
			}
			return { text: text, images: images }
		}

		function fmtTime(iso) {
			if (!iso) return ''
			var d = new Date(iso)
			if (isNaN(d.getTime())) return ''
			var now = new Date()
			var sameDay = d.toDateString() === now.toDateString()
			var pad = function (n) { return n < 10 ? '0' + n : String(n) }
			if (sameDay) return pad(d.getHours()) + ':' + pad(d.getMinutes())
			return d.getMonth() + 1 + '月' + d.getDate() + '日'
		}

		function initialOf(name) {
			var s = String(name || '').trim()
			return s.length > 0 ? s.slice(0, 1) : '?'
		}

		/** 把「（动作）」按剧本感写法调淡一点 —— 只改颜色，不改设计稿的字号行高。 */
		function inlineNodes(text, keyPrefix) {
			var src = String(text === undefined || text === null ? '' : text)
			if (src.length === 0) return []
			var nodes = []
			var buf = ''
			var serial = 0
			var push = function (el) {
				if (buf.length > 0) { nodes.push(buf); buf = '' }
				nodes.push(el)
			}
			var stage = function (chunk) {
				if (chunk.length === 0) return
				push(React.createElement('span', { className: 'xy-chat__stage', key: keyPrefix + 's' + serial++ }, chunk))
			}

			var i = 0
			while (i < src.length) {
				var ch = src.charAt(i)
				var next = src.charAt(i + 1)

				// 围栏行内码：`code`
				if (ch === '`') {
					var endTick = src.indexOf('`', i + 1)
					if (endTick > i + 1) {
						push(React.createElement('code', { key: keyPrefix + 'c' + serial++ }, src.slice(i + 1, endTick)))
						i = endTick + 1
						continue
					}
				}
				// 粗体：**text**
				if (ch === '*' && next === '*') {
					var endBold = src.indexOf('**', i + 2)
					if (endBold > i + 2) {
						push(React.createElement('strong', { key: keyPrefix + 'b' + serial++ }, src.slice(i + 2, endBold)))
						i = endBold + 2
						continue
					}
				}
				// 斜体：*text* / _text_
				if ((ch === '*' || ch === '_') && next !== ch) {
					var endIt = src.indexOf(ch, i + 1)
					if (endIt > i + 1) {
						push(React.createElement('em', { key: keyPrefix + 'i' + serial++ }, src.slice(i + 1, endIt)))
						i = endIt + 1
						continue
					}
				}
				// 动作/神态：（……）或（……) —— 中文括号成套才算
				if (ch === '（') {
					var endCn = src.indexOf('）', i + 1)
					if (endCn > i + 1) {
						stage(src.slice(i, endCn + 1))
						i = endCn + 1
						continue
					}
				}
				if (ch === '(') {
					var endEn = src.indexOf(')', i + 1)
					if (endEn > i + 1) {
						stage(src.slice(i, endEn + 1))
						i = endEn + 1
						continue
					}
				}
				buf += ch
				i += 1
			}
			if (buf.length > 0) nodes.push(buf)
			return nodes
		}

		/**
		 * 轻量 markdown：段落 / 标题 / 无序有序列表 / 引用 / 围栏代码。
		 * 为什么不用 dangerouslySetInnerHTML：这里处理的是模型输出，直接变成 React 元素
		 * 就没有注入面，也不必自己写转义。
		 */
		function richNodes(text) {
			var src = String(text === undefined || text === null ? '' : text).replace(/\r\n?/g, '\n')
			if (src.trim().length === 0) return null
			var lines = src.split('\n')
			var out = []
			var key = 0
			var i = 0

			while (i < lines.length) {
				var line = lines[i]
				var trimmed = line.trim()

				if (trimmed.length === 0) { i += 1; continue }

				// 围栏代码
				var fence = /^\s*```(.*)$/.exec(line)
				if (fence) {
					var code = []
					i += 1
					while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { code.push(lines[i]); i += 1 }
					i += 1
					out.push(React.createElement('pre', { key: 'p' + key++ },
						React.createElement('code', null, code.join('\n'))))
					continue
				}

				// 标题
				var head = /^\s*(#{1,6})\s+(.*)$/.exec(line)
				if (head) {
					var level = Math.min(head[1].length + 2, 4)
					out.push(React.createElement('h' + level, { key: 'h' + key++ }, inlineNodes(head[2], 'h' + key + '-')))
					i += 1
					continue
				}

				// 引用
				if (/^\s*>\s?/.test(line)) {
					var quoted = []
					while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
						quoted.push(lines[i].replace(/^\s*>\s?/, ''))
						i += 1
					}
					out.push(React.createElement('blockquote', { key: 'q' + key++ },
						inlineNodes(quoted.join('\n'), 'q' + key + '-')))
					continue
				}

				// 无序列表
				if (/^\s*[-*+]\s+/.test(line)) {
					var ul = []
					while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
						ul.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
						i += 1
					}
					out.push(React.createElement('ul', { key: 'u' + key++ }, ul.map(function (item, n) {
						return React.createElement('li', { key: 'li' + n }, inlineNodes(item, 'li' + n + '-'))
					})))
					continue
				}

				// 有序列表
				if (/^\s*\d+[.)]\s+/.test(line)) {
					var ol = []
					while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
						ol.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''))
						i += 1
					}
					out.push(React.createElement('ol', { key: 'o' + key++ }, ol.map(function (item, n) {
						return React.createElement('li', { key: 'li' + n }, inlineNodes(item, 'ol' + n + '-'))
					})))
					continue
				}

				// 段落：连续非空、非结构行合成一段，段内换行按 <br> 保留
				var para = [line]
				i += 1
				while (i < lines.length) {
					var look = lines[i]
					if (look.trim().length === 0) break
					if (/^\s*```/.test(look) || /^\s*#{1,6}\s+/.test(look) || /^\s*>\s?/.test(look)) break
					if (/^\s*[-*+]\s+/.test(look) || /^\s*\d+[.)]\s+/.test(look)) break
					para.push(look)
					i += 1
				}
				var pieces = []
				for (var p = 0; p < para.length; p++) {
					if (p > 0) pieces.push(React.createElement('br', { key: 'br' + key + '-' + p }))
					var inl = inlineNodes(para[p], 'p' + key + '-' + p + '-')
					for (var q = 0; q < inl.length; q++) pieces.push(inl[q])
				}
				out.push(React.createElement('p', { key: 'p' + key++ }, pieces))
			}
			return out
		}

		/* ══ 崩溃通道 ═══════════════════════════════════════════════════════
		 * 框架给每个座位包了一层 SlotErrorBoundary：组件一抛错就把该座位
		 * **永久让位**（abdicated），页面上只剩一个空 div，错误只进浏览器控制台。
		 * 自己接住，座位就不让位，错误还能画出来并写回 Host。
		 */
		function reportCrash(kind, error, extra) {
			try {
				var payload = {
					crash: {
						kind: kind,
						version: UI_VERSION,
						message: String((error && error.message) || error),
						stack: String((error && error.stack) || '').slice(0, 2000),
						detail: extra === undefined || extra === null ? null : String(extra).slice(0, 2000),
						at: new Date().toISOString(),
					},
				}
				fetch('/xingye/api/diag', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload),
				}).catch(function () { /* 送不出去也不能再抛 */ })
			} catch (e) {
				/* 诊断本身绝不能成为新的崩溃源 */
			}
		}

		function crashBanner(label, message) {
			return React.createElement('div', { className: 'xy-toast xy-toast--err', style: { position: 'fixed', top: 12 } },
				'星野界面「' + label + '」出错了：' + message)
		}

		class CrashBoundary extends React.Component {
			constructor(props) {
				super(props)
				this.state = { error: null }
			}
			static getDerivedStateFromError(error) {
				return { error: error }
			}
			componentDidCatch(error, info) {
				reportCrash(this.props.label || '组件', error, info && info.componentStack)
			}
			render() {
				if (this.state.error) {
					return crashBanner(this.props.label || '组件', String((this.state.error && this.state.error.message) || this.state.error))
				}
				return this.props.children
			}
		}

		/** 渲染阶段的 try/catch —— effect 与子组件那一层由 CrashBoundary 负责。 */
		function safe(name, render) {
			return function Guarded(props) {
				var body
				try {
					body = render(props)
				} catch (error) {
					reportCrash(name, error, 'render')
					return crashBanner(name, String((error && error.message) || error))
				}
				return React.createElement(CrashBoundary, { label: name }, body)
			}
		}

		/* ══ 插件本体 ═══════════════════════════════════════════════════════ */

		function apply(ctx) {
			/* ── 共享状态：一个极小的可订阅 store（模块级，所有座位共用）───── */
			var snap = { state: null, error: null, page: null, focusCharacterId: null, notice: null }
			var listeners = new Set()
			var seats = []
			var noticeTimer = null
			/** 动作发出后的一段时间里加快轮询 —— 让「星野 刚做完的事」尽快可见。 */
			var fastUntil = 0
			var lastFetchAt = 0

			function emit() {
				listeners.forEach(function (fn) {
					try { fn() } catch (e) { /* 单个订阅者出错不影响别人 */ }
				})
			}

			function setPage(page, focusCharacterId) {
				snap.page = page
				if (focusCharacterId !== undefined) snap.focusCharacterId = focusCharacterId
				if (page === null) snap.focusCharacterId = null
				emit()
			}

			function setNotice(text, kind) {
				snap.notice = text ? { text: String(text), kind: kind || 'info' } : null
				emit()
				if (noticeTimer) { clearTimeout(noticeTimer); noticeTimer = null }
				if (text) {
					noticeTimer = setTimeout(function () {
						snap.notice = null
						noticeTimer = null
						emit()
					}, kind === 'error' ? 9000 : 5200)
				}
			}

			/* ── 主题：把设计稿的语义层写进 DSH 自己的 token 名 ──────────────
			 * 为什么必须写在 **body** 上：主题 presenter 把 token 内联写在 body.style
			 * （dsh-client-ui-layout 的 ThemePresenter.apply）。自定义属性遵循继承，
			 * 而元素自己声明的值永远赢过从 html 继承来的值 —— 只写 html 完全无效。
			 * 所以 html 那份只为首帧兜底，body 那份才是真正生效的那份，且带 !important。
			 */
			function paletteFor(dark) {
				var c = dark ? DESIGN_DARK : DESIGN
				var layer1 = dark ? 'rgba(32,28,40,.94)' : 'rgba(255,255,255,.96)'
				var layer2 = dark ? 'rgba(42,37,53,.96)' : 'rgba(245,240,250,.96)'
				return {
					// 透明：画布那两层画在 html 与 body::after 上（都是负 z-index），
					// 只有让应用自己的底透明，那两层才透得出来。
					'--dsw-alias-bg-base': 'transparent',
					'--dsw-alias-bg-layer-1': layer1,
					'--dsw-alias-bg-layer-2': layer2,
					'--dsw-alias-bg-layer-3': layer2,
					'--dsw-alias-bg-overlay': dark ? 'rgba(23,20,29,.98)' : 'rgba(255,255,255,.99)',
					'--dsw-alias-bg-skeleton': dark ? 'rgba(255,255,255,.06)' : 'rgba(31,27,36,.05)',
					'--dsw-alias-label-primary': c.ink,
					'--dsw-alias-label-primary-dimmed': c.ink2,
					'--dsw-alias-label-primary-inverted': c.brandInk,
					'--dsw-alias-label-secondary': c.ink2,
					'--dsw-alias-label-tertiary': c.ink3,
					'--dsw-alias-label-caption': c.ink3,
					'--dsw-alias-label-dimmed': c.ink3,
					'--dsw-alias-border-l1': c.line,
					'--dsw-alias-border-l2': dark ? '#453c55' : '#e3dced',
					'--dsw-alias-border-l3': dark ? '#564a6b' : '#d8cfe6',
					'--dsw-alias-brand-primary': c.brand,
					'--dsw-alias-brand-text': c.brand,
					'--dsw-alias-interactive-bg-hover': c.brandSoft,
					'--dsw-alias-interactive-bg-active': dark ? '#3a3050' : '#ece3fb',
					'--dsw-alias-button-primary-fill': c.brand,
					'--dsw-alias-button-contrast-fill': c.brandSoft,
					'--dsw-alias-button-elevated-fill': layer1,
					'--dsw-alias-button-floating-fill': layer1,
					'--dsw-alias-markdown-code-block': dark ? 'rgba(255,255,255,.05)' : '#f7f3fb',
					'--dsw-alias-markdown-code-block-banner': c.brandSoft,
					'--dsw-alias-markdown-inline-code': c.brandSoft,
					'--dsw-alias-markdown-placeholder': c.ink3,
					'--dsw-alias-markdown-citation': c.brandSoft,
					'--dsw-alias-tooltip-bg': dark ? 'rgba(23,20,29,.98)' : 'rgba(255,255,255,.99)',
					'--dsw-alias-toast-bg': dark ? 'rgba(23,20,29,.98)' : 'rgba(255,255,255,.99)',
					'--dsw-alias-scrollbar-bg-l1': dark ? 'rgba(255,255,255,.08)' : 'rgba(31,27,36,.10)',
					'--dsw-alias-scrollbar-hover-l1': dark ? 'rgba(255,255,255,.18)' : 'rgba(31,27,36,.20)',
					'--dsw-alias-scrollbar-bg-l2': dark ? 'rgba(255,255,255,.10)' : 'rgba(31,27,36,.12)',
					'--dsw-alias-scrollbar-hover-l2': dark ? 'rgba(255,255,255,.22)' : 'rgba(31,27,36,.24)',
					'--dsw-alias-state-error-primary': c.error,
					'--dsw-alias-state-success-primary': c.success,
					'--dsw-alias-state-warn-primary': c.warning,
					'--dsw-specific-sidebar-fill': dark ? 'rgba(23,20,29,.92)' : 'rgba(255,255,255,.96)',
				}
			}

			/**
			 * 当前的浅/深色方案。
			 *
			 * 权威信号是 `documentElement.style.colorScheme` —— 那是 dsh-client-ui-layout
			 * 的 ThemePresenter 按 `active.colorScheme` 写的（它同时按同一个值增删 body 上的
			 * `data-ds-dark-theme`）。**不能只看 data-ds-dark-theme**：旧版星野界面自己
			 * 往 body 上打过这个属性，界面换代之后没人清，于是它成了会骗人的残留证据
			 * （实测：settings 里 preference 是 light，属性却还在）。
			 *
			 * 所以顺序是：colorScheme 说了算 → 没有就退回属性 → 都没有按浅色。
			 */
			function currentScheme() {
				try {
					var declared = document.documentElement && document.documentElement.style
						? String(document.documentElement.style.colorScheme || '')
						: ''
					if (declared.indexOf('dark') >= 0) return 'dark'
					if (declared.indexOf('light') >= 0) return 'light'
				} catch (e) { /* 读不到就往下退 */ }
				try {
					if (document.body && document.body.hasAttribute('data-ds-dark-theme')) return 'dark'
				} catch (e) { /* 同上 */ }
				return 'light'
			}

			/**
			 * 应用配色。
			 *
			 * 两套 token 结构完全一样，只换色值，所以「与设计稿一致」在深浅两种环境里都成立：
			 * 浅色就是设计稿原样（暖白 #fffbf7 + 品牌紫 #8b5cf6），深色是同一套结构的深色译文。
			 */
			function applyPalette() {
				try {
					var body = document.body
					var root = document.documentElement
					if (!body || !root) return
					var scheme = currentScheme()
					var dark = scheme === 'dark'
					// 清掉旧版界面留下的残留属性：presenter 说浅色，body 上就不该有深色标记。
					// 这不是抢 presenter 的所有权 —— 它一旦应用深色会自己再加回来。
					if (!dark) {
						try { body.removeAttribute('data-ds-dark-theme') } catch (e0) { /* 无所谓 */ }
					}
					var palette = paletteFor(dark)
					for (var key in palette) {
						try { body.style.setProperty(key, palette[key], 'important') } catch (e1) { /* 单条失败不影响其余 */ }
						try { root.style.setProperty(key, palette[key], 'important') } catch (e2) { /* 同上 */ }
					}
					if (dark) root.setAttribute('data-xy-dark', '')
					else root.removeAttribute('data-xy-dark')
					root.setAttribute('data-xy-ui', UI_VERSION)
					root.setAttribute('data-xy-scheme', scheme)
					body.classList.add('xy-canvas')
				} catch (e) {
					reportCrash('配色', e, 'applyPalette')
				}
			}

			/**
			 * 角色氛围图。
			 *
			 * 只做两件事：把图写进 CSS 变量、切一个类。真正的绘制在 `body::after`
			 * 里完成（负 z-index + pointer-events:none，天生待在内容之下）。
			 * 早先那版在这里动态建 <style> 元素换规则，其实是多余的 —— 一个变量就够，
			 * 而且少一处「改了没生效」的可能。
			 */
			function applyBackdrop(url, hasImage) {
				try {
					var body = document.body
					if (!body) return
					var style = body.style
					if (style) {
						if (hasImage && url) style.setProperty('--xy-backdrop-image', 'url("' + url + '")')
						else style.removeProperty('--xy-backdrop-image')
					}
					if (hasImage && url) body.classList.add('xy-has-backdrop')
					else body.classList.remove('xy-has-backdrop')
				} catch (e) {
					reportCrash('角色氛围图', e, 'applyBackdrop')
				}
			}

			/* ── 数据：state 轮询 ─────────────────────────────────────────── */
			function refresh() {
				lastFetchAt = Date.now()
				return fetch('/xingye/api/state?v=' + encodeURIComponent(UI_VERSION))
					.then(function (res) { return res.json() })
					.then(function (data) {
						if (data && data.ok) {
							snap.state = data.value
							snap.error = null
						} else {
							snap.state = null
							snap.error = data && data.error ? data.error.message : 'state 读取失败'
						}
						emit()
					})
					.catch(function (err) {
						snap.error = String((err && err.message) || err)
						emit()
					})
			}

			/**
			 * 现场诊断：把界面上**真正算出来的**值发回 Host 落盘。
			 * 界面出问题时我看不到用户屏幕，这些值就是硬事实。
			 */
			function sendDiag(context) {
				var read = function (fn, fallback) {
					try {
						var v = fn()
						return v === undefined || v === null ? fallback : v
					} catch (e) { return 'ERR:' + ((e && e.message) || e) }
				}
				var payload = {
					version: UI_VERSION,
					at: new Date().toISOString(),
					href: read(function () { return location.href }, ''),
					viewport: read(function () { return innerWidth + 'x' + innerHeight }, ''),
					stateOk: snap.state !== null,
					stateError: snap.error,
					characterCount: snap.state && snap.state.characters ? Object.keys(snap.state.characters).length : 0,
					page: snap.page,
					boundSession: !!(context && context.bound === true),
					sessionId: context && context.sessionId ? String(context.sessionId) : null,
					archives: context && context.character ? (context.character.archives || []).length : 0,
					backdropLen: context && typeof context.bg === 'string' ? context.bg.length : 0,
					seats: seats.slice(),
					xingyeStyles: read(function () { return document.querySelectorAll('style[data-xingye]').length }, -1),
					theme: read(function () {
						return currentScheme()
					}, null),
					themeRaw: read(function () {
						return {
							colorScheme: String((document.documentElement.style && document.documentElement.style.colorScheme) || ''),
							darkAttr: !!(document.body && document.body.hasAttribute('data-ds-dark-theme')),
							prefersDark: !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches),
						}
					}, null),
					tokens: read(function () {
						var cs = getComputedStyle(document.body)
						return {
							bgBase: cs.getPropertyValue('--dsw-alias-bg-base').trim(),
							labelPrimary: cs.getPropertyValue('--dsw-alias-label-primary').trim(),
							xyBg: cs.getPropertyValue('--xy-bg').trim(),
							xyBrand: cs.getPropertyValue('--xy-brand').trim(),
						}
					}, null),
					nav: read(function () {
						var box = document.querySelector('.xy-nav')
						if (!box) return 'NOT-IN-DOM'
						var r = box.getBoundingClientRect()
						return { w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), visible: r.width > 0 && r.height > 0 }
					}, null),
					sheet: read(function () {
						var box = document.querySelector('.xy-sheet')
						if (!box) return null
						var r = box.getBoundingClientRect()
						return { w: Math.round(r.width), h: Math.round(r.height), radius: getComputedStyle(box).borderRadius }
					}, null),
					errFace: read(function () { return document.querySelectorAll('[data-slot-error]').length }, -1),
				}
				return fetch('/xingye/api/diag', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(payload),
				}).catch(function () { /* 送不出去不是故障 */ })
			}

			/**
			 * 把一条自然语言指令送给 **星野 本人** 执行。
			 *
			 * 界面不重复实现业务逻辑：新建人物、切档案、换人设，全部落到星野的工具上。
			 * 于是状态只有一份真相，界面也永远不会和 sessions.json 的内存缓存打架。
			 */
			function sendPrompt(sessionId, text) {
				fastUntil = Date.now() + 45000
				return fetch('/xingye/api/prompt', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ sessionId: sessionId, text: text }),
				}).then(function (res) { return res.json() })
			}

			/* ── 从 state 里取东西 ────────────────────────────────────────── */
			function characterList() {
				if (!snap.state || !snap.state.characters) return []
				var ids = Object.keys(snap.state.characters)
				var list = []
				for (var i = 0; i < ids.length; i++) list.push(snap.state.characters[ids[i]])
				list.sort(function (a, b) {
					return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
				})
				return list
			}

			function bindingOf(sessionId) {
				if (!snap.state || !snap.state.sessions || !sessionId) return null
				return snap.state.sessions[sessionId] || null
			}

			function pickCharacter(sessionId) {
				var binding = bindingOf(sessionId)
				var id = binding && binding.characterId
				if (!id || !snap.state || !snap.state.characters[id]) {
					id = snap.state && snap.state.active ? snap.state.active.activeCharacterId : null
				}
				if (id && snap.state && snap.state.characters[id]) return snap.state.characters[id]
				var list = characterList()
				return list.length > 0 ? list[0] : null
			}

			function archiveOf(character, sessionId) {
				if (!character) return null
				var archives = character.archives || []
				var binding = bindingOf(sessionId)
				if (binding && binding.archiveId) {
					for (var i = 0; i < archives.length; i++) {
						if (archives[i].id === binding.archiveId) return archives[i]
					}
				}
				return archives.length > 0 ? archives[0] : null
			}

			/** 卡片副标题：最近一条消息。没有任何档案时为 null。 */
			function previewOf(character) {
				var archives = (character && character.archives) || []
				var latest = null
				for (var i = 0; i < archives.length; i++) {
					if (!latest || String(archives[i].updatedAt || '') > String(latest.updatedAt || '')) latest = archives[i]
				}
				if (!latest || !latest.tail || latest.tail.length === 0) return null
				var tail = latest.tail[latest.tail.length - 1]
				var speaker = tail.speaker || '对方'
				var text = String(tail.text || '').replace(/\s+/g, ' ').trim()
				if (text.length === 0) return null
				return speaker + '：' + text
			}

			function avatarUrlOf(character) {
				if (!character || !character.images) return null
				var url = character.images.avatar || character.images.portrait
				return typeof url === 'string' && url.length > 0 ? url : null
			}

			/** 订阅 store 的 hook（所有座位共用一份）。 */
			function useUi() {
				var pair = React.useState(0)
				var bump = pair[1]
				React.useEffect(function () {
					var onStore = function () { bump(function (n) { return n + 1 }) }
					listeners.add(onStore)
					onStore()
					return function () { listeners.delete(onStore) }
				}, [])
				return snap
			}

			/* ── 启动：第一次读不能把 apply 带走 ─────────────────────────── */
			try {
				applyPalette()
				refresh()
			} catch (e) {
				reportCrash('初次启动', e, 'apply')
			}

			ctx.effect(function () {
				// 一次 1.2 秒的心跳；是否真的去拉由「常规间隔 / 动作后的加速窗口」决定。
				// ui-state.json 里带 base64 图片，不能无脑高频拉。
				var handle = setInterval(function () {
					var now = Date.now()
					if (now < fastUntil || now - lastFetchAt > 4000) {
						try { refresh() } catch (e) { reportCrash('轮询', e, 'interval') }
					}
				}, 1200)
				return function () { clearInterval(handle) }
			}, 'xingye-ui: 轮询 /xingye/api/state')

			/* ══ 通用件 ═════════════════════════════════════════════════════ */

			/** 头像：有图用图，没图用名字首字（设计稿的空态也是这样）。 */
			function Avatar(props) {
				var url = props.url
				var cls = props.className || 'xy-card__avatar'
				if (typeof url === 'string' && url.length > 0) {
					return React.createElement('div', { className: cls },
						React.createElement('img', { src: url, alt: props.alt || '' }))
				}
				return React.createElement('div', { className: cls }, initialOf(props.name))
			}

			function NoticeBar(props) {
				var notice = props.notice
				if (!notice) return null
				return React.createElement('div', {
					className: 'xy-toast' + (notice.kind === 'error' ? ' xy-toast--err' : notice.kind === 'warn' ? ' xy-toast--warn' : ''),
					role: 'status',
				},
					React.createElement('button', {
						className: 'xy-toast__close', type: 'button', 'aria-label': '关闭提示',
						onClick: props.onClose,
					}, '×'),
					notice.text)
			}

			/* ══ 页面 1 · 我的角色（设计稿 角色.html）══════════════════════════ */

			var CharactersPage = safe('我的角色', function (props) {
				var characters = props.characters
				var activeId = props.activeId
				var boundSessionId = props.boundSessionId
				var open = props.open

				if (characters.length === 0) {
					return React.createElement('div', null,
						React.createElement('div', { className: 'xy-empty' },
							React.createElement('div', { className: 'xy-empty__icon' },
								React.createElement(Icon, { name: 'sparkles', size: 30 })),
							'还没有任何角色。',
							React.createElement('br'),
							'点右上角的「＋」建一个，或直接在对话里告诉 星野 你想要谁。'),
						React.createElement('p', { className: 'xy-hint' }, '所有角色仅保存在本地，不会上传或共享。'))
				}

				return React.createElement('div', null,
					React.createElement('div', { className: 'xy-cards' }, characters.map(function (ch) {
						var isActive = ch.id === activeId
						var archives = ch.archives || []
						var preview = previewOf(ch)
						var tag = (ch.tags && ch.tags.length > 0) ? ch.tags[0] : null
						return React.createElement('div', {
							key: ch.id,
							className: 'xy-card' + (isActive ? ' xy-card--on' : ''),
							role: 'button',
							tabIndex: 0,
							onClick: function () { props.onEnter(ch) },
							onKeyDown: function (e) {
								if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onEnter(ch) }
							},
						},
							React.createElement(Avatar, { url: avatarUrlOf(ch), name: ch.name }),
							React.createElement('div', { className: 'xy-card__main' },
								React.createElement('div', { className: 'xy-card__top' },
									React.createElement('h2', { className: 'xy-card__name' }, ch.name),
									tag ? React.createElement('span', { className: 'xy-chip' }, tag) : null),
								React.createElement('p', { className: 'xy-card__desc' },
									preview || (isActive ? '正在聊 · 还没有对话' : '还没有对话'))),
							React.createElement('span', {
								className: 'xy-chip xy-chip--plain xy-chip--btn',
								title: '查看与切换档案',
								role: 'button',
								onClick: function (e) { e.stopPropagation(); props.onOpenArchives(ch) },
							}, archives.length + ' 档案'),
							React.createElement('span', { className: 'xy-chevron' },
								React.createElement(Icon, { name: 'chevron-right', size: 20 })))
					})),
					React.createElement('p', { className: 'xy-hint' }, '所有角色仅保存在本地，不会上传或共享。'),
					boundSessionId ? null : React.createElement('p', { className: 'xy-hint' },
						'当前窗口不是 星野 的会话 —— 这里可以浏览，但点角色不会切过去。'),
					React.createElement('div', { style: { height: 8 } }))
			})

			/* ══ 页面 2 · 创作角色（设计稿 创作角色.html）══════════════════════ */

			var PRESET_TAGS = ['温柔', '傲娇', '毒舌', '元气', '神秘']

			var CreatePage = safe('创作角色', function (props) {
				// 真·文件选择：住在同一个组件里，避免跨座位传 DOM 引用。
				var fileRef = React.useRef(null)
				var namePair = React.useState(''); var name = namePair[0]; var setName = namePair[1]
				var descPair = React.useState(''); var desc = descPair[0]; var setDesc = descPair[1]
				var traitPair = React.useState(''); var trait = traitPair[0]; var setTrait = traitPair[1]
				var greetPair = React.useState(''); var greet = greetPair[0]; var setGreet = greetPair[1]
				var tagsPair = React.useState([]); var tags = tagsPair[0]; var setTags = tagsPair[1]
				var extraPair = React.useState(''); var extra = extraPair[0]; var setExtra = extraPair[1]
				var imgPair = React.useState(null); var image = imgPair[0]; var setImage = imgPair[1]
				var pathPair = React.useState(''); var imagePath = pathPair[0]; var setImagePath = pathPair[1]
				var busyPair = React.useState(false); var busy = busyPair[0]; var setBusy = busyPair[1]

				function toggleTag(t) {
					setTags(function (list) {
						return list.indexOf(t) >= 0 ? list.filter(function (x) { return x !== t }) : list.concat([t])
					})
				}

				function onPickFile(e) {
					var file = e && e.target && e.target.files ? e.target.files[0] : null
					if (!file) return
					try {
						var reader = new FileReader()
						reader.onload = function () {
							setImage({ name: file.name, dataUrl: String(reader.result || '') })
							setImagePath('')
						}
						reader.onerror = function () { props.onNotice('读不出这张图（浏览器拒绝或文件损坏）', 'error') }
						reader.readAsDataURL(file)
					} catch (err) {
						props.onNotice('读图失败：' + ((err && err.message) || err), 'error')
					}
				}

				function submit() {
					var trimmed = name.trim()
					if (trimmed.length === 0) { props.onNotice('先给角色起个名字', 'warn'); return }
					setBusy(true)
					var allTags = tags.concat(extra.split(/[，,、\s]+/).filter(function (s) { return s.length > 0 }))
					var lines = ['请用 xingye_character 新建一个人物，建好后用 xingye_character_switch 切过去，然后按人设开口。', '']
					lines.push('名字：' + trimmed)
					if (allTags.length > 0) lines.push('标签：' + allTags.join(' / '))
					var persona = ['# ' + trimmed]
					if (desc.trim()) persona.push('', '## 简介', desc.trim())
					if (trait.trim()) persona.push('', '## 性格设定', trait.trim())
					if (allTags.length > 0) persona.push('', '## 标签', allTags.join('、'))
					if (greet.trim()) persona.push('', '## 开场白（第一次见面时说这句）', greet.trim())
					lines.push('', '人设文字：', persona.join('\n'))

					var finish = function (stagedPath) {
						if (stagedPath) lines.push('', '立绘图片路径：' + stagedPath + '（用 xingye_character_image 放进 portrait 与 avatar 槽位）')
						if (greet.trim()) lines.push('', '开场白就是上面那一句，请照它开口。')
						lines.push('', '建好之后不要解释过程，直接进入角色。')
						props.onSubmit(lines.join('\n'), function () { setBusy(false) })
					}

					if (image && image.dataUrl) {
						props.onUpload(image.dataUrl, 'avatar').then(function (res) {
							if (res && res.ok) finish(res.path)
							else {
								props.onNotice('头像没能送到本地（' + ((res && res.error) || '未知原因') + '），角色照建，之后把图放进角色目录即可。', 'warn')
								finish(null)
							}
						}).catch(function () { finish(null) })
					} else if (imagePath.trim()) {
						finish(imagePath.trim())
					} else {
						finish(null)
					}
				}

				return React.createElement('div', { className: 'xy-form' },
					React.createElement('input', {
						key: 'file', type: 'file', accept: 'image/*', ref: fileRef,
						className: 'xy-sr', tabIndex: -1, 'aria-hidden': 'true',
						onChange: onPickFile,
					}),
					React.createElement('div', { className: 'xy-form__avatar-row' },
						React.createElement('button', {
							type: 'button', className: 'xy-avatar-pick',
							onClick: function () {
								try { if (fileRef.current) fileRef.current.click() } catch (e) { props.onNotice('打不开文件选择器' , 'error') }
							},
						},
							image && image.dataUrl
								? React.createElement('img', { src: image.dataUrl, alt: '头像预览' })
								: React.createElement('span', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 } },
									React.createElement(Icon, { name: 'camera', size: 28 }),
									React.createElement('span', null, '上传头像'))),
						image && image.dataUrl
							? React.createElement('button', {
								type: 'button',
								className: 'xy-tag xy-tag--add',
								style: { marginTop: 10 },
								onClick: function () { setImage(null) },
							}, '换一张 / 去掉')
							: null),

					React.createElement('div', { className: 'xy-field' },
						React.createElement('label', { className: 'xy-label', htmlFor: 'xy-new-name' }, '角色名称'),
						React.createElement('input', {
							id: 'xy-new-name', className: 'xy-input', type: 'text', value: name,
							placeholder: '给你的角色起个名字',
							onChange: function (e) { setName(e.target.value) },
						})),

					React.createElement('div', { className: 'xy-field' },
						React.createElement('label', { className: 'xy-label', htmlFor: 'xy-new-desc' }, '角色简介'),
						React.createElement('textarea', {
							id: 'xy-new-desc', className: 'xy-area', rows: 3, value: desc,
							placeholder: '简短描述这个角色',
							onChange: function (e) { setDesc(e.target.value) },
						})),

					React.createElement('div', { className: 'xy-field' },
						React.createElement('label', { className: 'xy-label', htmlFor: 'xy-new-trait' }, '性格设定'),
						React.createElement('textarea', {
							id: 'xy-new-trait', className: 'xy-area', rows: 4, value: trait,
							placeholder: '描述性格、语气、说话方式...',
							onChange: function (e) { setTrait(e.target.value) },
						})),

					React.createElement('div', { className: 'xy-field' },
						React.createElement('label', { className: 'xy-label', htmlFor: 'xy-new-greet' }, '开场白'),
						React.createElement('textarea', {
							id: 'xy-new-greet', className: 'xy-area', rows: 2, value: greet,
							placeholder: '角色第一次打招呼会说什么？',
							onChange: function (e) { setGreet(e.target.value) },
						})),

					React.createElement('div', { className: 'xy-field' },
						React.createElement('span', { className: 'xy-label' }, '性格标签'),
						React.createElement('div', { className: 'xy-tags' }, PRESET_TAGS.map(function (t) {
							return React.createElement('button', {
								key: t, type: 'button',
								className: 'xy-tag' + (tags.indexOf(t) >= 0 ? ' xy-tag--on' : ''),
								onClick: function () { toggleTag(t) },
							}, t)
						})),
						React.createElement('input', {
							className: 'xy-input xy-input--sm', type: 'text', value: extra,
							style: { marginTop: 10 },
							placeholder: '还想加别的？逗号分隔，例如：明代、首辅',
							onChange: function (e) { setExtra(e.target.value) },
						})),

					React.createElement('div', { className: 'xy-field' },
						React.createElement('label', { className: 'xy-label', htmlFor: 'xy-new-img' }, '或者直接给图片路径'),
						React.createElement('input', {
							id: 'xy-new-img', className: 'xy-input', type: 'text', value: imagePath,
							placeholder: '例如 D:\\图片\\头像.png（留空也行，以后放文件进角色目录即可）',
							onChange: function (e) { setImagePath(e.target.value) },
						}),
						React.createElement('p', { className: 'xy-sub' }, '头像也可以稍后直接放进角色目录的 avatar.png —— 放文件即成，不需要导入动作。')),

					React.createElement('div', { style: { marginTop: 22 } },
						React.createElement('button', {
							type: 'button', className: 'xy-btn', disabled: busy,
							onClick: submit,
						}, busy ? '正在交给 星野...' : '保存角色'),
						React.createElement('p', { className: 'xy-hint', style: { marginTop: 12 } }, '角色数据仅保存在本地设备。')))
			})

			/* ══ 页面 3 · 我的人设（设计稿 用户人设.html）═════════════════════ */

			var PersonaPage = safe('我的人设', function (props) {
				var personas = props.personas
				var activeId = props.activeId
				var showFormPair = React.useState(false); var showForm = showFormPair[0]; var setShowForm = showFormPair[1]
				var namePair = React.useState(''); var name = namePair[0]; var setName = namePair[1]
				var keyPair = React.useState(''); var keywords = keyPair[0]; var setKeywords = keyPair[1]
				var tonePair = React.useState(''); var tone = tonePair[0]; var setTone = tonePair[1]

				var current = null
				for (var i = 0; i < personas.length; i++) if (personas[i].id === activeId) current = personas[i]

				function submit() {
					var trimmed = name.trim()
					if (trimmed.length === 0) { props.onNotice('先给这套人设起个名字', 'warn'); return }
					var body = ['# ' + trimmed]
					if (keywords.trim()) body.push('', '## 性格关键词', keywords.trim())
					if (tone.trim()) body.push('', '## 常用语气', tone.trim())
					props.onSubmit([
						'用 xingye_user_persona 新建一套用户人设，建好后用 xingye_user_persona_switch 切过去。',
						'',
						'名称：' + trimmed,
						'',
						'人设文字：',
						body.join('\n'),
					].join('\n'))
					setName(''); setKeywords(''); setTone(''); setShowForm(false)
				}

				return React.createElement('div', null,
					React.createElement('div', { className: 'xy-persona-current' },
						current ? React.createElement('div', { className: 'xy-badge' },
							React.createElement(Icon, { name: 'check', size: 12 })) : null,
						React.createElement('div', { className: 'xy-persona-current__orb' }, '我'),
						React.createElement('div', { style: { minWidth: 0, flex: 1 } },
							React.createElement('div', { className: 'xy-persona-current__name' }, current ? current.name : '默认的我'),
							React.createElement('div', { className: 'xy-persona-current__desc' },
								current ? (current.preview || '（这套人设还没有正文）') : '一个喜欢安静聊天的人。'))),

					React.createElement('h2', { className: 'xy-sec' }, '选择人设'),

					personas.length === 0
						? React.createElement('div', { className: 'xy-empty' }, '还没有建过用户人设。', React.createElement('br'), '建一套，「你」在对话里就有名字和性格了。')
						: null,

					personas.map(function (p) {
						var on = p.id === activeId
						return React.createElement('div', {
							key: p.id,
							className: 'xy-pick' + (on ? ' xy-pick--on' : ''),
							role: 'button', tabIndex: 0,
							onClick: function () { props.onPick(p) },
							onKeyDown: function (e) { if (e.key === 'Enter') props.onPick(p) },
						},
							on ? React.createElement('div', { className: 'xy-badge' },
								React.createElement(Icon, { name: 'check', size: 12 })) : null,
							React.createElement('div', { className: 'xy-pick__name' }, p.name),
							React.createElement('div', { className: 'xy-pick__desc' }, p.preview || '（无描述）'))
					}),

					React.createElement('div', {
						className: 'xy-pick' + (activeId ? '' : ' xy-pick--on'),
						role: 'button', tabIndex: 0,
						onClick: function () { props.onClear() },
						onKeyDown: function (e) { if (e.key === 'Enter') props.onClear() },
					},
						activeId ? null : React.createElement('div', { className: 'xy-badge' },
							React.createElement(Icon, { name: 'check', size: 12 })),
						React.createElement('div', { className: 'xy-pick__name' }, '不用人设'),
						React.createElement('div', { className: 'xy-pick__desc' }, '回到默认的「用户」')),

					React.createElement('button', {
						type: 'button', className: 'xy-btn xy-btn--dashed',
						style: { marginTop: 16 },
						'aria-expanded': showForm ? 'true' : 'false',
						onClick: function () { setShowForm(!showForm) },
					},
						React.createElement(Icon, { name: showForm ? 'x' : 'plus', size: 16 }),
						React.createElement('span', null, showForm ? '收起' : '新建人设')),

					showForm ? React.createElement('div', { className: 'xy-form', style: { marginTop: 12 } },
						React.createElement('div', { className: 'xy-field' },
							React.createElement('label', { className: 'xy-label', htmlFor: 'xy-up-name' }, '人设名称'),
							React.createElement('input', {
								id: 'xy-up-name', className: 'xy-input', type: 'text', value: name,
								placeholder: '例如：夜猫子模式',
								onChange: function (e) { setName(e.target.value) },
							})),
						React.createElement('div', { className: 'xy-field' },
							React.createElement('label', { className: 'xy-label', htmlFor: 'xy-up-key' }, '性格关键词'),
							React.createElement('input', {
								id: 'xy-up-key', className: 'xy-input', type: 'text', value: keywords,
								placeholder: '例如：温柔、敏锐',
								onChange: function (e) { setKeywords(e.target.value) },
							})),
						React.createElement('div', { className: 'xy-field' },
							React.createElement('label', { className: 'xy-label', htmlFor: 'xy-up-tone' }, '常用语气'),
							React.createElement('input', {
								id: 'xy-up-tone', className: 'xy-input', type: 'text', value: tone,
								placeholder: '例如：轻松、略带玩笑',
								onChange: function (e) { setTone(e.target.value) },
							})),
						React.createElement('button', { type: 'button', className: 'xy-btn', onClick: submit }, '保存')) : null,

					React.createElement('p', { className: 'xy-hint' }, '人设决定你在对话中的身份，可随时切换。'))
			})

			/* ══ 页面 4 · 档案（设计稿没有，但「一个人物多条档案」是核心能力）══ */

			var ArchivesPage = safe('档案', function (props) {
				var ch = props.character
				if (!ch) return React.createElement('div', { className: 'xy-empty' }, '这个角色已经不存在了。')
				var archives = ch.archives || []
				var newPair = React.useState(''); var title = newPair[0]; var setTitle = newPair[1]
				var delPair = React.useState(false); var confirmDelete = delPair[0]; var setConfirmDelete = delPair[1]
				var persona = String(ch.persona || '').replace(/\s+/g, ' ').trim()

				return React.createElement('div', null,
					React.createElement('div', { className: 'xy-card', style: { cursor: 'default' } },
						React.createElement(Avatar, { url: avatarUrlOf(ch), name: ch.name }),
						React.createElement('div', { className: 'xy-card__main' },
							React.createElement('div', { className: 'xy-card__top' },
								React.createElement('h2', { className: 'xy-card__name' }, ch.name),
								ch.tags && ch.tags.length > 0 ? React.createElement('span', { className: 'xy-chip' }, ch.tags[0]) : null),
							React.createElement('p', { className: 'xy-card__desc' },
								persona.length > 0 ? persona.slice(0, 60) : '（这个人物的还没有人设）'))),

					React.createElement('div', { className: 'xy-btn-row' },
						React.createElement('button', {
							type: 'button', className: 'xy-btn', onClick: function () { props.onEnter(ch) },
						}, '进入对话')),

					React.createElement('h2', { className: 'xy-sec' }, '档案（' + archives.length + '）'),

					archives.length === 0
						? React.createElement('div', { className: 'xy-empty' }, '还没有档案。', React.createElement('br'), '新建一个，或者直接进入对话 —— 第一条消息会自动建「默认档案」。')
						: null,

					archives.map(function (a) {
						var on = a.id === props.activeArchiveId
						return React.createElement('div', {
							key: a.id,
							className: 'xy-arch' + (on ? ' xy-arch--on' : ''),
							role: 'button', tabIndex: 0,
							onClick: function () { props.onSwitchArchive(ch, a) },
							onKeyDown: function (e) { if (e.key === 'Enter') props.onSwitchArchive(ch, a) },
						},
							React.createElement(Icon, { name: 'archive', size: 18, style: { color: on ? 'var(--xy-brand)' : 'var(--xy-ink-3)', flex: '0 0 auto' } }),
							React.createElement('div', { className: 'xy-arch__main' },
								React.createElement('div', { className: 'xy-arch__title' }, a.title),
								React.createElement('div', { className: 'xy-arch__meta' },
									a.messageCount + ' 条对话 · ' + (a.eventCount || 0) + ' 个剧情节点' + (on ? ' · 当前' : ''))),
							on ? React.createElement('span', { className: 'xy-chevron', style: { color: 'var(--xy-brand)' } },
								React.createElement(Icon, { name: 'check', size: 18 })) : null)
					}),

					React.createElement('div', { className: 'xy-form', style: { marginTop: 4 } },
						React.createElement('div', { className: 'xy-field' },
							React.createElement('label', { className: 'xy-label', htmlFor: 'xy-arch-title' }, '新建一条档案线'),
							React.createElement('input', {
								id: 'xy-arch-title', className: 'xy-input', type: 'text', value: title,
								placeholder: '留空就自动编号，例如「档案 2」',
								onChange: function (e) { setTitle(e.target.value) },
							}),
							React.createElement('p', { className: 'xy-sub' }, '每条档案各存各的记录，互不干扰。同一段剧情想重演，就再开一条。')),
						React.createElement('button', {
							type: 'button', className: 'xy-btn xy-btn--ghost',
							onClick: function () { props.onCreateArchive(ch, title.trim()); setTitle('') },
						}, '新建档案')),

					React.createElement('div', { style: { marginTop: 22 } },
						confirmDelete
							? React.createElement('div', null,
								React.createElement('p', { className: 'xy-hint', style: { marginBottom: 10, color: 'var(--xy-error)' } },
									'删除「' + ch.name + '」会连同它的全部档案与对话记录一起移出磁盘，不可撤销。'),
								React.createElement('div', { className: 'xy-btn-row' },
									React.createElement('button', {
										type: 'button', className: 'xy-btn xy-btn--danger',
										onClick: function () { props.onDelete(ch) },
									}, '确认删除'),
									React.createElement('button', {
										type: 'button', className: 'xy-btn xy-btn--ghost',
										onClick: function () { setConfirmDelete(false) },
									}, '算了')))
							: React.createElement('button', {
								type: 'button', className: 'xy-btn xy-btn--ghost',
								onClick: function () { setConfirmDelete(true) },
							}, React.createElement(Icon, { name: 'trash', size: 16 }), React.createElement('span', null, '删除这个人物的全部数据'))))
			})

			/* ══ 导航（3 个 Tab，与设计稿一致）════════════════════════════════ */

			var NAV = [
				['characters', '角色', 'users'],
				['create', '创作', 'plus-circle'],
				['persona', '人设', 'user-circle'],
			]

			function Nav(props) {
				return React.createElement('nav', { className: 'xy-nav', 'aria-label': '星野导航' },
					NAV.map(function (item) {
						var key = item[0]
						var on = props.page === key || (key === 'characters' && props.page === 'archives')
						return React.createElement('button', {
							key: key, type: 'button',
							className: 'xy-nav__item' + (on ? ' xy-nav__item--on' : ''),
							'aria-current': on ? 'page' : undefined,
							// 再点一次当前 Tab = 收起整页回到对话：设计稿的三个 Tab 里
							// 没有「对话」这一项，这是让整页可退出的最小改动。
							onClick: function () { props.onGo(on ? null : key) },
						},
							React.createElement(Icon, { name: item[2], size: 20 }),
							React.createElement('span', null, item[1]))
					}))
			}

			/* ══ 浮层总装（shell.overlay）════════════════════════════════════ */

			/** session 作用域座位能直接拿到 sessionId；拿不到就退回 useSessions。 */
			function sessionIdFrom(props) {
				if (props && props.sessionId) return props.sessionId
				try {
					return props && props.useSessions ? props.useSessions(function (s) { return s.current }) : null
				} catch (e) { return null }
			}

			var Stage = safe('主界面', function (props) {
				var st = useUi()
				var page = st.page
				var currentId = sessionIdFrom(props)

				React.useEffect(function () {
					var ch = pickCharacter(currentId)
					var bg = ch && ch.images ? ch.images.background : null
					try { applyPalette() } catch (e) { reportCrash('配色', e, 'Stage.effect') }
					try { applyBackdrop(typeof bg === 'string' ? bg : null, typeof bg === 'string' && bg.length > 0) } catch (e) { reportCrash('背景层', e, 'Stage.effect') }
					try {
						sendDiag({
							character: ch,
							bg: typeof bg === 'string' ? bg : null,
							bound: !!(currentId && st.state && st.state.sessions && st.state.sessions[currentId]),
							sessionId: currentId,
						})
					} catch (e) { reportCrash('诊断上报', e, 'Stage.effect') }
				})

				var bound = !!(st.state && st.state.sessions && currentId && st.state.sessions[currentId])

				// 全帧浮层会盖在每一个会话上。动作只该落进星野自己的会话里 ——
				// 没有这道闸，用户在别的窗口点一下，指令就会被塞进不相干的对话（真实发生过）。
				var send = function (line) {
					if (!bound) {
						setNotice('这个窗口不是 星野 的会话，动作不会发出去。请切到与 星野 对话的窗口。', 'warn')
						return
					}
					setPage(null)
					sendPrompt(currentId, line).then(function (res) {
						if (res && res.ok === false) setNotice('没送出去：' + ((res.error && res.error.message) || '未知原因'), 'error')
					}).catch(function (err) {
						setNotice('没送出去：' + ((err && err.message) || err), 'error')
					})
				}

				var openUpload = function (dataUrl, kind) {
					return fetch('/xingye/api/upload', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ dataUrl: dataUrl, kind: kind || 'avatar' }),
					}).then(function (res) { return res.json() }).then(function (data) {
						if (data && data.ok) return { ok: true, path: data.value && data.value.path, bytes: data.value && data.value.bytes }
						return { ok: false, error: (data && data.error && data.error.message) || '上传接口不可用' }
					}).catch(function (err) { return { ok: false, error: (err && err.message) || String(err) } })
				}

				var characters = characterList()
				var activeCharacterId = st.state && st.state.active ? st.state.active.activeCharacterId : null
				var activeUserPersonaId = st.state && st.state.active ? st.state.active.activeUserPersonaId : null
				var personas = (st.state && st.state.userPersonas) || []
				var focusCharacter = null
				if (st.focusCharacterId && st.state && st.state.characters) focusCharacter = st.state.characters[st.focusCharacterId] || null

				// Esc 收起整页
				React.useEffect(function () {
					if (!page) return undefined
					var onKey = function (e) { if (e.key === 'Escape') setPage(null) }
					try { document.addEventListener('keydown', onKey) } catch (e) { return undefined }
					return function () { try { document.removeEventListener('keydown', onKey) } catch (e) { /* 无所谓 */ } }
				}, [page])

				var diskVersion = st.state && st.state.clientVersion ? st.state.clientVersion : null
				var stale = diskVersion !== null && diskVersion !== UI_VERSION

				var head = null
				var body = null

				if (page === 'characters') {
					head = React.createElement(React.Fragment, null,
						React.createElement('h1', { className: 'xy-sheet__title' }, '我的角色'),
						React.createElement('button', {
							type: 'button', className: 'xy-round xy-round--ghost', title: '回到对话',
							'aria-label': '回到对话', onClick: function () { setPage(null) },
						}, React.createElement(Icon, { name: 'chevron-down', size: 20 })),
						React.createElement('button', {
							type: 'button', className: 'xy-round xy-round--brand', title: '创建角色',
							'aria-label': '创建角色', onClick: function () { setPage('create') },
						}, React.createElement(Icon, { name: 'plus', size: 20 })))
					body = React.createElement(CharactersPage, {
						characters: characters,
						activeId: activeCharacterId,
						boundSessionId: bound ? currentId : null,
						onEnter: function (ch) {
							if (!bound) { setNotice('这个窗口不是 星野 的会话，切不了角色。', 'warn'); return }
							setPage(null)
							sendPrompt(currentId, '用 xingye_character_switch 切换到人物「' + ch.name + '」，然后顺着那个档案继续，按人设回我一句。')
						},
						onOpenArchives: function (ch) { setPage('archives', ch.id) },
					})
				} else if (page === 'create') {
					head = React.createElement(React.Fragment, null,
						React.createElement('button', {
							type: 'button', className: 'xy-round xy-round--ghost', title: '返回我的角色',
							'aria-label': '返回我的角色', onClick: function () { setPage('characters') },
						}, React.createElement(Icon, { name: 'arrow-left', size: 20 })),
						React.createElement('h1', { className: 'xy-sheet__title xy-sheet__title--center' }, '创作角色'),
						React.createElement('span', { style: { width: 40, flex: '0 0 40px' } }))
					body = React.createElement(CreatePage, {
						onNotice: setNotice,
						onUpload: openUpload,
						onSubmit: function (line, done) {
							send(line)
							if (done) done()
						},
					})
				} else if (page === 'persona') {
					head = React.createElement(React.Fragment, null,
						React.createElement('h1', { className: 'xy-sheet__title' }, '我的人设'),
						React.createElement('button', {
							type: 'button', className: 'xy-round xy-round--ghost', title: '回到对话',
							'aria-label': '回到对话', onClick: function () { setPage(null) },
						}, React.createElement(Icon, { name: 'chevron-down', size: 20 })))
					body = React.createElement(PersonaPage, {
						personas: personas,
						activeId: activeUserPersonaId,
						onNotice: setNotice,
						onPick: function (p) {
							send('用 xingye_user_persona_switch 把我的人设切换到「' + p.name + '」，之后按这套人设理解我。')
						},
						onClear: function () {
							send('用 xingye_user_persona_switch 取消我的人设，回到默认的「用户」。')
						},
						onSubmit: send,
					})
				} else if (page === 'archives') {
					head = React.createElement(React.Fragment, null,
						React.createElement('button', {
							type: 'button', className: 'xy-round xy-round--ghost', title: '返回我的角色',
							'aria-label': '返回我的角色', onClick: function () { setPage('characters') },
						}, React.createElement(Icon, { name: 'arrow-left', size: 20 })),
						React.createElement('h1', { className: 'xy-sheet__title xy-sheet__title--center' }, '档案'),
						React.createElement('span', { style: { width: 40, flex: '0 0 40px' } }))
					body = React.createElement(ArchivesPage, {
						character: focusCharacter,
						activeArchiveId: focusCharacter ? (bindingOf(currentId) || {}).archiveId : null,
						onEnter: function (ch) {
							send('用 xingye_character_switch 切换到人物「' + ch.name + '」，顺着当前档案继续，按人设回我一句。')
						},
						onSwitchArchive: function (ch, a) {
							if (!bound) { setNotice('这个窗口不是 星野 的会话，切不了档案。', 'warn'); return }
							setPage(null)
							sendPrompt(currentId, '用 xingye_archive_switch 切换到「' + ch.name + '」的档案「' + a.title + '」，接着那条线继续，不要重新自我介绍。')
						},
						onCreateArchive: function (ch, title) {
							send('用 xingye_archive 为「' + ch.name + '」新建一个档案' + (title ? '，标题「' + title + '」' : '') + '，建好后切过去。')
						},
						onDelete: function (ch) {
							send('用 xingye_character 的 delete 删除人物「' + ch.name + '」（用户已在界面上二次确认）。')
						},
					})
				}

				var children = [
					React.createElement('style', { key: 'css', 'data-xingye': 'inject', dangerouslySetInnerHTML: { __html: CSS } }),
				]

				if (stale) {
					children.push(React.createElement('div', { key: 'stale', className: 'xy-toast xy-toast--warn' },
						'这个页面跑的还是旧版界面（页面 ' + UI_VERSION + ' / 磁盘 ' + diskVersion + '）。按 Ctrl+Shift+R 强制刷新一次就会更新。'))
				} else if (st.notice) {
					children.push(React.createElement(NoticeBar, {
						key: 'notice', notice: st.notice, onClose: function () { setNotice(null) },
					}))
				}

				if (st.error && !page) {
					children.push(React.createElement('div', { key: 'err', className: 'xy-toast xy-toast--err' }, '星野界面：' + st.error))
				}

				if (page) {
					children.push(React.createElement('div', {
						key: 'scrim', className: 'xy-scrim', onClick: function () { setPage(null) },
					}))
					children.push(React.createElement('section', {
						key: 'sheet', className: 'xy-sheet', role: 'dialog', 'aria-label': head ? undefined : '星野',
					},
						React.createElement('header', { className: 'xy-sheet__head' }, head),
						React.createElement('div', { className: 'xy-sheet__body' }, body)))
					children.push(React.createElement(Nav, { key: 'nav', page: page, onGo: setPage }))
				}

				return React.createElement('div', { className: 'xy-root' }, children)
			})

			/* ══ 对话页头部胶囊（conversation.session.header.utilities）════════ */

			var SessionPill = safe('对话头部', function (props) {
				var st = useUi()
				var sessionId = props && props.sessionId ? props.sessionId : null
				var binding = bindingOf(sessionId)
				var ch = binding && st.state && st.state.characters ? st.state.characters[binding.characterId] : null
				var archive = ch ? archiveOf(ch, sessionId) : null
				var bound = !!binding

				// 只在星野自己的会话里出现：别的会话（比如写代码那个）不该看到这个胶囊。
				if (!bound) return null

				var label = ch ? ch.name : '星野'
				var meta = ch ? (archive ? archive.title + ' · ' + archive.messageCount + ' 条' : '还没开始') : '选个角色开始'

				return React.createElement('button', {
					type: 'button',
					className: 'xy-pill',
					title: '星野 · 角色与档案',
					'aria-label': '打开星野的角色面板',
					onClick: function () { setPage('characters') },
				},
					React.createElement(Avatar, {
						className: 'xy-pill__avatar', url: ch ? avatarUrlOf(ch) : null, name: label,
					}),
					React.createElement('span', { className: 'xy-pill__text' },
						React.createElement('span', { className: 'xy-pill__name' }, label),
						React.createElement('span', { className: 'xy-pill__meta' },
							ch && st.page ? '整页已打开' : meta)),
					React.createElement(Icon, { name: 'chevron-down', size: 14, style: { color: 'var(--xy-ink-3)', flex: '0 0 auto' } }))
			})

			/* ══ 输入条右侧的「+」剧情菜单（conversation.input.right）══════════ */

			var PlusMenu = safe('剧情菜单', function (props) {
				var pair = React.useState(false)
				var open = pair[0]
				var setOpen = pair[1]
				var sessionId = props && props.sessionId ? props.sessionId : null
				var items = [
					['退回上一条，重说', '重说：用 xingye_rewind 的 last-user 退到我上一条消息之前，我要重新说。'],
					['往回退 10 条，重做剧情', '用 xingye_rewind 往回退 10 条，重做这段剧情。'],
					['重启这个档案', '用 xingye_rewind 的 start 重启当前档案，从一开始重演。'],
					['SEP'],
					['看前情提要', '用 xingye_eventbook 的 recap 把当前前情提要给我看。'],
					['列出剧情分支', '用 xingye_branch 列出已放弃的剧情分支。'],
					['撤销最近 5 条', '用 xingye_undo 撤销最近 5 条对话。'],
				]
				var run = function (line) {
					setOpen(false)
					if (!sessionId) return
					sendPrompt(sessionId, line)
				}
				return React.createElement('div', { className: 'xy-plus-wrap' },
					React.createElement('button', {
						type: 'button', className: 'xy-plus', title: '星野 · 剧情工具',
						'aria-label': '剧情工具', 'aria-expanded': open ? 'true' : 'false',
						onClick: function () { setOpen(!open) },
					}, React.createElement(Icon, { name: 'plus', size: 17 })),
					open ? React.createElement('div', { className: 'xy-menu' },
						React.createElement('div', { className: 'xy-menu__head' }, '剧情'),
						items.map(function (item, i) {
							if (item[1] === 'SEP') return React.createElement('div', { key: 'sep' + i, className: 'xy-menu__sep' })
							return React.createElement('button', {
								key: item[0], type: 'button', className: 'xy-menu__item',
								onClick: function () { run(item[1]) },
							}, item[0])
						})) : null)
			})

			/* ══ 气泡（conversation.chat.node 的 user / assistant-step）════════ */

			function findCharacterForSession(sessionId) {
				var binding = bindingOf(sessionId)
				if (binding && snap.state && snap.state.characters && snap.state.characters[binding.characterId]) {
					return snap.state.characters[binding.characterId]
				}
				return pickCharacter(sessionId)
			}

			var UserBubble = safe('用户气泡', function (props) {
				useUi()
				var node = props && props.node
				var data = (node && node.data) || {}
				var text = textOfUserContent(data.content)
				var images = imagesOfUserContent(data.content)
				var time = fmtTime(data.time)

				var imageRow = null
				try {
					if (images.length > 0 && typeof props.renderMessageImages === 'function') {
						imageRow = props.renderMessageImages({ images: images, align: 'end' })
					}
				} catch (e) { reportCrash('用户气泡图片', e, 'renderMessageImages') }

				return React.createElement('div', { className: 'xy-chat xy-chat--out' },
					React.createElement('div', { className: 'xy-chat__bubble' },
						imageRow,
						text.length > 0 ? richNodes(text) : null,
						time ? React.createElement('div', { className: 'xy-chat__note' }, time) : null))
			})

			var AssistantBubble = safe('星野气泡', function (props) {
				var st = useUi()
				var node = props && props.node
				var data = (node && node.data) || {}
				var parts = partsOfAssistantBlocks(data.blocks)
				var running = data.status === 'running'
				var ch = findCharacterForSession(props && props.sessionId)
				var url = ch ? avatarUrlOf(ch) : null
				var name = ch ? ch.name : '星野'

				var imageRow = null
				try {
					if (parts.images.length > 0 && typeof props.renderMessageImages === 'function') {
						imageRow = props.renderMessageImages({ images: parts.images, align: 'start' })
					}
				} catch (e) { reportCrash('星野气泡图片', e, 'renderMessageImages') }

				// 流式阶段可能一个文本块都还没有：给三个点在跳，而不是留一片空白。
				var inner = parts.text.length > 0
					? richNodes(parts.text)
					: (running ? React.createElement('span', { className: 'xy-chat__typing' },
						React.createElement('i', null), React.createElement('i', null), React.createElement('i', null)) : null)

				if (imageRow === null && inner === null) return null

				return React.createElement('div', { className: 'xy-chat xy-chat--in' },
					React.createElement('div', { className: 'xy-chat__avatar' },
						typeof url === 'string' && url.length > 0
							? React.createElement('img', { src: url, alt: name })
							: initialOf(name)),
					React.createElement('div', { className: 'xy-chat__bubble' }, imageRow, inner))
			})

			/* ══ 座位注册：每个单独 try/catch ═══════════════════════════════
			 * 五个注册是顺序执行的，其中一个抛错会直接中断 apply，把后面还没注册的
			 * 一起带走 —— 表现就是「界面什么都没变」，而且看不出是哪一处。
			 * 分开包起来，坏一个只坏一个；失败也写回 Host，不让它只留在控制台。
			 *
			 * **关键**：`ctx.slots.inject(key, cb)` 的 cb 是**由框架在声明就绪时调用**的，
			 * 不是在这里同步调用。所以 `seats.push` 必须放进 cb、并且只在 register
			 * 真的成功之后。早先写在 inject 之后，等于把「inject 没抛错」当成
			 * 「座位注册成功」—— 于是 `conversation.chat.node` 的两条 keyed 注册没落地时，
			 * diag 仍然报「5 个座位都在」。诊断说了假话，比没有诊断更贵。
			 */
			function mount(label, key, register) {
				var fail = function (error) {
					reportCrash('seat:' + label, error, 'ctx.slots.register')
					console.error('[xingye-ui] 注册座位「' + label + '」失败：' + ((error && error.message) || error))
				}
				try {
					return ctx.slots.inject(key, function () {
						try {
							var dispose = register()
							seats.push(label + '@' + key)
							return dispose
						} catch (error) {
							fail(error)
							return function () { /* 注册失败也要给框架一个可释放的返回值 */ }
						}
					})
				} catch (error) {
					fail(error)
					return null
				}
			}

			mount('整页外壳', 'shell.overlay', function () {
				return ctx.slots.register({
					name: 'shell.overlay', id: 'xingye-ui', order: 40,
					label: function () { return '星野' },
				}, Stage)
			})

			mount('对话头部胶囊', 'conversation.session.header.utilities', function () {
				return ctx.slots.register({
					name: 'conversation.session.header.utilities', id: 'xingye-pill', order: 30,
				}, SessionPill)
			})

			mount('剧情菜单', 'conversation.input.right', function () {
				return ctx.slots.register({
					name: 'conversation.input.right', id: 'xingye-plus', order: 40,
				}, PlusMenu)
			})

			// 气泡：接管官方 H5 的同名 keyed 渲染器。工具卡片是另一个 ChatNodeKind，不受影响。
			//
			// 三条硬规矩（每条都是实测换来的）：
			//   1. inject 的第一个参数必须是**座位名本身**，不能写成
			//      `conversation.chat.node:user` 这种「座位 + key」的复合串 ——
			//      inject 内部拿它去 specDynamic(key) 查声明，查不到就**静默等待**、
			//      永不调用回调（不抛错、没日志）。key 只能出现在 register 的选项里。
			//   2. keyed 座位**不能用默认优先级接管**。注册表会直接拒绝：
			//      `keyed slot "…" already has an entry for key "…" at priority 0
			//       (registered by H5) — register at a different priority to shadow it
			//       (lowest renders)`。必须显式给一个更小的 priority。
			//   3. 数值**越小越靠前**（文档原话 "lowest renders"）。这里用 -100，
			//      离 shipped 的 0 足够远，不会被别的插件随手抢走。
			mount('用户气泡', 'conversation.chat.node', function () {
				return ctx.slots.register({ name: 'conversation.chat.node', key: 'user', priority: -100 }, UserBubble)
			})

			mount('星野气泡', 'conversation.chat.node', function () {
				return ctx.slots.register({ name: 'conversation.chat.node', key: 'assistant-step', priority: -100 }, AssistantBubble)
			})

			// 换主题时把配色拉回来：presenter 会在主题快照变化时重写 body.style 上的 token。
			applyPalette()

			/* ── 测试接缝（不属于插件契约）──────────────────────────────────
			 * 组件都声明在 apply() 里，模块顶层看不到；而「注册成功但一个座位都没渲染」
			 * 这类故障在浏览器里只能看到白屏、Host 日志里一个字都没有。
			 * 这里把组件挂到 exports 上，让离线渲染测试能真的渲染一遍。
			 *
			 * 注意：只能**往这个对象上挂属性**，不能给 __testSeam 重新赋值 ——
			 * `exports.__test` 在工厂求值时就已经指向了这个对象，重新赋值会让它指向
			 * 一个新的空对象，测试拿到的一直是 `{}`（一轮白跑就是这么来的）。
			 */
			__testSeam.Stage = Stage
			__testSeam.SessionPill = SessionPill
			__testSeam.PlusMenu = PlusMenu
			__testSeam.UserBubble = UserBubble
			__testSeam.AssistantBubble = AssistantBubble
			__testSeam.CharactersPage = CharactersPage
			__testSeam.CreatePage = CreatePage
			__testSeam.PersonaPage = PersonaPage
			__testSeam.ArchivesPage = ArchivesPage
			__testSeam.Nav = Nav
			__testSeam.CrashBoundary = CrashBoundary
			__testSeam.Icon = Icon
			__testSeam.richNodes = richNodes
			__testSeam.readState = function () { return snap.state }
			__testSeam.readError = function () { return snap.error }
			__testSeam.readPage = function () { return snap.page }
			__testSeam.setPage = setPage
			__testSeam.setNotice = setNotice
			__testSeam.refresh = refresh
			__testSeam.applyPalette = applyPalette
			__testSeam.applyBackdrop = applyBackdrop
			__testSeam.UI_VERSION = UI_VERSION
			__testSeam.CSS = CSS
		}

		exports.apply = apply
		exports.inject = ['slots']
		exports.name = 'xingye-ui'

		var __testSeam = {}
		exports.__test = __testSeam

		return module.exports
	},
})

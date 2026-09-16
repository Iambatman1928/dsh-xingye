# 星野 · DSH 聊天 Agent

[English](README.md) | 中文

[![test](https://github.com/Iambatman1928/dsh-xingye/actions/workflows/ci.yml/badge.svg)](https://github.com/Iambatman1928/dsh-xingye/actions/workflows/ci.yml)

星野把 **DeepSeek Harness 的一个会话整体改造成聊天 agent**：装上之后新开一个会话、agent preset 选「星野」，
你面对的就是星野本人。在她的会话里，你可以新建别的智能体（人物）、给他们写人设、为同一个人物开多条档案线分别聊天，
也可以给自己准备多套人设随时切换。**所有内容都存在这台电脑上**，不经过任何服务器。

<p align="center">
  <b>我的角色</b> · <b>创作角色</b> · <b>我的人设</b> · <b>对话</b> · <b>档案</b>
</p>

## 安装

```sh
dsh plugin --profile web add dsh-xingye
```

装完 **重启 DSH**，然后：

1. 打开 **设置 → 插件**，确认 `dsh-xingye` 在列表里；
2. **新开一个会话**，agent preset 选 **星野** —— 这一步不能省，preset 决定这个会话的身份和工具；
3. 直接说话就行。星野会以出厂人设迎接你。

会话头部右上角有一个**人物胶囊**（头像 + 名字 + 当前档案）—— 点它打开「我的角色」整页。
那里能建角色、切人物、管档案、换你自己的人设。

> **为什么装插件的命令就够，却还要选 preset？**
> DSH 的 agent preset 只能靠**文件系统发现**，没有任何插件注册接口 —— 所以这个包在首次加载时会
> 把随包的 preset 复制到 `<DSH_HOME>/.agent-presets/xingye/`（`$DSH_HOME` 默认 `~/.dsh`）。
> 这一步**只在目标缺失时发生**，不会覆盖你已经改过的 preset，日志里会写明它做了什么。
> 不想让它自动写的话，把这个插件行的配置改成 `installPreset: false`，然后手工复制
> `node_modules/dsh-xingye/preset/` 到 `~/.dsh/.agent-presets/xingye/`。

从源码安装：

```sh
dsh plugin --profile web add 'github:Iambatman1928/dsh-xingye'
```

## 界面

按四张设计稿做的，色值、圆角、间距、阴影都是照抄的（暖白 `#fffbf7`、品牌紫 `#8b5cf6`、
卡片 16px 圆角、头像 56px、导航 64px）。五个页面：

| 页面 | 从哪进 | 能做什么 |
|---|---|---|
| **我的角色** | 点会话头部的人物胶囊 | 一行一个角色卡：头像 / 名字 / 标签 / 最近一句；点卡片＝切过去开聊；点右侧「N 档案」进档案页；右上「＋」去创作 |
| **创作角色** | 我的角色 → 右上「＋」 | 上传头像、名称、简介、性格设定、开场白、性格标签；保存后星野真的把人物建出来并按开场白开口 |
| **我的人设** | 底部导航「人设」 | 当前人设卡 + 可选列表（带勾选角标）；新建人设；「不用人设」 |
| **对话** | 关掉整页即是 | 头像 + 白色左侧气泡（星野）／紫色右侧气泡（你）；输入条右侧的「＋」是剧情工具（重说 / 回溯 / 重启 / 前情提要 / 撤销） |
| **档案** | 角色卡上的「N 档案」 | 一个人物的多条会话线：切过去接着聊、新建一条、删除人物（两次确认） |

**怎么退出整页**：再点一次当前 Tab、按 Esc、点和平板／桌面上的遮罩、或用头部的「⌄」按钮。

**多端适配**：手机（<720px）整页铺满 + 底部通栏导航；平板（≥720px）居中卡片 + 悬浮胶囊导航；
桌面（≥980px）卡片加宽、角色列表变双列网格。另外含安全区（刘海屏）、`prefers-reduced-motion`
动效降级，以及跟随 DSH 深浅主题的两套配色。

## 能做哪些事

直接说人话即可，不需要记命令。

**新建智能体 + 人设**

- 「新建一个人物，叫林砚，人设我在 `D:\人设\林砚.md`」（导入 md / txt 文件）
- 「建个叫小满的人物，十六岁，话多，喜欢用『诶』开头」（直接输入文字）
- 「把林砚的人设换成这个：……」／「改名叫林砚之」／「删掉小满」
- 「我有个文件夹里全是人设，先看看有哪些」（会先扫一遍再让你挑）

**对话**

- 直接聊。人物人设、用户人设、当前档案会在每一步自动进上下文，星野就是这个人物。
- 「我们之前聊了什么？」／「翻一下前面」（回溯本地保存的原文）

**撤销最近 30 条**

- 「撤销最近 5 条」／「刚才那几句不算，撤掉」
- 撤销会把当前档案的本地记录真正回滚，被撤掉的内容进回收站，说「恢复刚才撤掉的」就能拿回来。
- 上限就是 30 条，这是硬限制，要更多星野会如实告诉你。

**多条档案（一个人物可以有很多条会话线）**

- 「再开一个档案，叫『另一个夜晚』」／「列出林砚的所有档案」／「切到『初次相遇』那个档案」
- 每个档案各存各的记录，互不干扰。换回旧档案时，星野会接上那条线继续，而不是重新自我介绍。
- **新开一个会话 = 给当前人物另起一条档案线**：新会话会继承你上次用的人物和用户人设，但档案从空白开始，
  发出第一条消息时自动建成「档案 2」「档案 3」……想接着旧档案聊，说「切到『初次相遇』那个档案」。
- 同一个会话重开后会自动接回它自己那条档案（按会话 id 绑定）。

**用户自己的人设**

- 「给我建一套人设叫『旅人』，内容是……」／「导入 `D:\人设\我自己.txt`」
- 「切换到『同事小林』」／「取消用户人设」

**改剧本（回溯与分支）**

- 「重说」／「刚才那句不算」／「回到 XX 之前」／「重来」
- 剪掉的剧情会存成**分支**，反悔时说「接回刚才那条分支」就能拿回来。

**记忆**

- **事件簿**：剧情节点 / 场景 / 细节 / 偏好 / 备注五类，带回溯锚点，以「前情提要」小节进上下文，
  每一步重读 —— 所以刚记下的节点、刚被撤销作废的节点，下一次模型调用立刻反映出来。
- **记忆图片**：`xingye_memory_image` 生成图片、`xingye_character_image` 管角色的头像 / 立绘 / 背景。
  DSH 自身没有图像生成能力，出图由插件调你自己的 OpenAI 兼容接口；**没配 key 也不报错**，
  退化成「只存绘图提示词」。用户在对话里贴的图会自动归档进画廊。

**控制占用**

- 对话原文默认留最近 400 条，更早的会被压成梗概后删除原文；超过 30 天的同样处理，
  但**最近 30 条永远保留原文**（撤销和回溯要用）。
- 「清理一下」可以手动触发；「现在占多少」会给出目录、条数、体积。

## 数据放在哪

默认 `<DSH_HOME>/xingye-data/`（`$DSH_HOME` 默认 `~/.dsh`）：

```
xingye-data/
  index.json                     全局默认：上次用的人物 / 档案 / 用户人设
  config.json                    保留策略（可手工改）
  sessions.json                  会话 id → 人物 / 档案 / 用户人设 的绑定
  ui-state.json                  界面读的快照（由插件写，别手改）
  characters/<人物>/
    character.json
    persona.md                   人设正文
    source/                      导入文件的原始副本
    avatar.* portrait.* background.*   角色形象（放文件即成）
    archives/<档案>/
      archive.json
      messages.jsonl             对话原文，回溯与撤销的数据源
      summary.md                 定期清理后旧对话的梗概
      trash.jsonl                被撤销的内容（可恢复）
      eventbook.jsonl            事件簿
      branches/<分支>.json       被剪掉的剧情
  user-personas/<人设>/
    persona.json
    persona.md
```

想备份就整个复制 `xingye-data`；想清空就从空目录重来。

**数据根目录改法**：这个包的 `cordis.patch.yml` 与 agent preset 的行配置各有一个 `dataRoot`，
**留空时两边都落到 `<DSH_HOME>/xingye-data`**。要挪目录就得两处都写，否则界面读的是另一份数据。

## 出图服务（可选）

在 agent preset 行里配一个 OpenAI 兼容端点：

```yaml
- id: xingye
  name: './plugin/index.js'
  config:
    image:
      baseURL: 'https://your-endpoint/v1'
      apiKeyEnv: 'YOUR_API_KEY_ENV'
      model: 'your-image-model'
      size: '1024x1024'
```

`model` 留空就只存提示词不出图。key 从环境变量读，不落盘。

## 已知限制（重要，别被「撤销」两个字骗了）

DSH 的会话记录是 **只追加、不可改写** 的：没有删除、截断或回退历史事件的接口，
磁盘上的 `session.jsonl.zstd` 也没有删除路径。

所以「撤销最近 30 条」的准确语义是：

- **本地档案的记录被真正回滚** —— 这是星野自己的数据，删了就是删了（且可恢复）。
- **模型收到一份明确的作废声明** —— 撤销工具的结果会留在对话里，告诉星野那几条作废、不要引用、等用户重新说。
- 但 **DSH 会话日志里那几条原始事件仍然存在**（只是从这一轮起被宣告无效）。

其余限制：

- **agent preset 必须选对**。在别的 preset 的会话里，界面能看，但动作发不进去（星野的工具不在那个会话里）。
- **界面是全帧浮层**，会盖在每一个会话上。未绑定到星野会话时，面板照常可看，但按钮不发指令，
  并在顶部写明原因 —— 这是刻意的，免得把「用某某人设」这类指令塞进不相干的会话。
- **改了 `client.js` 要重新加载页面**，改了 Host 半（`index.js`）要重启 DSH。

## 结构

```
dsh-xingye/
├─ index.js             Host 半：/xingye/api 路由 + 落 preset
├─ client.js            Client 半：四个整页 + 人物胶囊 + 剧情菜单
├─ cordis.patch.yml     bundle patch（把插件注册进 profile）
├─ preset/              随包发行的 agent preset `xingye`
│   ├─ agent.cordis.yml 会话组合：身份 + 工具清单
│   ├─ preset.yml       显示名与简介
│   └─ plugin/          17 个 xingye_* 工具（零依赖，只用 node: 内建模块）
└─ tools/               三套离线测试
```

两半的分工：**preset 那半是后端**（人物 / 档案 / 撤销 / 事件簿，全在 agent 平面上），
**profile 插件那半是前端**（界面 + 一个把界面动作送进会话的本地路由）。界面不重复实现业务逻辑，
只有一份真相 —— 这是为什么 `preset/plugin/` 里的代码**只允许 import `node:` 内建模块**：
预设目录不在部署包的 `node_modules` 解析链上。

## 开发

```sh
node tools/verify.mjs                  # preset 插件全流程（假 ctx，不需要 DSH）
node tools/preset-install-test.mjs     # 随包 preset 的落盘行为（临时 DSH_HOME，不碰你的 ~/.dsh）
node tools/ui-client-render-test.mjs   # Client 半离线渲染（真 React + 迷你运行时跑 effect）
node tools/ui-host-route-test.mjs      # Host 半路由（假 req/res）
```

界面测试默认从本仓库根读 `client.js`，从 `~/.dsh/profiles/*/node_modules` 之类的地方找 React。
要指到别处就传参数：`node tools/ui-client-render-test.mjs <插件目录> <react 所在 node_modules>`。

## 许可

MIT。与 DeepSeek 官方无隶属关系。

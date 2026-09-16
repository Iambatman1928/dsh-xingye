/**
 * 星野 · 记忆图片
 *
 * DSH 本身**没有**图像生成能力（全树搜不到 images/generations、outputModalities 之类；
 * 助手侧图像输出还会被适配器显式拒绝）。所以出图这件事只能由插件自己做：
 *
 *   1. 用 Node 的全局 fetch 调一个 OpenAI 兼容的 `POST {baseURL}/images/generations`
 *   2. 把拿到的字节交给 `ctx.attachments.saveImage()` 换成持久 ref
 *   3. `output.render` 把 ref 以 `{ type:'image', attachment }` 块返回
 *      —— 工具结果是 user 角色消息，既满足浏览器的 attachment 授权检查，
 *      又不会触发「助手消息不能带图」的适配器硬报错。这是唯一稳妥的挂载点。
 *
 * 没配 key 时不报错：退化成「只生成绘图提示词」，照样把 prompt 存进画廊，
 * 用户拿去别处出图也不亏。
 */

/** 统一的美术方向 —— 对上用户要的「深色插画、柔焦光影、星光氛围」 */
const STYLE_SUFFIX =
  '。插画风格，深色主调，柔和焦外光影，细碎星光点缀，情绪化氛围，电影感构图，高质量，注意留出人物与背景的层次'

const ALLOWED_MEDIA = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** 按 magic bytes 认图片类型 —— 有些 API 返回的 content-type 不可信 */
function sniffMediaType(bytes) {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes.length > 12 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp'
  if (bytes.length > 3 && bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif'
  return null
}

function extOf(mediaType) {
  return { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mediaType] ?? 'png'
}

/** 这个配置能不能真的出图 */
export function imageProviderReady(config) {
  return Boolean(config?.baseURL && config?.model && resolveKey(config))
}

function resolveKey(config) {
  if (config?.apiKey) return config.apiKey
  if (config?.apiKeyEnv && process.env[config.apiKeyEnv]) return process.env[config.apiKeyEnv]
  return null
}

/** 拼出图提示词：人物气质 + 剧情节点 + 统一美术方向 */
export function buildImagePrompt({ characterName, persona, eventTitle, eventText, description }) {
  const parts = []
  if (characterName) parts.push(`角色：${characterName}`)
  if (persona) parts.push(`人物设定（提炼气质，不要照抄）：${persona.replace(/\s+/g, ' ').slice(0, 300)}`)
  if (eventTitle) parts.push(`画面主题：${eventTitle}`)
  if (eventText) parts.push(`画面内容：${eventText.replace(/\s+/g, ' ').slice(0, 400)}`)
  if (description) parts.push(`补充要求：${description}`)
  parts.push('不要出现文字、水印、对话框')
  return parts.join('\n') + STYLE_SUFFIX
}

/**
 * 调外部图像 API 拿一张图。
 * 兼容 `data[0].b64_json` 与 `data[0].url` 两种返回形态。
 */
export async function requestImage(config, prompt, { signal } = {}) {
  const key = resolveKey(config)
  if (!key) throw new Error(`没有找到图像 API key（看了 config.image.apiKey 与环境变量 ${config?.apiKeyEnv ?? '(未指定)'}）`)
  const base = String(config.baseURL).replace(/\/+$/, '')
  const url = `${base}${config.path ?? '/images/generations'}`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: config.model,
      prompt,
      n: 1,
      size: config.size ?? '1024x1024',
      response_format: 'b64_json',
      ...(config.extra ?? {}),
    }),
    signal,
  })

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`图像 API 返回 ${response.status}：${detail.slice(0, 300)}`)
  }

  const payload = await response.json().catch(() => null)
  const item = payload?.data?.[0]
  if (!item) throw new Error(`图像 API 返回里没有 data[0]：${JSON.stringify(payload).slice(0, 300)}`)

  let bytes
  let mediaType
  if (typeof item.b64_json === 'string') {
    bytes = Buffer.from(item.b64_json, 'base64')
    mediaType = sniffMediaType(bytes) ?? 'image/png'
  } else if (typeof item.url === 'string') {
    const image = await fetch(item.url, { signal })
    if (!image.ok) throw new Error(`下载生成的图片失败：${image.status}`)
    bytes = Buffer.from(await image.arrayBuffer())
    const header = image.headers.get('content-type')?.split(';')[0]?.trim()
    mediaType = (header && ALLOWED_MEDIA.includes(header) ? header : null) ?? sniffMediaType(bytes) ?? 'image/jpeg'
  } else {
    throw new Error('图像 API 的返回既不认识 b64_json 也不认识 url')
  }

  if (!ALLOWED_MEDIA.includes(mediaType)) {
    throw new Error(`图像格式不受支持：${mediaType}（只接受 png / jpeg / webp / gif）`)
  }
  return { bytes, mediaType, ext: extOf(mediaType) }
}

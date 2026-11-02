/** DeepSeek 网页版 —— 整个应用唯一的「引擎」所在地 */
export const DEEPSEEK_HOST = 'chat.deepseek.com'
export const DEEPSEEK_ORIGIN = `https://${DEEPSEEK_HOST}`
export const DEEPSEEK_URL = `${DEEPSEEK_ORIGIN}/`

/** 持久化分区：主窗口与快捷窗口共享同一份登录态（产品说明书 §8） */
export const SESSION_PARTITION = 'persist:deepseek'

/** 自绘标题栏高度 */
export const TITLEBAR_HEIGHT = 44

/**
 * 允许在应用内部打开的第三方域。
 * 目前只有第三方登录会用到（DeepSeek 登录页提供 Apple 账号登录）。
 * 其余一律交给系统浏览器，避免把 DeepSeek 页面导航走。
 */
export const IN_APP_AUTH_HOSTS: readonly string[] = ['appleid.apple.com', 'idmsa.apple.com']

// ── 快捷窗口（数值全部取自设计稿）────────────────────────────────

/** 空态宽度。设计稿：快捷框 400×100 */
export const QUICK_WINDOW_WIDTH = 400

/** 空态初始高度 */
export const QUICK_WINDOW_MIN_HEIGHT = 100

/** 设计稿：「输入框和外框会向上变高，最高变为初始高度的 2 倍」 */
export const QUICK_WINDOW_MAX_HEIGHT = 200

/** 快捷窗口圆角 */
export const QUICK_WINDOW_CORNER_RADIUS = 17

// ── 快捷窗口「有内容」状态（设计稿：快捷窗口-有内容）─────────────

/** 有内容态：默认 420×500，可拖拽放大（设计稿是 716，按实际使用调小了） */
export const QUICK_WINDOW_CONTENT_WIDTH = 420
export const QUICK_WINDOW_CONTENT_MIN_HEIGHT = 500

/** 设计稿：顶部功能栏 420×50，鼠标移入才出现，移出 2 秒后隐藏 */
export const QUICK_TOPBAR_HEIGHT = 50
export const QUICK_TOPBAR_HIDE_DELAY = 2000

/**
 * 默认呼出快捷键。
 * 设计稿写的就是 ⌥ Space。产品说明书里写的 ⌘ Space 在 macOS 上
 * 根本注册不上（被 Spotlight 独占），所以一切以设计稿为准。
 */
export const DEFAULT_QUICK_HOTKEY = 'Alt+Space'

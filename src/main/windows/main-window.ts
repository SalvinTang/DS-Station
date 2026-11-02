import { BaseWindow, WebContentsView, nativeTheme, type Event } from 'electron'
import { join } from 'node:path'
import { DEEPSEEK_URL, TITLEBAR_HEIGHT } from '../../shared/constants'
import { isQuitting } from '../app-state'
import { getDeepseekSession, openInBrowser, shouldNavigateInApp } from '../session'
import { load, save, type WindowState } from '../settings'

/**
 * 主窗口 = BaseWindow + 两个 WebContentsView
 *
 *   ┌──────────────────────────────┐
 *   │ ● ● ●              [齿轮]     │  ← titlebarView（自绘，44px）
 *   ├──────────────────────────────┤
 *   │                              │
 *   │      DeepSeek 网页版          │  ← pageView（引擎，永不销毁）
 *   │                              │
 *   └──────────────────────────────┘
 *
 * 为什么用 BaseWindow 而不是 BrowserWindow：
 * 快捷窗口要复用 pageView 里的这个网页实例（决策 D1），
 * 而 BrowserWindow 自带的 webContents 无法在窗口之间搬运。
 * 这个决定必须在脚手架阶段定下来，后改代价很大。
 */

const MIN_WIDTH = 760
const MIN_HEIGHT = 520
const BOUNDS_SAVE_DELAY = 400
/**
 * 窗口刚创建时，macOS 会补发一次尺寸/位置事件，数值不可信
 * （实测会把 1280 宽的窗口记成 857）。稳定之前不记录。
 */
const BOUNDS_SETTLE_DELAY = 1500
const ERR_ABORTED = -3

/** 兜底：修掉配置里明显不合理的尺寸，避免一次脏值永久污染窗口大小 */
function sanitizeWindowState(state: WindowState): WindowState {
  return {
    width: Math.max(MIN_WIDTH, Math.round(state.width) || 0),
    height: Math.max(MIN_HEIGHT, Math.round(state.height) || 0),
    x: state.x,
    y: state.y,
  }
}

export class MainWindow {
  readonly window: BaseWindow

  /** DeepSeek 网页视图 —— 快捷窗口后续要读它、驱动它 */
  readonly pageView: WebContentsView

  private readonly titlebarView: WebContentsView
  private boundsTimer: NodeJS.Timeout | null = null
  private readyForPersist = false

  constructor() {
    const savedWindow = sanitizeWindowState(load().window)
    const dark = nativeTheme.shouldUseDarkColors

    this.window = new BaseWindow({
      width: savedWindow.width,
      height: savedWindow.height,
      x: savedWindow.x,
      y: savedWindow.y,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      title: 'DS Desktop',
      // hiddenInset：保留系统红绿灯，但让出顶部空间给我们自绘的标题栏
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 15 },
      backgroundColor: dark ? '#1b1c20' : '#ffffff',
    })

    this.pageView = this.createPageView()
    this.titlebarView = this.createTitlebarView()

    // 先加网页视图、再加标题栏，保证标题栏在 z 序最上
    this.window.contentView.addChildView(this.pageView)
    this.window.contentView.addChildView(this.titlebarView)

    this.attachNavigationGuards()

    this.window.on('resize', () => this.layout())
    this.window.on('resized', () => this.persistBounds())
    this.window.on('moved', () => this.persistBounds())

    // 决策 D3：点红绿灯「关闭」只是隐藏窗口，DeepSeek 网页必须留着
    this.window.on('close', (event: Event) => {
      if (!isQuitting()) {
        event.preventDefault()
        this.window.hide()
      }
    })

    this.window.on('closed', () => {
      if (this.boundsTimer) clearTimeout(this.boundsTimer)
    })

    this.layout()

    // 等窗口稳定下来再开始记录尺寸/位置
    setTimeout(() => {
      this.readyForPersist = true
    }, BOUNDS_SETTLE_DELAY)
  }

  get isVisible(): boolean {
    return !this.window.isDestroyed() && this.window.isVisible()
  }

  show(): void {
    if (this.window.isDestroyed()) return
    this.window.show()
    this.window.focus()
  }

  // ── 内部 ────────────────────────────────────────────────────────

  private createPageView(): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        session: getDeepseekSession(),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        // 刻意不设 preload：远程页面不该拿到任何本地能力
      },
    })
    view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1b1c20' : '#ffffff')
    this.logLifecycle(view, 'DeepSeek')
    void view.webContents.loadURL(DEEPSEEK_URL)
    return view
  }

  private createTitlebarView(): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    this.logLifecycle(view, '标题栏')
    void view.webContents.loadFile(join(__dirname, '../renderer/titlebar/index.html'))
    return view
  }

  private attachNavigationGuards(): void {
    const wc = this.pageView.webContents

    // 新开窗口（target=_blank、window.open）：
    // 站内与第三方登录域放行，其余交给系统浏览器
    wc.setWindowOpenHandler(({ url }) => {
      if (shouldNavigateInApp(url)) return { action: 'allow' }
      openInBrowser(url)
      return { action: 'deny' }
    })

    // 同标签导航：AI 回答里的外链不应该把应用导航走
    wc.on('will-navigate', (event, url) => {
      if (!shouldNavigateInApp(url)) {
        event.preventDefault()
        openInBrowser(url)
      }
    })

    wc.on('render-process-gone', (_event, details) => {
      console.error('[主窗口] DeepSeek 渲染进程退出:', details.reason)
    })
  }

  /** 加载生命周期日志：出问题时能一眼看出是哪个视图没起来 */
  private logLifecycle(view: WebContentsView, label: string): void {
    const wc = view.webContents
    wc.on('did-finish-load', () => {
      console.log(`[${label}] 加载完成: ${wc.getURL()}`)
      if (label === 'DeepSeek') {
        const [width, height] = this.window.getContentSize()
        console.log(
          `[主窗口] 尺寸 ${width}×${height}，标题栏 ${TITLEBAR_HEIGHT}px，网页区 ${height - TITLEBAR_HEIGHT}px`,
        )
      }
    })
    wc.on('did-fail-load', (_event, code, description, url) => {
      if (code === ERR_ABORTED) return // 用户主动中断，属正常
      console.error(`[${label}] 加载失败 ${code} ${description} ${url}`)
    })
  }

  private layout(): void {
    if (this.window.isDestroyed()) return
    const [width, height] = this.window.getContentSize()

    this.titlebarView.setBounds({ x: 0, y: 0, width, height: TITLEBAR_HEIGHT })
    this.pageView.setBounds({
      x: 0,
      y: TITLEBAR_HEIGHT,
      width,
      height: Math.max(0, height - TITLEBAR_HEIGHT),
    })
  }

  private persistBounds(): void {
    if (!this.readyForPersist) return
    if (this.boundsTimer) clearTimeout(this.boundsTimer)
    this.boundsTimer = setTimeout(() => {
      if (this.window.isDestroyed()) return
      const { width, height, x, y } = this.window.getBounds()
      save({ window: { width, height, x, y } })
    }, BOUNDS_SAVE_DELAY)
  }
}

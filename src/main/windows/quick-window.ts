import { BrowserWindow, app, nativeTheme, screen } from 'electron'
import { join } from 'node:path'
import {
  QUICK_WINDOW_CONTENT_MIN_HEIGHT,
  QUICK_WINDOW_CONTENT_WIDTH,
  QUICK_WINDOW_MAX_HEIGHT,
  QUICK_WINDOW_MIN_HEIGHT,
  QUICK_WINDOW_WIDTH,
} from '../../shared/constants'
import { load } from '../settings'
import type { QuickEvent, QuickMode } from '../../shared/types'

/**
 * 快捷窗口。
 *
 * 两种形态（设计稿）：空态 400×(100~200)，有内容态 420×716 起、可缩放。
 * 这是一个**纯自绘界面**，不是嵌进去的第二个 DeepSeek 网页（决策 D1）——
 * 它自己不跟 DeepSeek 说话，一切由主进程驱动主窗口那个网页完成。
 */

const THEMED_BG = { light: '#ffffff', dark: '#2c2c2e' } as const

/** 空态距屏幕顶部的位置（设计稿要求「居中或接近屏幕顶部」）*/
const TOP_RATIO = 0.18

/** 有内容态四周留白 */
const CONTENT_MARGIN = 40

export class QuickWindow {
  readonly window: BrowserWindow

  /**
   * 底边固定：输入变长时只把顶边上移，视觉上「向上长高」（设计稿原话）。
   * 该高度**跨隐藏/唤出保留** —— 用户输入到一半收起面板，
   * 再唤出时应该还是那么高，而不是缩回初始尺寸。
   */
  private bottomY = 0
  private currentHeight = QUICK_WINDOW_MIN_HEIGHT
  private visible = false
  private mode: QuickMode = 'empty'

  /** 上次收起面板的时刻，用来实现设计稿的「重置为新聊天」 */
  private lastHiddenAt = 0

  constructor(
    private readonly isMainWindowVisible: () => boolean,
    /** 距上次关闭太久时调用：让 DeepSeek 开一个新对话 */
    private readonly onResetToNewChat: () => void,
  ) {
    this.window = new BrowserWindow({
      width: QUICK_WINDOW_WIDTH,
      height: QUICK_WINDOW_MIN_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      roundedCorners: true,
      hasShadow: true,
      backgroundColor: this.bg(),
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    // 盖在全屏应用之上、跟随所有工作区
    this.window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    this.window.setAlwaysOnTop(true, 'floating')

    void this.window.loadFile(join(__dirname, '../renderer/quick/index.html'))

    this.window.webContents.on('did-finish-load', () => {
      console.log('[快捷窗口] 界面就绪')
    })
    this.window.webContents.on('did-fail-load', (_event, code, description) => {
      if (code === -3) return
      console.error(`[快捷窗口] 界面加载失败 ${code} ${description}`)
    })

    /*
     * 刻意**不监听 blur**（决策 D6）。
     * 产品说明书 §7 原本写了「点击外部区域可隐藏」，但实际用起来很糟：
     * 用户打到一半想点别处看一眼，面板就没了。收起只走三条路 ——
     * ⌥Space 切换、Esc、顶栏关闭按钮。
     */

    // 用户拖动窗口后，底边位置变了，长高的基准也要跟着变
    this.window.on('move', () => {
      const bounds = this.window.getBounds()
      this.bottomY = bounds.y + bounds.height
    })

    nativeTheme.on('updated', () => {
      this.window.setBackgroundColor(this.bg())
    })
  }

  get isVisible(): boolean {
    return this.visible
  }

  get currentMode(): QuickMode {
    return this.mode
  }

  toggle(): void {
    if (this.visible) this.hide()
    else this.show()
  }

  show(): void {
    this.applyResetRule()
    this.positionOnShow()
    this.window.show()
    this.window.focus()
    this.visible = true

    const { x, y, width, height } = this.window.getBounds()
    console.log(`[快捷窗口] 显示于 (${x}, ${y})，尺寸 ${width}×${height}（${this.mode}）`)

    // 让界面按「输入框里还剩多少个字」重新量一次高度，
    // 并把焦点收回输入框。我们记的高度只是近似，依据永远是内容本身。
    this.send('ds:quick-shown')
  }

  hide(): void {
    if (!this.visible) return
    this.visible = false
    this.lastHiddenAt = Date.now()
    this.window.hide()
    console.log('[快捷窗口] 已隐藏')

    // 焦点交还：主窗口没在显示，说明用户是在别的 App 里唤出的面板，
    // 那就把整个应用隐藏掉，macOS 会把焦点还给上一个 App。
    // （不用 AppleScript 去 activate，那会触发「自动化」权限申请，体验很差。）
    if (!this.isMainWindowVisible()) {
      app.hide()
    }
  }

  /** 空态下输入折行时向上长高，夹在 100–200 之间 */
  applyHeight(height: number): void {
    if (this.mode !== 'empty') return

    const next = Math.max(
      QUICK_WINDOW_MIN_HEIGHT,
      Math.min(QUICK_WINDOW_MAX_HEIGHT, Math.round(height)),
    )
    if (next === this.currentHeight) return

    this.currentHeight = next
    this.window.setBounds({
      x: this.window.getBounds().x,
      y: this.bottomY - next,
      width: QUICK_WINDOW_WIDTH,
      height: next,
    })
  }

  /** 切换空态 ↔ 有内容态 */
  setMode(mode: QuickMode): void {
    if (mode === this.mode) return
    this.mode = mode

    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const area = display.workArea

    if (mode === 'content') {
      // 有内容态：撑开到 420×716，四周留白，垂直方向尽量居中
      const height = Math.min(
        QUICK_WINDOW_CONTENT_MIN_HEIGHT,
        Math.max(QUICK_WINDOW_MIN_HEIGHT, area.height - CONTENT_MARGIN * 2),
      )
      this.currentHeight = height
      this.bottomY = area.y + CONTENT_MARGIN + height

      this.window.setResizable(true)
      this.window.setBounds({
        x: Math.round(area.x + (area.width - QUICK_WINDOW_CONTENT_WIDTH) / 2),
        y: area.y + CONTENT_MARGIN,
        width: QUICK_WINDOW_CONTENT_WIDTH,
        height,
      })
    } else {
      // 回到空态：收回顶部锚点
      this.window.setResizable(false)
      this.currentHeight = QUICK_WINDOW_MIN_HEIGHT
      this.positionOnShow()
    }

    const { x, y, width, height } = this.window.getBounds()
    console.log(`[快捷窗口] 切到「${mode}」态：(${x}, ${y})，${width}×${height}`)

    // 通知界面。否则会出现「窗口已经是 420×500，界面还以为在空态」
    // 这种两边状态不一致的情况 —— 顶栏就会永远不出现。
    this.sendEvent({ type: 'mode-changed', mode })
  }

  /** 向快捷窗口界面推事件 */
  sendEvent(event: QuickEvent): void {
    this.send('ds:quick-event', event)
  }

  private send(channel: string, ...args: unknown[]): void {
    if (this.window.isDestroyed()) return
    if (this.window.webContents.isLoading()) return
    this.window.webContents.send(channel, ...args)
  }

  /**
   * 设计稿「重置为新聊天」：
   * 呼出面板时，如果距上次关闭已经超过设定的时间，就以空白对话开场；
   * 否则接着显示上一次的对话内容。0 表示「从不」，永远保留。
   */
  private applyResetRule(): void {
    if (this.mode !== 'content') return

    const minutes = load().quickWindow.resetAfterMinutes
    if (minutes <= 0 || this.lastHiddenAt === 0) return
    if (Date.now() - this.lastHiddenAt <= minutes * 60_000) return

    console.log(`[快捷窗口] 距上次关闭已超过 ${minutes} 分钟，重置为新聊天`)
    this.onResetToNewChat()
  }

  /** 空态的位置：鼠标所在屏幕、水平居中、底边锚在固定高度 */
  private positionOnShow(): void {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const area = display.workArea

    const x = Math.round(area.x + (area.width - QUICK_WINDOW_WIDTH) / 2)
    // 锚定**底边**而不是顶边：面板长高时往上升，位置才不会越用越往下跑
    const anchorBottom = Math.round(area.y + area.height * TOP_RATIO + QUICK_WINDOW_MIN_HEIGHT)

    this.bottomY = anchorBottom
    this.window.setBounds({
      x,
      y: anchorBottom - this.currentHeight,
      width: QUICK_WINDOW_WIDTH,
      height: this.currentHeight,
    })
  }

  private bg(): string {
    return nativeTheme.shouldUseDarkColors ? THEMED_BG.dark : THEMED_BG.light
  }
}

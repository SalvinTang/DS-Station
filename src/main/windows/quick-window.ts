import { BrowserWindow, app, screen, type Rectangle } from 'electron'
import { join } from 'node:path'
import {
  QUICK_WINDOW_CONTENT_DEFAULT_HEIGHT,
  QUICK_WINDOW_CONTENT_MIN_HEIGHT,
  QUICK_WINDOW_CONTENT_MIN_WIDTH,
  QUICK_WINDOW_CONTENT_WIDTH,
  QUICK_WINDOW_MAX_HEIGHT,
  QUICK_WINDOW_MIN_HEIGHT,
  QUICK_WINDOW_WIDTH,
} from '../../shared/constants'
import { load, save, type DeepPartial, type QuickWindowSettings } from '../settings'
import type { QuickEvent, QuickMode } from '../../shared/types'

/**
 * 快捷窗口。
 *
 * 两种形态（设计稿）：空态 400×(100~200)，有内容态 420×500 起、可缩放。
 * 这是一个**纯自绘界面**，不是嵌进去的第二个 DeepSeek 网页（决策 D1）——
 * 它自己不跟 DeepSeek 说话，一切由主进程驱动主窗口那个网页完成。
 */

/** 有内容态距屏幕边缘的安全距离 */
const EDGE_MARGIN = 20

/** 展开动画：先下移，再向上长高 */
const EXPAND_SHIFT = 24
const PHASE_MOVE_MS = 140
const PHASE_GROW_MS = 280
const FRAME_MS = 16

/** 用户手动缩放后，隔一小会儿再落盘 */
const SIZE_SAVE_DELAY = 400

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t
}

/** 缓出，动画收尾更柔和 */
function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

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

  /** 有内容态的尺寸，跨隐藏/重启保留 */
  private contentSize = {
    width: QUICK_WINDOW_CONTENT_WIDTH,
    height: QUICK_WINDOW_CONTENT_DEFAULT_HEIGHT,
  }

  /** 手动拖动窗口：记录按下时的鼠标与窗口坐标 */
  private dragOrigin: { mouseX: number; mouseY: number; x: number; y: number } | null = null

  /** 展开动画 */
  private animating = false
  private animationTimer: NodeJS.Timeout | null = null

  /** 缩放落盘防抖 */
  private sizeSaveTimer: NodeJS.Timeout | null = null

  /** 上次收起面板的时刻，用来实现设计稿的「重置为新聊天」 */
  private lastHiddenAt = 0

  constructor(
    private readonly isMainWindowVisible: () => boolean,
    /** 距上次关闭太久时调用：让 DeepSeek 开一个新对话 */
    private readonly onResetToNewChat: () => void,
  ) {
    const settings = load().quickWindow
    this.contentSize = {
      width: Math.max(settings.contentWidth, QUICK_WINDOW_CONTENT_MIN_WIDTH),
      height: Math.max(settings.contentHeight, QUICK_WINDOW_CONTENT_MIN_HEIGHT),
    }

    this.window = new BrowserWindow({
      width: QUICK_WINDOW_WIDTH,
      height: QUICK_WINDOW_MIN_HEIGHT,
      show: false,
      frame: false,
      /*
       * 透明窗口：设计稿的圆角是空态 20、有内容态 30，
       * macOS 原生无边框窗口只有约 10px，只能用 CSS 圆角自己画。
       * 背景色留空，圆角外的部分才真的透明。
       */
      transparent: true,
      backgroundColor: '#00000000',
      roundedCorners: false,
      hasShadow: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
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

    // 用户拖动/移动窗口后，底边位置变了，长高的基准也要跟着变
    this.window.on('move', () => {
      const bounds = this.window.getBounds()
      this.bottomY = bounds.y + bounds.height
    })

    // 有内容态允许缩放：记下来，下次唤出保持同样大小
    this.window.on('resize', () => this.scheduleSizeSave())
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
    this.placeAtSavedPosition()
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

    // 记录这次消失的位置：用户关闭、快捷键关闭、Esc 都会走这里
    this.persistBounds()

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

    const next = clamp(Math.round(height), QUICK_WINDOW_MIN_HEIGHT, QUICK_WINDOW_MAX_HEIGHT)
    if (next === this.currentHeight) return

    this.currentHeight = next
    this.window.setBounds({
      x: this.window.getBounds().x,
      y: this.bottomY - next,
      width: QUICK_WINDOW_WIDTH,
      height: next,
    })
  }

  // ── 手动拖动窗口 ──────────────────────────────────────────

  beginDrag(mouseX: number, mouseY: number): void {
    const bounds = this.window.getBounds()
    this.dragOrigin = { mouseX, mouseY, x: bounds.x, y: bounds.y }
  }

  moveDrag(mouseX: number, mouseY: number): void {
    if (!this.dragOrigin) return
    this.window.setPosition(
      Math.round(this.dragOrigin.x + (mouseX - this.dragOrigin.mouseX)),
      Math.round(this.dragOrigin.y + (mouseY - this.dragOrigin.mouseY)),
    )
  }

  endDrag(): void {
    if (!this.dragOrigin) return
    this.dragOrigin = null
    this.persistBounds()
  }

  // ── 形态切换 ──────────────────────────────────────────────

  /** 切换空态 ↔ 有内容态 */
  setMode(mode: QuickMode): void {
    if (mode === this.mode) return

    const previous = this.mode
    this.mode = mode

    if (mode === 'content') {
      const target = this.contentBoundsFromCurrent()
      this.window.setResizable(true)

      if (previous === 'empty' && this.visible) {
        // 用户发出第一条消息：下移 → 向上长高 → 内容淡入
        this.animateExpand(target)
      } else {
        this.window.setBounds(target)
        this.window.setMinimumSize(QUICK_WINDOW_CONTENT_MIN_WIDTH, QUICK_WINDOW_CONTENT_MIN_HEIGHT)
        this.sendEvent({ type: 'transition-done' })
      }
    } else {
      this.cancelAnimation()
      this.window.setMinimumSize(0, 0)
      this.window.setResizable(false)

      // 收回空态：宽度回到 400 并水平居中，底边不动
      const bounds = this.window.getBounds()
      this.currentHeight = QUICK_WINDOW_MIN_HEIGHT
      this.bottomY = bounds.y + bounds.height
      this.window.setBounds({
        x: Math.round(bounds.x + (bounds.width - QUICK_WINDOW_WIDTH) / 2),
        y: this.bottomY - this.currentHeight,
        width: QUICK_WINDOW_WIDTH,
        height: this.currentHeight,
      })
      this.sendEvent({ type: 'transition-done' })
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

  // ── 位置与尺寸 ────────────────────────────────────────────

  /**
   * 唤出时落位：
   * - 有上次的位置 → 回到上次的位置（底边对齐，因为面板是向上长高的）
   * - 没有 → 当前屏幕正中间
   */
  private placeAtSavedPosition(): void {
    const settings = load().quickWindow
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const area = display.workArea

    const width = this.mode === 'content' ? this.contentWidthFor(area) : QUICK_WINDOW_WIDTH
    const height = this.mode === 'content' ? this.contentHeightFor(area) : this.currentHeight

    let x: number
    let y: number

    if (settings.x !== null && settings.bottom !== null) {
      x = settings.x
      y = settings.bottom - height
    } else {
      x = Math.round(area.x + (area.width - width) / 2)
      y = Math.round(area.y + (area.height - height) / 2)
    }

    // 上次的位置可能在已经拔掉的副屏上，夹回最近的显示器
    const target = screen.getDisplayNearestPoint({
      x: Math.round(x + width / 2),
      y: Math.round(y + height / 2),
    })
    const workArea = target.workArea
    x = clamp(x, workArea.x - width + 80, workArea.x + workArea.width - 80)
    y = clamp(y, workArea.y, workArea.y + workArea.height - 80)

    this.bottomY = y + height
    this.window.setBounds({ x: Math.round(x), y: Math.round(y), width, height })
    if (this.mode === 'content') {
      this.window.setMinimumSize(QUICK_WINDOW_CONTENT_MIN_WIDTH, QUICK_WINDOW_CONTENT_MIN_HEIGHT)
    }
  }

  /**
   * 展开成有内容态时的目标框：
   * 底边先往下挪一点点（空间不够时会挪更多），再从底边向上长高。
   */
  private contentBoundsFromCurrent(): Rectangle {
    const bounds = this.window.getBounds()
    const display = screen.getDisplayNearestPoint({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
    })
    const area = display.workArea

    const width = this.contentWidthFor(area)
    const height = this.contentHeightFor(area)

    // 水平方向保持中心不变
    const x = clamp(
      Math.round(bounds.x + (bounds.width - width) / 2),
      area.x,
      area.x + area.width - width,
    )

    // 底边：先下移一小段，再把“放不下”的部分补上
    let bottom = bounds.y + bounds.height + EXPAND_SHIFT
    bottom = Math.min(bottom, area.y + area.height - EDGE_MARGIN)
    let y = bottom - height

    if (y < area.y + EDGE_MARGIN) {
      y = area.y + EDGE_MARGIN
      bottom = y + height
    }
    if (bottom > area.y + area.height - EDGE_MARGIN) {
      bottom = area.y + area.height - EDGE_MARGIN
      y = bottom - height
    }

    return { x, y, width, height }
  }

  /** 下移 → 向上长高，结束后通知界面淡入内容 */
  private animateExpand(target: Rectangle): void {
    this.cancelAnimation()

    const from = this.window.getBounds()
    const startBottom = from.y + from.height
    const targetBottom = target.y + target.height
    const startedAt = Date.now()
    this.animating = true

    this.animationTimer = setInterval(() => {
      const elapsed = Date.now() - startedAt

      if (elapsed < PHASE_MOVE_MS) {
        // 第一阶段：大小不变，整块往下挪到目标底边
        const k = easeOut(elapsed / PHASE_MOVE_MS)
        const bottom = Math.round(lerp(startBottom, targetBottom, k))
        this.window.setBounds({
          x: Math.round(lerp(from.x, target.x, k)),
          y: bottom - from.height,
          width: Math.round(lerp(from.width, target.width, k)),
          height: from.height,
        })
        return
      }

      if (elapsed < PHASE_MOVE_MS + PHASE_GROW_MS) {
        // 第二阶段：底边不动，高度一路长到默认高度
        const k = easeOut((elapsed - PHASE_MOVE_MS) / PHASE_GROW_MS)
        const height = Math.round(lerp(from.height, target.height, k))
        this.window.setBounds({
          x: target.x,
          y: targetBottom - height,
          width: target.width,
          height,
        })
        return
      }

      this.window.setBounds(target)
      this.finishExpand()
    }, FRAME_MS)
  }

  private finishExpand(): void {
    if (!this.animating) return

    this.animating = false
    if (this.animationTimer) {
      clearInterval(this.animationTimer)
      this.animationTimer = null
    }

    this.window.setMinimumSize(QUICK_WINDOW_CONTENT_MIN_WIDTH, QUICK_WINDOW_CONTENT_MIN_HEIGHT)
    const bounds = this.window.getBounds()
    this.bottomY = bounds.y + bounds.height
    this.persistBounds()

    console.log('[快捷窗口] 展开完成，内容淡入')
    this.sendEvent({ type: 'transition-done' })
  }

  private cancelAnimation(): void {
    if (this.animationTimer) {
      clearInterval(this.animationTimer)
      this.animationTimer = null
    }
    this.animating = false
  }

  /** 把当前位置/尺寸写回配置 */
  private persistBounds(): void {
    const bounds = this.window.getBounds()
    const patch: DeepPartial<QuickWindowSettings> = {
      x: bounds.x,
      bottom: bounds.y + bounds.height,
    }
    if (this.mode === 'content') {
      patch.contentWidth = bounds.width
      patch.contentHeight = bounds.height
    }
    save({ quickWindow: patch })
  }

  private scheduleSizeSave(): void {
    if (this.mode !== 'content' || this.animating || !this.visible) return

    if (this.sizeSaveTimer) clearTimeout(this.sizeSaveTimer)
    this.sizeSaveTimer = setTimeout(() => {
      this.sizeSaveTimer = null
      if (this.mode !== 'content' || !this.visible) return

      const bounds = this.window.getBounds()
      this.contentSize = { width: bounds.width, height: bounds.height }
      save({
        quickWindow: {
          x: bounds.x,
          bottom: bounds.y + bounds.height,
          contentWidth: bounds.width,
          contentHeight: bounds.height,
        },
      })
    }, SIZE_SAVE_DELAY)
  }

  private contentWidthFor(area: Rectangle): number {
    return Math.min(Math.max(this.contentSize.width, QUICK_WINDOW_CONTENT_MIN_WIDTH), area.width)
  }

  private contentHeightFor(area: Rectangle): number {
    return Math.min(
      Math.max(this.contentSize.height, QUICK_WINDOW_CONTENT_MIN_HEIGHT),
      area.height - EDGE_MARGIN * 2,
    )
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
}

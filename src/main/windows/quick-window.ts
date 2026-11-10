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

/**
 * 空态 ↔ 有内容态的展开/收起动画：
 * - 分两步，每步 180ms，总共 360ms
 * - 第一步把四周 10px 的外框撑出来，第二步向上展开
 * - 窗口底边最终比空态低一个发送按钮的高度（30px，包含底部 10px 间距）
 */
const TRANSITION_TOTAL_MS = 360
const TRANSITION_WINDOW_DOWN = 30
const TRANSITION_FRAME_GAP = 10
const FRAME_MS = 16

/**
 * 动效总开关。
 * 暂时关闭，空态 ↔ 有内容态直接切到最终位置；动画实现保留在下面，
 * 参数记录见 docs/快捷窗口动效参数.md，后续优化时改回 true 即可。
 */
const ENABLE_TRANSITION_ANIMATION = false

/** 用户手动缩放后，隔一小会儿再落盘 */
const SIZE_SAVE_DELAY = 400

/** 空态打开历史弹框时，窗口向上让出的高度（输入框 100 + 气泡主体 166 + 尾巴和间隙） */
const HISTORY_WINDOW_HEIGHT = 230

/** 智能搜索结果栏宽度：展开时窗口在内容宽度基础上加这么多 */
const SEARCH_PANEL_WIDTH = 260

/**
 * 关掉历史弹框后，窗口保持撑高状态一小会儿再还原。
 * 连续点「历史」时，第二次打开会落在这个窗口期内，不再反复
 * 缩放窗口 / 开关系统阴影 —— 浅色背景下那圈灰边就是闪烁的来源。
 */
const HISTORY_CLOSE_GRACE_MS = 600

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t
}

/** 和动效稿一致：swing / ease-in-out */
function easeSwing(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
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
  /** 空态打开了历史弹框：窗口临时向上让出空间 */
  private historyOpen = false
  private historyRestoreHeight = QUICK_WINDOW_MIN_HEIGHT
  /** 关闭弹框后延迟还原窗口的定时器 */
  private historyCloseTimer: NodeJS.Timeout | null = null
  /** 智能搜索结果栏是否展开（只影响有内容态宽度） */
  private searchPanelOpen = false

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
  private animationTarget: Rectangle | null = null

  /** 展开前空态窗口的底边，收回空态时用它做反向动画的落点 */
  private preExpandBottom: number | null = null

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

    /*
     * 盖在全屏应用之上、跟随所有工作区。
     *
     * - 层级用 screen-saver：floating 仍然会被全屏应用盖住
     * - skipTransformProcessType：进程激活策略已经在 index.ts 里设成
     *   accessory 了，再让它转换一次反而会把窗口和 Dock 闪没
     */
    this.window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    })
    this.window.setAlwaysOnTop(true, 'screen-saver')

    void this.window.loadFile(join(__dirname, '../renderer/quick/index.html'))

    this.window.webContents.on('did-finish-load', () => {
      console.log('[快捷窗口] 界面就绪')
      /*
       * 启动时窗口可能先 show()、界面后加载完，那条 ds:quick-shown
       * 被 send() 的 isLoading 判断丢弃了。补发一次，让焦点落回输入框。
       */
      if (this.visible) this.send('ds:quick-shown')
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

    /*
     * 多桌面 / 全屏：
     * 窗口始终「在所有空间可见」，并且允许盖在全屏应用之上。
     * 这样：① 任意桌面按快捷键，面板就在当前桌面出现；
     *      ② 用户切桌面时面板会跟着走；
     *      ③ 全屏应用里唤出也能浮在它前面。
     *
     * ★ 空间被销毁后（某个全屏应用退出全屏），macOS 会把窗口的
     *   canJoinAllSpaces 弄丢，而且这个归属「只在窗口可见时」才改得动。
     *   所以顺序是：
     *     1. 显示前先声明一次；
     *     2. showInactive() 不激活地显示，避免激活时把用户切回普通桌面；
     *     3. 窗口可见后再 false → true 刷新一次归属（关键的一步）；
     *     4. 最后 focus() —— 此时窗口已经在当前空间里，激活不会再切桌面。
     */
    app.setActivationPolicy('accessory')

    this.window.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true })
    this.window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    })
    this.window.setAlwaysOnTop(true, 'screen-saver')

    this.window.showInactive()
    this.window.moveTop()
    this.visible = true

    setTimeout(() => {
      if (this.window.isDestroyed() || !this.visible) return
      this.window.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true })
      setTimeout(() => {
        if (this.window.isDestroyed() || !this.visible) return
        this.window.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        })
        this.window.moveTop()
        this.window.focus()
      }, 80)
    }, 120)

    // 全屏自检：确认面板拿到了键盘焦点（DS_FS_TEST=1）
    if (process.env.DS_FS_TEST === '1') {
      setTimeout(() => {
        void this.window.webContents
          .executeJavaScript('document.hasFocus()')
          .then((hasFocus) =>
            console.log(
              '[快捷窗口] 激活后:',
              JSON.stringify({
                focused: this.window.isFocused(),
                visible: this.window.isVisible(),
                rendererHasFocus: hasFocus,
                alwaysOnTop: this.window.isAlwaysOnTop(),
              }),
            ),
          )
      }, 400)
    }

    const { x, y, width, height } = this.window.getBounds()
    console.log(`[快捷窗口] 显示于 (${x}, ${y})，尺寸 ${width}×${height}（${this.mode}）`)

    // 让界面按「输入框里还剩多少个字」重新量一次高度，
    // 并把焦点收回输入框。我们记的高度只是近似，依据永远是内容本身。
    this.send('ds:quick-shown')
  }

  hide(): void {
    if (!this.visible) return

    // 如果动画还没播完就被收起，直接跳到终态，
    // 否则会把中间尺寸当成「用户调过的大小」记下来
    const pendingTarget = this.animationTarget
    if (this.animating && pendingTarget) {
      this.cancelAnimation()
      this.window.setBounds(pendingTarget)
      if (this.mode === 'content') {
        this.window.setMinimumSize(QUICK_WINDOW_CONTENT_MIN_WIDTH, QUICK_WINDOW_CONTENT_MIN_HEIGHT)
      } else {
        this.window.setMinimumSize(0, 0)
      }
      this.sendEvent({ type: 'mode-changed', mode: this.mode })
      this.sendEvent({ type: 'transition-done' })
    }

    // 历史弹框开着（或还在收起缓冲期）时被收起：直接把窗口还原，否则下次唤出还是高的
    if (this.historyOpen) {
      this.cancelHistoryCollapse()
      this.collapseHistoryWindow()
      this.sendEvent({ type: 'history-panel', open: false })
    }

    // 位置可能已经变了，下次展开重新记录反向动画的落点
    this.preExpandBottom = null

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
    // 历史弹框开着的时候窗口是临时撑高的，别让输入框的自动高度把它收回去
    if (this.mode !== 'empty' || this.historyOpen) return

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

  /**
   * 打开 / 收起历史弹框。
   *
   * 空态只有 400×100，放不下列表，所以窗口临时向上让出空间（底边不动）。
   * 有内容态本来就是 420×500，直接浮在消息区上，不动窗口。
   */
  openHistoryPanel(): void {
    // 在收起缓冲期内重新打开：窗口还是撑高状态，直接复用，不重新缩放/开关阴影
    this.cancelHistoryCollapse()

    if (this.mode === 'empty' && !this.historyOpen) {
      this.historyOpen = true
      this.historyRestoreHeight = this.currentHeight

      const bounds = this.window.getBounds()
      const bottom = bounds.y + bounds.height
      const area = screen.getDisplayNearestPoint({
        x: Math.round(bounds.x + bounds.width / 2),
        y: Math.round(bounds.y + bounds.height / 2),
      }).workArea
      const maxHeight = bottom - area.y - EDGE_MARGIN
      const height = clamp(HISTORY_WINDOW_HEIGHT, QUICK_WINDOW_MIN_HEIGHT + 10, Math.max(QUICK_WINDOW_MIN_HEIGHT, maxHeight))

      // 关掉系统窗口阴影：撑高后窗口是一块很大的透明矩形，
      // 系统阴影会在弹框外侧留下一圈灰边（透明区域也有阴影轮廓）。
      this.window.setHasShadow(false)

      this.window.setBounds({
        x: bounds.x,
        y: bottom - height,
        width: bounds.width,
        height,
      })
    }
    this.sendEvent({ type: 'history-panel', open: true })
  }

  closeHistoryPanel(): void {
    if (this.historyOpen && this.mode === 'empty') {
      /*
       * 只先关界面，窗口延迟一小会儿再缩回去。
       * 连续点「历史」时，第二次打开会取消这个定时器，
       * 窗口不用反复从 230 缩回 100、再涨回 230，也不会反复开关系统阴影。
       */
      this.cancelHistoryCollapse()
      this.historyCloseTimer = setTimeout(() => {
        this.historyCloseTimer = null
        this.collapseHistoryWindow()
      }, HISTORY_CLOSE_GRACE_MS)
    }
    this.sendEvent({ type: 'history-panel', open: false })
  }

  /** 把撑高的空态窗口缩回原高度（先缩放，再恢复系统阴影） */
  private collapseHistoryWindow(): void {
    if (!this.historyOpen) return
    this.historyOpen = false

    const bounds = this.window.getBounds()
    this.window.setBounds({
      x: bounds.x,
      y: bounds.y + bounds.height - this.historyRestoreHeight,
      width: QUICK_WINDOW_WIDTH,
      height: this.historyRestoreHeight,
    })
    // 顺序很重要：在撑高的透明窗口上打开阴影，会先闪一圈灰色轮廓
    this.window.setHasShadow(true)
  }

  private cancelHistoryCollapse(): void {
    if (!this.historyCloseTimer) return
    clearTimeout(this.historyCloseTimer)
    this.historyCloseTimer = null
  }

  // ── 手动拖动窗口 ──────────────────────────────────────────

  beginDrag(mouseX: number, mouseY: number): void {
    // 某些情况下 Chromium 给出的 screenX/Y 可能是 NaN，不能拿它当拖动原点
    if (!Number.isFinite(mouseX) || !Number.isFinite(mouseY)) return

    const bounds = this.window.getBounds()
    this.dragOrigin = { mouseX, mouseY, x: bounds.x, y: bounds.y }
    // 用户手动挪过窗口，展开前的位置不再有效
    this.preExpandBottom = null
  }

  moveDrag(mouseX: number, mouseY: number): void {
    const origin = this.dragOrigin
    if (!origin) return
    if (!Number.isFinite(mouseX) || !Number.isFinite(mouseY)) return

    const x = Math.round(origin.x + (mouseX - origin.mouseX))
    const y = Math.round(origin.y + (mouseY - origin.mouseY))
    if (!Number.isFinite(x) || !Number.isFinite(y)) return

    try {
      this.window.setPosition(x, y)
    } catch (error) {
      // 窗口正在收起/销毁时可能拒绝移动，不能让主进程弹出未捕获异常
      console.error('[快捷窗口] 拖动失败:', error)
    }
  }

  endDrag(): void {
    if (!this.dragOrigin) return
    this.dragOrigin = null
    this.persistBounds()
  }

  // ── 形态切换 ──────────────────────────────────────────────

  /** 当前是否处于有内容的展开态（本地快捷键用） */
  isContentMode(): boolean {
    return this.mode === 'content'
  }

  /** 搜索结果栏展开/收起：窗口加宽/收窄，内容宽度保持不变 */
  setSearchPanel(open: boolean): void {
    if (this.mode !== 'content') return

    const bounds = this.window.getBounds()
    const currentExtra = this.searchPanelOpen ? SEARCH_PANEL_WIDTH : 0
    const currentContentWidth = Math.max(
      QUICK_WINDOW_CONTENT_MIN_WIDTH,
      bounds.width - currentExtra,
    )
    this.contentSize = { width: currentContentWidth, height: bounds.height }

    if (this.searchPanelOpen === open) return
    this.searchPanelOpen = open

    if (!this.visible) return

    const display = screen.getDisplayNearestPoint({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
    })
    const area = display.workArea
    const targetWidth = currentContentWidth + (open ? SEARCH_PANEL_WIDTH : 0)

    let x = bounds.x
    if (x + targetWidth > area.x + area.width - EDGE_MARGIN) {
      x = area.x + area.width - targetWidth - EDGE_MARGIN
    }
    x = Math.max(area.x, Math.round(x))

    // 先改最小宽度再改 bounds：否则关闭搜索栏时 420 会被旧的 680 最小值夹回去
    this.window.setMinimumSize(
      QUICK_WINDOW_CONTENT_MIN_WIDTH + (open ? SEARCH_PANEL_WIDTH : 0),
      QUICK_WINDOW_CONTENT_MIN_HEIGHT,
    )
    this.window.setBounds({
      x,
      y: bounds.y,
      width: Math.round(targetWidth),
      height: bounds.height,
    })
    this.bottomY = bounds.y + bounds.height
    this.persistBounds()
  }

  /** 切换空态 ↔ 有内容态 */
  setMode(mode: QuickMode): void {
    if (mode === this.mode) return

    const previous = this.mode
    this.mode = mode

    // 切形态时历史弹框不能留着：空态撑高的窗口要交还给新的布局
    this.cancelHistoryCollapse()
    if (this.historyOpen) {
      this.historyOpen = false
      this.window.setHasShadow(true)
      this.sendEvent({ type: 'history-panel', open: false })
    }

    if (mode === 'content') {
      if (previous === 'empty') this.searchPanelOpen = false
      const target = this.contentBoundsFromCurrent()
      this.window.setResizable(true)

      if (previous === 'empty') {
        // 记住空态底边，反向（新对话）时回到这里
        const from = this.window.getBounds()
        this.preExpandBottom = from.y + from.height
      }

      // 动效开关打开时走原来的动画；关闭时直接展示最终效果
      if (ENABLE_TRANSITION_ANIMATION && previous === 'empty' && this.visible) {
        this.animateExpand(target)
        this.logBounds(mode)
        this.sendEvent({ type: 'mode-changed', mode })
        return
      }

      this.window.setBounds(target)
      this.bottomY = target.y + target.height
      this.window.setMinimumSize(QUICK_WINDOW_CONTENT_MIN_WIDTH, QUICK_WINDOW_CONTENT_MIN_HEIGHT)
      this.persistBounds()
      this.sendEvent({ type: 'transition-done' })
      this.logBounds(mode)
      this.sendEvent({ type: 'mode-changed', mode })
      return
    }

    // ── 收回空态 ─────────────────────────────────────────────
    this.cancelAnimation()
    this.searchPanelOpen = false
    this.window.setMinimumSize(0, 0)
    this.window.setResizable(false)

    const bounds = this.window.getBounds()
    this.currentHeight = QUICK_WINDOW_MIN_HEIGHT
    this.bottomY = bounds.y + bounds.height

    // 有内容态收回空态时，落回展开前的底边（反向动画）
    const bottom = this.preExpandBottom ?? this.bottomY
    const target: Rectangle = {
      x: Math.round(bounds.x + (bounds.width - QUICK_WINDOW_WIDTH) / 2),
      y: Math.round(bottom - QUICK_WINDOW_MIN_HEIGHT),
      width: QUICK_WINDOW_WIDTH,
      height: QUICK_WINDOW_MIN_HEIGHT,
    }

    // 动效开关打开时走原来的反向动画；关闭时直接回到空态
    if (ENABLE_TRANSITION_ANIMATION && previous === 'content' && this.visible) {
      this.animateCollapse(bounds, target)
      return
    }

    this.window.setBounds(target)
    this.bottomY = target.y + target.height
    this.preExpandBottom = null
    this.persistBounds()
    this.logBounds(mode)
    this.sendEvent({ type: 'mode-changed', mode })
  }

  private logBounds(mode: QuickMode): void {
    const { x, y, width, height } = this.window.getBounds()
    console.log(`[快捷窗口] 切到「${mode}」态：(${x}, ${y})，${width}×${height}`)
  }

  /** 向快捷窗口界面推事件 */
  sendEvent(event: QuickEvent): void {
    if (process.env.DS_CHAT_TEST === '1') {
      const summary =
        event.type === 'answer-update'
          ? `answer-update(${event.text.length} 字)`
          : JSON.stringify(event)
      console.log('[对话测试] 推给面板:', summary)
    }
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

    const panelWidth = this.searchPanelOpen ? SEARCH_PANEL_WIDTH : 0
    const width =
      this.mode === 'content' ? this.contentWidthFor(area) + panelWidth : QUICK_WINDOW_WIDTH
    const height = this.mode === 'content' ? this.contentHeightFor(area) : this.currentHeight

    let x: number
    let y: number

    if (settings.x !== null && settings.bottom !== null) {
      /*
       * 存的是绝对坐标。先换算成「相对上次所在显示器工作区左上角」的偏移，
       * 再落回当前显示器 —— 多桌面/多显示器切换时相对位置保持不变。
       */
      const savedDisplay = screen.getDisplayNearestPoint({
        x: Math.round(settings.x + width / 2),
        y: Math.round(settings.bottom - height / 2),
      })
      const relativeX = settings.x - savedDisplay.workArea.x
      const relativeBottom = settings.bottom - savedDisplay.workArea.y

      x = area.x + relativeX
      y = area.y + relativeBottom - height
    } else {
      x = Math.round(area.x + (area.width - width) / 2)
      y = Math.round(area.y + (area.height - height) / 2)
    }

    // 窗口不能完全跑出工作区；有内容态尽量整块留在工作区里
    if (this.mode === 'content') {
      x = clamp(x, area.x, Math.max(area.x, area.x + area.width - width))
    } else {
      x = clamp(x, area.x - width + 80, area.x + area.width - 80)
    }
    y = clamp(y, area.y, area.y + area.height - 80)

    this.bottomY = y + height
    // 先设置最小尺寸，再落 bounds：否则从「搜索栏展开」的窄状态恢复时会被旧最小值夹住
    if (this.mode === 'content') {
      this.window.setMinimumSize(
        QUICK_WINDOW_CONTENT_MIN_WIDTH + panelWidth,
        QUICK_WINDOW_CONTENT_MIN_HEIGHT,
      )
    } else {
      this.window.setMinimumSize(0, 0)
    }
    this.window.setBounds({ x: Math.round(x), y: Math.round(y), width, height })
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

    // 底边：窗口最终下移一个发送按钮的高度（30px，已含底部 10px 间距）；屏幕放不下时夹取
    let bottom = bounds.y + bounds.height + TRANSITION_WINDOW_DOWN
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

  /**
   * 给定展开的起点/终点和进度，算出当前窗口框。
   *
   * 时间轴分两段：
   *   0–50%：宽度撑到终点宽，高度只长 20px（四周露出 10px），底边间距 0→10
   *   50–100%：宽度不变，底边不动，高度长到终点
   * 整体下移按全程 easing 单独叠加。
   */
  private transitionBounds(start: Rectangle, end: Rectangle, progress: number): Rectangle {
    const t = clamp(progress, 0, 1)
    const startBottom = start.y + start.height
    const endBottom = end.y + end.height
    // 终点底边比起点多出来的部分 = 第二步的整体下移 + 底部 10px 间距
    const downShift = endBottom - startBottom - TRANSITION_FRAME_GAP

    let width: number
    let height: number
    let gap: number
    let center: number

    if (t <= 0.5) {
      // 第一阶段：只把四周 10px 外框撑出来，不整体下移
      const k = easeSwing(t / 0.5)
      width = lerp(start.width, end.width, k)
      height = lerp(start.height, start.height + TRANSITION_FRAME_GAP * 2, k)
      gap = TRANSITION_FRAME_GAP * k
      center = lerp(start.x + start.width / 2, end.x + end.width / 2, k)
    } else {
      // 第二阶段：向上展开，同时完成整体下移
      const k = easeSwing((t - 0.5) / 0.5)
      width = end.width
      height = lerp(start.height + TRANSITION_FRAME_GAP * 2, end.height, k)
      gap = TRANSITION_FRAME_GAP
      center = end.x + end.width / 2
    }

    const down = t <= 0.5 ? 0 : downShift * easeSwing((t - 0.5) / 0.5)
    const bottom = startBottom + down + gap

    // 宽度取偶数、x 由中心反推：避免窗口和输入框出现半像素抖动
    const evenWidth = Math.max(2, Math.round(width / 2) * 2)
    return {
      x: Math.round(center - evenWidth / 2),
      y: Math.round(bottom - height),
      width: evenWidth,
      height: Math.max(1, Math.round(height)),
    }
  }

  /** 展开：空态 → 有内容态，结束后通知界面淡入内容 */
  private animateExpand(target: Rectangle): void {
    this.cancelAnimation()

    const current = this.window.getBounds()
    /*
     * 发送前输入框可能折行、空态窗口已经长到 200 高。
     * 动画的基准是 400×100：先把高度收回 100（底边不动），否则
     * 输入框会从 200 直接跳到 100，看起来像是向下多走了一大段。
     */
    const from: Rectangle =
      current.height === QUICK_WINDOW_MIN_HEIGHT
        ? current
        : {
            x: current.x,
            y: current.y + current.height - QUICK_WINDOW_MIN_HEIGHT,
            width: current.width,
            height: QUICK_WINDOW_MIN_HEIGHT,
          }

    if (current.height !== QUICK_WINDOW_MIN_HEIGHT) {
      this.currentHeight = QUICK_WINDOW_MIN_HEIGHT
      this.window.setBounds(from)
    }

    const startedAt = Date.now()
    this.animating = true
    this.animationTarget = target
    this.preExpandBottom = from.y + from.height

    this.animationTimer = setInterval(() => {
      const t = clamp((Date.now() - startedAt) / TRANSITION_TOTAL_MS, 0, 1)
      if (t < 1) {
        this.window.setBounds(this.transitionBounds(from, target, t))
        return
      }
      this.window.setBounds(target)
      this.finishExpand()
    }, FRAME_MS)
  }

  private finishExpand(): void {
    if (!this.animating) return

    this.animating = false
    this.animationTarget = null
    if (this.animationTimer) {
      clearInterval(this.animationTimer)
      this.animationTimer = null
    }

    this.window.setMinimumSize(QUICK_WINDOW_CONTENT_MIN_WIDTH, QUICK_WINDOW_CONTENT_MIN_HEIGHT)
    const bounds = this.window.getBounds()
    this.bottomY = bounds.y + bounds.height
    this.persistBounds()

    const min = this.window.getMinimumSize()
    console.log(
      `[快捷窗口] 展开完成 (${bounds.x}, ${bounds.y}) ${bounds.width}×${bounds.height}，` +
        `最小 ${min[0]}×${min[1]}，内容淡入`,
    )
    this.sendEvent({ type: 'transition-done' })
  }

  /** 收起：把展开动画倒着播放，回到空态 */
  private animateCollapse(from: Rectangle, target: Rectangle): void {
    this.cancelAnimation()

    const startedAt = Date.now()
    this.animating = true
    this.animationTarget = target

    this.animationTimer = setInterval(() => {
      const t = clamp((Date.now() - startedAt) / TRANSITION_TOTAL_MS, 0, 1)
      if (t < 1) {
        // 把 target → from 的展开过程倒着播
        this.window.setBounds(this.transitionBounds(target, from, 1 - t))
        return
      }
      this.window.setBounds(target)
      this.finishCollapse(target)
    }, FRAME_MS)
  }

  private finishCollapse(target: Rectangle): void {
    if (!this.animating) return

    this.animating = false
    this.animationTarget = null
    if (this.animationTimer) {
      clearInterval(this.animationTimer)
      this.animationTimer = null
    }

    this.window.setBounds(target)
    this.bottomY = target.y + target.height
    this.preExpandBottom = null
    this.persistBounds()

    this.logBounds('empty')
    // 动画结束再让界面切空态：清掉消息、去掉淡出样式
    this.sendEvent({ type: 'mode-changed', mode: 'empty' })
  }

  private cancelAnimation(): void {
    if (this.animationTimer) {
      clearInterval(this.animationTimer)
      this.animationTimer = null
    }
    this.animating = false
    this.animationTarget = null
  }

  /** 把当前位置/尺寸写回配置 */
  private persistBounds(): void {
    const bounds = this.window.getBounds()
    const patch: DeepPartial<QuickWindowSettings> = {
      x: bounds.x,
      bottom: bounds.y + bounds.height,
    }
    if (this.mode === 'content') {
      // 同步内存里的尺寸：用户缩放后马上收起时，防抖可能还没跑完
      // 搜索栏的宽度不属于内容宽度，保存时要扣掉
      const panelWidth = this.searchPanelOpen ? SEARCH_PANEL_WIDTH : 0
      const contentWidth = Math.max(QUICK_WINDOW_CONTENT_MIN_WIDTH, bounds.width - panelWidth)
      this.contentSize = { width: contentWidth, height: bounds.height }
      patch.contentWidth = contentWidth
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
      const panelWidth = this.searchPanelOpen ? SEARCH_PANEL_WIDTH : 0
      const contentWidth = Math.max(QUICK_WINDOW_CONTENT_MIN_WIDTH, bounds.width - panelWidth)
      this.contentSize = { width: contentWidth, height: bounds.height }
      save({
        quickWindow: {
          x: bounds.x,
          bottom: bounds.y + bounds.height,
          contentWidth,
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

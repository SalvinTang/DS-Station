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
     * 这样：① 任意桌面按快捷键，第一次就在当前桌面出现；
     *      ② 用户切桌面时已经打开的面板会跟着走，不会留在原桌面；
     *      ③ 全屏应用里唤出也能浮在它前面。
     * ★ 不要在这里把窗口收回某一空间 —— 那会让上面三种情况全部退化
     *   （第一次按不出来、要按两次；全屏应用里被挡在后面）。
     */
    this.window.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    })

    /*
     * ★ 不要调用 app.show()。
     *   它会把整个 App 恢复到上次所在的桌面 —— 在全屏应用里唤出时，
     *   用户会先被切到那个桌面，再看到面板。window.show() 自己会激活。
     *   前提是 index.ts 里把激活策略设成了 accessory（见那里的注释）。
     */

    // 先把层级定好再显示，窗口一出现就在全屏应用之上
    this.window.setAlwaysOnTop(true, 'screen-saver')
    this.window.show()
    this.window.moveTop()
    this.visible = true

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
      }, 300)
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
    // 用户手动挪过窗口，展开前的位置不再有效
    this.preExpandBottom = null
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

      this.logBounds(mode)
      this.sendEvent({ type: 'mode-changed', mode })
      return
    }

    // ── 收回空态 ─────────────────────────────────────────────
    this.cancelAnimation()
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

    if (previous === 'content' && this.visible) {
      // 反向：先把高度收掉，再整体上移收窄；结束后才通知界面切空态
      this.animateCollapse(bounds, target)
    } else {
      this.window.setBounds(target)
      this.logBounds(mode)
      this.sendEvent({ type: 'mode-changed', mode })
    }
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

    const width = this.mode === 'content' ? this.contentWidthFor(area) : QUICK_WINDOW_WIDTH
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

    // 窗口不能完全跑出工作区
    x = clamp(x, area.x - width + 80, area.x + area.width - 80)
    y = clamp(y, area.y, area.y + area.height - 80)

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
    this.animationTarget = target
    this.preExpandBottom = startBottom

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

  /**
   * 收回空态：展开动画的反方向。
   * 阶段一（280ms）：高度一路收掉，顶边往下走、底边不动；
   * 阶段二（140ms）：整体上移回展开前的底边，宽度 420 → 400。
   */
  private animateCollapse(from: Rectangle, target: Rectangle): void {
    this.cancelAnimation()

    const startBottom = from.y + from.height
    const targetBottom = target.y + target.height
    const startedAt = Date.now()
    this.animating = true
    this.animationTarget = target

    this.animationTimer = setInterval(() => {
      const elapsed = Date.now() - startedAt

      if (elapsed < PHASE_GROW_MS) {
        const k = easeOut(elapsed / PHASE_GROW_MS)
        const height = Math.round(lerp(from.height, target.height, k))
        this.window.setBounds({
          x: from.x,
          y: startBottom - height,
          width: from.width,
          height,
        })
        return
      }

      if (elapsed < PHASE_GROW_MS + PHASE_MOVE_MS) {
        const k = easeOut((elapsed - PHASE_GROW_MS) / PHASE_MOVE_MS)
        const bottom = Math.round(lerp(startBottom, targetBottom, k))
        this.window.setBounds({
          x: Math.round(lerp(from.x, target.x, k)),
          y: bottom - target.height,
          width: Math.round(lerp(from.width, target.width, k)),
          height: target.height,
        })
        return
      }

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
      this.contentSize = { width: bounds.width, height: bounds.height }
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

import { DeepSeekPage, delay, type LoginState } from './deepseek/page-driver'
import { load, save } from './settings'
import type { GuideWindow } from './windows/guide-window'
import { GUIDE_STEP, type GuideStep } from './windows/guide-window'
import type { MainWindow } from './windows/main-window'
import type { QuickWindow } from './windows/quick-window'

/**
 * 启动时的登录门禁。
 *
 * 需求：
 *   1. 首次安装启动 → 显示引导页 1；下一步 → 引导页 2；开始 → DeepSeek 登录页
 *   2. 已登录状态下每次启动 → 只显示快捷窗口
 *   3. 退出登录后 → 只显示引导页 2
 *
 * 判断永远以页面为准（URL + 输入框），settings 里的 knownLoggedIn
 * 只是一个「上次确认过」的提示：用它让老用户启动时秒开面板，
 * 再用页面复核，token 失效时退回引导页 2。
 */

/** 启动时最多等这么久来判断登录状态 */
const STARTUP_TIMEOUT_MS = 12_000
const DETECT_POLL_MS = 400
/** 停在登录页时，多久检查一次有没有登录完成 */
const LOGIN_POLL_MS = 1_200

export class StartupFlow {
  private settled = false
  /** 当前是否登录。未登录时快捷键不能唤出快捷窗口 */
  private loggedIn = false
  private loginTimer: NodeJS.Timeout | null = null
  private checking = false

  constructor(
    private readonly win: MainWindow,
    private readonly quick: QuickWindow,
    private readonly guide: GuideWindow,
  ) {}

  /** 启动门禁是否已经完成（这之前不响应 Dock 的 activate，避免主窗口提前冒出来） */
  get isSettled(): boolean {
    return this.settled
  }

  /** 是否已登录（以页面判断为准） */
  get isLoggedIn(): boolean {
    return this.loggedIn
  }

  /** 快捷键/菜单能否唤出快捷窗口：未登录时一律不响应 */
  canSummonQuickWindow(): boolean {
    return this.settled && this.loggedIn
  }

  async start(): Promise<void> {
    const page = new DeepSeekPage(this.win.pageView)

    // ── 上次确认过登录：先亮面板，再后台复核 ──────────────────
    if (load().login.knownLoggedIn) {
      this.settled = true
      // 先按已知状态放行快捷键；复核失败会马上收回
      this.loggedIn = true
      this.quick.show()
      console.log('[启动] 上次为登录状态 → 先显示快捷窗口')

      const state = await this.detect(page)
      if (state === 'logged-in') {
        save({ guide: { introSeen: true } })
        console.log('[启动] 复核通过，保持快捷窗口')
        return
      }

      if (state === 'unknown') {
        // 页面没加载好而已，别因为一次网络波动就把用户踢回引导页
        console.log('[启动] 登录状态暂时确认不了（页面可能没加载完），保持快捷窗口')
        return
      }

      console.log('[启动] 检测到已退出登录 → 显示引导页 2')
      this.loggedIn = false
      save({ login: { knownLoggedIn: false }, guide: { introSeen: true } })
      this.showGuide(GUIDE_STEP.connect)
      this.watchLogin()
      return
    }

    // ── 没有登录提示（首次安装、或上次退出登录）───────────────
    const state = await this.detect(page)
    this.settled = true

    if (state === 'logged-in') {
      this.loggedIn = true
      save({ login: { knownLoggedIn: true }, guide: { introSeen: true } })
      this.guide.hide()
      this.quick.show()
      console.log('[启动] 已登录 → 只显示快捷窗口')
      return
    }

    if (state === 'logged-out') {
      this.showLoggedOutGuide()
      this.watchLogin()
      console.log('[启动] 未登录 → 显示功能引导')
      return
    }

    this.showMain()
    this.watchLogin()
    console.log('[启动] 登录状态未知 → 显示主窗口')
  }

  /** 登录成功后的统一处理：引导页 / 主窗口消失、快捷窗口出现 */
  onLoginConfirmed(): void {
    this.stopWatching()
    this.loggedIn = true
    save({ login: { knownLoggedIn: true }, guide: { introSeen: true } })

    // 先亮面板再收其他窗口：反过来会让 App 在中间瞬间失去 key window
    this.guide.hide()
    this.quick.show()
    this.win.window.hide()
    console.log('[启动] 登录完成 → 主窗口收起，快捷窗口出现')
  }

  /** 退出登录：立刻禁止快捷键唤出面板，并显示引导页 2 */
  onLoggedOut(): void {
    this.loggedIn = false
    this.stopWatching()
    save({ login: { knownLoggedIn: false }, guide: { introSeen: true } })
    this.showGuide(GUIDE_STEP.connect)
    console.log('[启动] 已退出登录 → 显示引导页 2，登录前快捷键不响应')
  }

  /** 停在登录页时监听「登录完成」，启动流程和退出登录后都会用到 */
  watchLogin(): void {
    if (this.loginTimer) return

    const page = new DeepSeekPage(this.win.pageView)
    this.loginTimer = setInterval(() => {
      void (async () => {
        if (this.checking) return
        if (this.win.window.isDestroyed()) {
          this.stopWatching()
          return
        }
        this.checking = true
        try {
          if ((await page.loginState()) === 'logged-in') this.onLoginConfirmed()
        } finally {
          this.checking = false
        }
      })()
    }, LOGIN_POLL_MS)

    console.log('[启动] 开始监听登录完成')
  }

  stopWatching(): void {
    if (!this.loginTimer) return
    clearInterval(this.loginTimer)
    this.loginTimer = null
  }

  // ── 内部 ──────────────────────────────────────────────────────

  private showLoggedOutGuide(): void {
    const seen = load().guide.introSeen
    if (!seen) save({ guide: { introSeen: true } })
    this.showGuide(seen ? GUIDE_STEP.connect : GUIDE_STEP.intro)
  }

  private showGuide(step: GuideStep): void {
    this.guide.show(step)
    this.quick.hide()
    this.win.window.hide()
  }

  private async detect(page: DeepSeekPage): Promise<LoginState> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS

    while (Date.now() < deadline) {
      if (this.win.window.isDestroyed()) return 'unknown'
      const state = await page.loginState()
      if (state !== 'unknown') return state
      await delay(DETECT_POLL_MS)
    }

    return 'unknown'
  }

  private showMain(): void {
    this.win.show()
  }
}

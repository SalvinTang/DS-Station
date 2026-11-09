import { app, clipboard, ipcMain, nativeTheme, shell } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEEPSEEK_URL } from '../shared/constants'
import { translate, type Language } from '../shared/i18n'
import type {
  HistoryEntry,
  HistoryMessage,
  HotkeyUpdateResult,
  QuickMode,
  QuickSubmitPayload,
  SettingsSnapshot,
  ThemeSetting,
} from '../shared/types'
import { setQuitting } from './app-state'
import { writeDomReport } from './deepseek/inspector'
import { DeepSeekPage, delay, type StreamToken } from './deepseek/page-driver'
import { buildAppMenu } from './menu'
import { getDeepseekSession } from './session'
import { currentLanguage, load, messages, save } from './settings'
import {
  acceleratorSignature,
  matchesAccelerator,
  registerQuickHotkey,
  toDisplayAccelerator,
  unregisterAllHotkeys,
} from './shortcut'
import { StartupFlow } from './startup'
import { createTray, refreshTrayMenu, trayDebugState } from './tray'
import { MainWindow } from './windows/main-window'
import { QuickWindow } from './windows/quick-window'
import {
  closeSettingsWindow,
  getSettingsWindow,
  openSettingsWindow,
} from './windows/settings-window'

// 必须在 ready 之前设置：它决定 userData 落在哪个目录
app.setName('DS Station')

/*
 * 兼容旧版本的用户数据。
 * 1.0.x 叫 DS Desktop，登录态和设置都在 ~/Library/Application Support/DS Desktop。
 * 新目录还不存在时继续沿用旧目录，升级后不用重新登录；全新安装则使用新目录。
 *
 * 注意不要先调 app.getPath('userData')：它会把新目录创建出来，
 * 让下面的 existsSync 判断永远失效。
 */
const appDataDir = app.getPath('appData')
const newUserData = join(appDataDir, 'DS Station')
const legacyUserData = join(appDataDir, 'DS Desktop')
const preferLegacyUserData = !existsSync(newUserData) && existsSync(legacyUserData)

// 测试辅助：把数据目录指到别处。正式运行不会设置这个变量
if (process.env.DS_USER_DATA) {
  app.setPath('userData', process.env.DS_USER_DATA)
} else {
  app.setPath('userData', preferLegacyUserData ? legacyUserData : newUserData)
}

/*
 * ★ 主窗口不可见时，DeepSeek 网页仍然要正常跑。
 *
 * 快捷窗口的数据源是主窗口里那个网页（决策 D1）。Chromium 会把「不可见 /
 * 被遮挡的窗口」判定为后台，压缩定时器和渲染，导致回答迟迟不写进 DOM ——
 * 表现就是面板一直 loading，打开一下主窗口才恢复。
 *
 * backgroundThrottling: false 只解决了一部分；窗口从未显示过（已登录启动）
 * 时，还需要关掉 Chromium 的渲染进程后台化与遮挡计算。
 * 下面这些开关必须在 app ready 之前设置。
 */
app.commandLine.appendSwitch('disable-background-timer-throttling')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')

/*
 * 让 Electron / DeepSeek 网页跟随系统语言。
 *
 * 打包后的 Electron 可能把应用语言判定成 en-US（即使系统是中文），
 * DeepSeek 的语言偏好默认是 system，于是首次登录的页面会显示英文。
 * 这里显式指定 --lang：Chromium 的 navigator.language、Accept-Language
 * 以及 DeepSeek 请求里的 x-client-locale 都会跟着它走。
 *
 * 安装包里只保留了中/英语言包（见 scripts/after-pack.cjs），
 * 所以非中文系统统一落到英文；繁体中文系统用 zh-TW。
 */
function pageLocaleFromSystem(): string {
  const preferred = app.getPreferredSystemLanguages?.() ?? []
  const raw = String(preferred[0] || app.getLocale() || 'en-US')
  const lower = raw.toLowerCase()
  if (lower.startsWith('zh')) {
    if (
      lower.includes('hant') ||
      lower.includes('-tw') ||
      lower.includes('-hk') ||
      lower.includes('-mo')
    ) {
      return 'zh-TW'
    }
    return 'zh-CN'
  }
  return 'en-US'
}

const pageLocale = pageLocaleFromSystem()
app.commandLine.appendSwitch('lang', pageLocale)
console.log(`[语言] 系统首选=${app.getPreferredSystemLanguages?.()[0] ?? 'unknown'}，页面语言=${pageLocale}`)

let mainWindow: MainWindow | null = null
let quickWindow: QuickWindow | null = null
let startupFlow: StartupFlow | null = null

/**
 * 当前这一轮生成的取消令牌。
 * 用户点「停止生成」时先把它翻成 true，正在跑的轮询会尽快退出。
 */
let activeToken: StreamToken | null = null

/**
 * 快捷键 / 菜单「呼出快捷窗口」都走这里。
 * 未登录时不响应 —— 面板背后没有可用的 DeepSeek 会话，唤出来也做不了事。
 */
const toggleQuickWindow = (): void => {
  if (!startupFlow) return
  if (!startupFlow.canSummonQuickWindow()) {
    console.log('[快捷窗口] 未登录，快捷键不响应')
    return
  }
  quickWindow?.toggle()
}

// 单实例锁：双开会让两个进程争抢同一份 persist:deepseek 分区，
// 轻则登录态错乱，重则分区损坏。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => mainWindow?.show())

  // 只有真正要退出时才允许窗口被销毁（决策 D3）
  app.on('before-quit', () => setQuitting(true))
  app.on('will-quit', () => unregisterAllHotkeys())

  app.whenReady().then(() => {
    /*
     * 菜单栏应用：不要 Dock 图标，也不参与 Cmd+Tab。
     *
     * 这是快捷窗口能「浮在全屏应用前面」的前提：accessory 进程被激活时
     * 不会把用户切到别的桌面。quick-window.ts 里的 setVisibleOnAllWorkspaces
     * 因此都带 skipTransformProcessType —— 进程类型已经在这里定好了。
     */
    if (process.platform === 'darwin') app.setActivationPolicy('accessory')

    // 主题先于任何窗口生效：CSS 的 prefers-color-scheme 会跟着它走
    nativeTheme.themeSource = load().theme

    // 开发/预览时 Dock 还显示 Electron 的默认图标，这里换成自己的。
    // 打包后由 build/icon.icns 提供，不需要这一步。
    if (!app.isPackaged) {
      const devIcon = join(app.getAppPath(), 'build/icon.png')
      if (existsSync(devIcon)) app.dock?.setIcon(devIcon)
    }

    mainWindow = new MainWindow()
    mainWindow.pageView.webContents.on('dom-ready', () => {
      void new DeepSeekPage(mainWindow!.pageView).installApiHeaderHook()
    })

    // 菜单里不再用 role: 'hide'，把 ⌘H 让给快捷窗口的历史快捷键；
    // 主窗口聚焦时仍然保留 macOS 的 ⌘H 隐藏应用习惯。
    mainWindow.pageView.webContents.on('before-input-event', (event, input) => {
      if (matchesAccelerator(input, 'Command+H')) {
        event.preventDefault()
        app.hide()
      }
    })

    createTray({ showMainWindow: () => mainWindow?.show() })

    // 快捷窗口纯自绘、开销可忽略，直接建好 —— 免得第一次按快捷键要等
    quickWindow = new QuickWindow(
      () => mainWindow?.isVisible ?? false,
      () => void startNewChatOnPage(),
    )

    /*
     * 快捷窗口内的本地快捷键。
     * before-input-event 只有这个窗口拿到焦点时才会触发，
     * 天然满足「只在快捷窗口激活时生效」。
     * event.preventDefault() 也会顺带吃掉 macOS 默认的 ⌘H（隐藏应用）。
     */
    quickWindow.window.webContents.on('before-input-event', (event, input) => {
      const quick = quickWindow
      if (!quick || !quick.window.isFocused()) return

      const shortcuts = load().quickWindow
      if (matchesAccelerator(input, shortcuts.newChatShortcut)) {
        if (!quick.isContentMode()) return
        event.preventDefault()
        void startNewChatOnPage()
        return
      }

      if (matchesAccelerator(input, shortcuts.historyShortcut)) {
        event.preventDefault()
        quick.sendEvent({ type: 'history-shortcut' })
        return
      }

      // 历史快捷键不是 ⌘H 时，⌘H 仍按 macOS 习惯隐藏应用
      if (matchesAccelerator(input, 'Command+H')) {
        event.preventDefault()
        app.hide()
      }
    })

    registerIpcHandlers()

    const { ok } = registerQuickHotkey(load().quickWindow.hotkey, toggleQuickWindow)
    rebuildMenu()

    if (!ok) {
      console.warn('[启动] 快捷键没注册上，可从菜单栏「窗口 → 呼出快捷窗口」进入，或到设置里改键。')
    }

    // 登录门禁：未登录显示主窗口，已登录只显示快捷窗口。
    // 主窗口创建时是隐藏的（MainWindow 里 show: false），这里决定要不要露出来。
    startupFlow = new StartupFlow(mainWindow, quickWindow)
    void startupFlow.start()

    // 启动门禁完成前不响应 activate，否则 macOS 启动时补发的 activate
    // 会让主窗口在已登录的情况下提前闪出来
    app.on('activate', () => {
      if (startupFlow?.isSettled) mainWindow?.show()
    })

    // ── 开发辅助（正式运行不会设置这些环境变量）────────────────

    // 在命令行下没法按 ⌥Space、也没法打字，用它跑一遍面板的生命周期
    if (process.env.DS_SHOW_QUICK === '1') {
      runQuickWindowSelfCheck(quickWindow)
    }

    // 启动门禁自检：看当前该显示哪个窗口；DS_FAKE_LOGIN=1 会模拟一次登录完成
    if (process.env.DS_STARTUP_TEST === '1') {
      runStartupSelfCheck(mainWindow, quickWindow, () => startupFlow)
    }

    // 焦点自检：发送后、回答结束后、窗口重新获得焦点时，光标是否都在输入框
    if (process.env.DS_FOCUS_TEST === '1') {
      runFocusSelfCheck(quickWindow)
    }

    // 多桌面自检：App 隐藏状态下再次唤出，窗口是否真的能出来
    if (process.env.DS_SPACE_TEST === '1') {
      runSpaceSelfCheck(mainWindow, quickWindow)
    }

    // 全屏序列自检：面板显示 → 收起（app.hide）→ 在全屏应用上重新唤出
    if (process.env.DS_FS_SEQUENCE === '1') {
      setTimeout(() => {
        void (async () => {
          console.log('[全屏测试] 收起面板')
          quickWindow?.hide()
          await delay(1200)
          console.log('[全屏测试] 重新唤出')
          quickWindow?.show()
        })()
      }, 9000)
    }

    // 菜单栏图标自检：tray 有没有建起来、菜单位置和文案对不对
    if (process.env.DS_TRAY_TEST === '1') {
      setTimeout(() => {
        console.log('[菜单栏测试]', JSON.stringify(trayDebugState()))
      }, 2500)
    }

    // DOM 探针：写一份报告，DeepSeek 改版后用来重新对选择器
    if (process.env.DS_INSPECT === '1') {
      setTimeout(() => {
        if (mainWindow) void writeDomReport(mainWindow.pageView)
      }, 10_000)
    }

    // 端到端验证「写入 → 发送 → 读回答」
    if (process.env.DS_DRIVE_TEST === '1') {
      void runDriveSelfCheck(mainWindow)
    }

    // 设置窗口自检：开窗、读界面、试一次改键
    if (process.env.DS_SETTINGS_TEST === '1') {
      runSettingsSelfCheck()
    }

    // 端到端对话自检：真的往 DeepSeek 发一条消息，盯页面和快捷窗口的变化
    // ★ 会往账号里发一条测试消息
    if (process.env.DS_CHAT_TEST === '1') {
      void runChatSelfCheck(mainWindow, quickWindow)
    }

    // 停止生成自检：发送 → 停止 → 继续 → 再停止
    // ★ 会往账号发一条测试消息
    if (process.env.DS_STOP_TEST === '1') {
      runStopSelfCheck(mainWindow, quickWindow)
    }

    // 「新对话」按钮自检：发一条、点新对话、再发一条，看会话 URL 有没有变
    // ★ 会往账号里发两条测试消息
    if (process.env.DS_NEWCHAT_TEST === '1') {
      void runNewChatSelfCheck(mainWindow, quickWindow)
    }

    if (process.env.DS_SCROLL_TEST === '1') {
      runScrollSelfCheck(quickWindow)
    }

    // 历史对话自检：打开弹框 → 读列表 → 选第一条 → 检查内容
    if (process.env.DS_HISTORY_TEST === '1') {
      runHistorySelfCheck(mainWindow, quickWindow)
    }

    // 历史弹框连续点击自检：快速开合时窗口不应反复缩放/闪阴影
    if (process.env.DS_TOGGLE_TEST === '1') {
      runHistoryToggleSelfCheck(quickWindow)
    }

    // 拖动自检：NaN 坐标不能把主进程打崩
    if (process.env.DS_DRAG_TEST === '1') {
      runDragSelfCheck(quickWindow)
    }

    // 点击自检：点历史按钮的图标和文字，检查事件目标和窗口位置
    if (process.env.DS_CLICK_TEST === '1') {
      runHistoryClickSelfCheck(quickWindow)
    }

    // 展开/收起动效自检：记录窗口和输入框在动画中的几何
    if (process.env.DS_MODE_TEST === '1') {
      runModeTransitionSelfCheck(quickWindow)
    }

    // 本地快捷键自检：⌘H 打开历史、⌘N 新对话，且不能触发系统隐藏
    if (process.env.DS_SHORTCUT_TEST === '1') {
      runLocalShortcutSelfCheck(quickWindow)
    }

    // 接口 Markdown 渲染自检
    if (process.env.DS_API_MD_TEST === '1') {
      runApiMarkdownSelfCheck(quickWindow)
    }

    // Markdown 渲染自检：注入一段含代码/表格/公式/链接的 HTML，截图验证
    if (process.env.DS_MD_UI_TEST === '1') {
      runMarkdownUiSelfCheck(quickWindow)
    }
  })

  // macOS 惯例：不因窗口关闭而退出应用。
  // 主窗口本来就只是隐藏（决策 D3），快捷窗口后续还要靠它常驻。
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

// ── 菜单 ────────────────────────────────────────────────────────

function rebuildMenu(): void {
  refreshTrayMenu()
  buildAppMenu({
    showMainWindow: () => mainWindow?.show(),
    toggleQuickWindow,
    quickHotkey: load().quickWindow.hotkey,
    // DS_INSPECT=1 时才挂开发者菜单
    dev:
      process.env.DS_INSPECT === '1'
        ? {
            exportDom: () => {
              if (mainWindow) void writeDomReport(mainWindow.pageView)
            },
          }
        : undefined,
  })
}

// ── IPC ─────────────────────────────────────────────────────────

function registerIpcHandlers(): void {
  ipcMain.on('ds:open-settings', () => openSettingsWindow())

  // 快捷窗口里的 Markdown 链接：只在系统浏览器打开，不允许导航本地面板
  ipcMain.on('ds:open-external', (_event, url: unknown) => {
    if (typeof url !== 'string') return
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        void shell.openExternal(url)
      }
    } catch {
      // 非法 URL 直接忽略
    }
  })
  ipcMain.handle('ds:get-version', () => app.getVersion())
  ipcMain.handle('ds:get-messages', () => messages())

  ipcMain.handle('ds:get-settings', (): SettingsSnapshot => settingsSnapshot())
  ipcMain.handle('ds:set-hotkey', (_event, accelerator: unknown): HotkeyUpdateResult =>
    handleSetHotkey(typeof accelerator === 'string' ? accelerator : ''),
  )
  ipcMain.handle(
    'ds:set-quick-shortcut',
    (_event, name: unknown, accelerator: unknown): HotkeyUpdateResult => {
      if ((name !== 'newChat' && name !== 'history') || typeof accelerator !== 'string') {
        return {
          ok: false,
          message: translate(currentLanguage(), 'settings.shortcutTaken'),
          display: '',
        }
      }
      return handleSetQuickShortcut(name, accelerator)
    },
  )
  ipcMain.handle('ds:set-reset-after', (_event, minutes: unknown) => {
    if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0) {
      save({ quickWindow: { resetAfterMinutes: minutes } })
    }
  })
  ipcMain.handle('ds:set-language', (_event, language: Language) => {
    if (language === 'system' || language === 'zh' || language === 'en') {
      save({ language })
      rebuildMenu()
    }
  })
  ipcMain.handle('ds:set-theme', (_event, theme: ThemeSetting) => {
    if (theme === 'system' || theme === 'light' || theme === 'dark') {
      nativeTheme.themeSource = theme
      save({ theme })
    }
  })
  ipcMain.handle('ds:logout', () => handleLogout())

  // ── 快捷窗口 ──────────────────────────────────────────────

  ipcMain.on('ds:quick-hide', () => quickWindow?.hide())

  ipcMain.on('ds:window-drag-start', (_event, screenX: unknown, screenY: unknown) => {
    if (
      typeof screenX === 'number' &&
      Number.isFinite(screenX) &&
      typeof screenY === 'number' &&
      Number.isFinite(screenY)
    ) {
      quickWindow?.beginDrag(screenX, screenY)
    }
  })

  ipcMain.on('ds:window-drag-move', (_event, screenX: unknown, screenY: unknown) => {
    if (
      typeof screenX === 'number' &&
      Number.isFinite(screenX) &&
      typeof screenY === 'number' &&
      Number.isFinite(screenY)
    ) {
      quickWindow?.moveDrag(screenX, screenY)
    }
  })

  ipcMain.on('ds:window-drag-end', () => quickWindow?.endDrag())

  ipcMain.on('ds:quick-resize', (_event, height: unknown) => {
    if (typeof height === 'number' && Number.isFinite(height)) {
      quickWindow?.applyHeight(height)
    }
  })

  ipcMain.on('ds:quick-mode', (_event, mode: QuickMode) => {
    if (mode === 'empty' || mode === 'content') quickWindow?.setMode(mode)
  })

  ipcMain.on('ds:quick-new-chat', () => void startNewChatOnPage())

  ipcMain.on('ds:quick-expand', () => {
    void handleQuickExpand()
  })

  ipcMain.on('ds:quick-submit', (_event, payload: QuickSubmitPayload) => {
    void handleQuickSubmit(payload)
  })

  ipcMain.on('ds:quick-stop', () => void handleStopGeneration())
  ipcMain.on('ds:quick-continue', () => void handleContinueGeneration())

  ipcMain.on('ds:quick-history-toggle', (_event, open: unknown) => {
    if (typeof open === 'boolean') void handleHistoryToggle(open)
  })
  ipcMain.on('ds:quick-history-more', () => void handleHistoryMore())
  ipcMain.on('ds:quick-history-select', (_event, id: unknown) => {
    if (typeof id === 'string') void handleHistorySelect(id)
  })
  ipcMain.on('ds:quick-history-older', () => void handleHistoryOlder())
}

// ── 设置 ────────────────────────────────────────────────────────

function settingsSnapshot(): SettingsSnapshot {
  const settings = load()
  return {
    messages: messages(),
    language: currentLanguage(),
    languageSetting: settings.language,
    theme: settings.theme,
    hotkey: settings.quickWindow.hotkey,
    hotkeyDisplay: toDisplayAccelerator(settings.quickWindow.hotkey),
    newChatShortcut: settings.quickWindow.newChatShortcut,
    newChatShortcutDisplay: toDisplayAccelerator(settings.quickWindow.newChatShortcut),
    historyShortcut: settings.quickWindow.historyShortcut,
    historyShortcutDisplay: toDisplayAccelerator(settings.quickWindow.historyShortcut),
    resetAfterMinutes: settings.quickWindow.resetAfterMinutes,
    // 版本号四段：前三段取 package.json，第四段是构建号（定宽 3 位）。
    // 前三段只有用户明确要求时才改。
    version: `${app.getVersion()}.${String(__BUILD_NUMBER__).padStart(3, '0')}`,
  }
}

function handleSetHotkey(accelerator: string): HotkeyUpdateResult {
  const lang = currentLanguage()
  const previous = load().quickWindow.hotkey
  const candidate = accelerator.trim()

  if (!candidate) {
    return {
      ok: false,
      message: translate(lang, 'settings.hotkeyNeedModifier'),
      display: toDisplayAccelerator(previous),
    }
  }

  const signature = acceleratorSignature(candidate)
  const shortcuts = load().quickWindow
  if (
    signature === acceleratorSignature(shortcuts.newChatShortcut) ||
    signature === acceleratorSignature(shortcuts.historyShortcut)
  ) {
    return {
      ok: false,
      message: translate(lang, 'settings.shortcutTaken'),
      display: toDisplayAccelerator(previous),
    }
  }

  // 先全部注销再注册新键。注册失败必须回滚，
  // 否则用户会落得「新的没生效、旧的也没了」。
  unregisterAllHotkeys()
  const result = registerQuickHotkey(candidate, toggleQuickWindow)

  if (!result.ok) {
    registerQuickHotkey(previous, toggleQuickWindow)
    return {
      ok: false,
      message: translate(lang, 'settings.hotkeyTaken'),
      display: toDisplayAccelerator(previous),
    }
  }

  save({ quickWindow: { hotkey: result.accelerator } })
  rebuildMenu()
  return {
    ok: true,
    message: translate(lang, 'settings.hotkeyOk'),
    display: toDisplayAccelerator(result.accelerator),
  }
}

/** 修改快捷窗口内的本地快捷键（只在快捷窗口激活时生效） */
function handleSetQuickShortcut(
  name: 'newChat' | 'history',
  accelerator: string,
): HotkeyUpdateResult {
  const lang = currentLanguage()
  const shortcuts = load().quickWindow
  const previous = name === 'newChat' ? shortcuts.newChatShortcut : shortcuts.historyShortcut
  const candidate = accelerator.trim()
  const signature = candidate ? acceleratorSignature(candidate) : ''

  // 必须带修饰键，且不能和全局呼出键、另一个本地键重复
  if (!/^(command|control|alt|shift)\+/.test(signature)) {
    return {
      ok: false,
      message: translate(lang, 'settings.hotkeyNeedModifier'),
      display: toDisplayAccelerator(previous),
    }
  }

  const other = name === 'newChat' ? shortcuts.historyShortcut : shortcuts.newChatShortcut
  if (
    signature === acceleratorSignature(other) ||
    signature === acceleratorSignature(shortcuts.hotkey)
  ) {
    return {
      ok: false,
      message: translate(lang, 'settings.shortcutTaken'),
      display: toDisplayAccelerator(previous),
    }
  }

  save({
    quickWindow:
      name === 'newChat' ? { newChatShortcut: candidate } : { historyShortcut: candidate },
  })

  return {
    ok: true,
    message: translate(lang, 'settings.hotkeyOk'),
    display: toDisplayAccelerator(candidate),
  }
}

/** 退出登录：清掉 DeepSeek 分区里的登录态，页面会回到登录页 */
async function handleLogout(): Promise<void> {
  try {
    await getDeepseekSession().clearStorageData()
  } catch (err) {
    console.error('[设置] 清理登录态失败:', err)
  }

  if (activeToken) activeToken.cancelled = true

  save({ login: { knownLoggedIn: false } })
  startupFlow?.onLoggedOut()
  // 退出登录：历史列表的内存数据一并清掉
  historyListEpoch += 1
  historyApiItems = null
  historyApiSeen = new Set()
  historyApiSent = 0
  historyApiHasMore = false
  quickWindow?.sendEvent({ type: 'conversation-cleared' })
  quickWindow?.setMode('empty')

  // 退出登录后需要重新登录：把主窗口亮出来，面板收起
  mainWindow?.show()
  quickWindow?.hide()

  try {
    // 等页面真的切成登录页，再开始监听登录完成，
    // 否则可能拿旧页面的 DOM 误判成「已经登录」
    await mainWindow?.pageView.webContents.loadURL(DEEPSEEK_URL)
  } catch (err) {
    console.error('[设置] 重新加载登录页失败:', err)
  }

  startupFlow?.watchLogin()
}

// ── 快捷窗口 ↔ DeepSeek 网页 ──────────────────────────────────────

/**
 * 一次完整的提问：同步开关 → 写文字 → 点发送 → 流式读回回答。
 *
 * 注意这里**没有**任何一步是"我们自己请求 DeepSeek"：
 * 真正的网络交互全由网页完成，我们只是在旁边操作它的界面。
 */
async function handleQuickSubmit(payload: QuickSubmitPayload): Promise<void> {
  const win = mainWindow
  const quick = quickWindow
  if (!win || !quick) return

  const page = new DeepSeekPage(win.pageView)
  const token: StreamToken = { cancelled: false }
  activeToken = token

  try {
    /*
     * 空态发出的消息 = 新对话的第一条。
     * 必须先把 DeepSeek 切到新会话，否则会接着主窗口里正在看的会话写。
     * 刚启动时页面可能还没就绪，所以输入框用重试的方式等它出现。
     */
    if (payload.startNewChat) {
      activeHistoryId = null
      const started = await page.startNewChat()
      console.log(`[快捷窗口] 空态发送，开新对话 → ${started ? '成功' : '没找到按钮，直接发'}`)
      await delay(600)
    } else if (activeHistoryId) {
      // 历史预览阶段没有切主页面，真正发消息前把页面切到这条会话
      const target = activeHistoryId
      activeHistoryId = null
      const switched = await page.switchToHistory(target)
      if (!switched) throw new Error('切换历史对话失败，请重新选择')
      await delay(300)
    }

    await page.setSwitch('deepThinkToggle', payload.deepThink)
    await page.setSwitch('smartSearchToggle', payload.smartSearch)

    let typed = false
    for (let attempt = 0; attempt < 8 && !typed; attempt += 1) {
      typed = await page.setComposerText(payload.text)
      if (!typed) await delay(500)
    }
    if (!typed) throw new Error('没找到输入框，页面可能还没加载好')

    // 给页面一点时间跑完它自己的状态更新，再点发送
    await delay(350)

    // ★ 发送前记下「当前最后一条回答」。发送后只要它的文本变了，就是新回答。
    //   不能只看数量 —— 首次启动时旧会话里本来就有回答。
    const baseline = await page.listAnswers()
    console.log(`[快捷窗口] 发送前已有 ${baseline.length} 条回答`)

    if (!(await page.clickSend())) {
      throw new Error('没找到发送按钮')
    }

    quick.sendEvent({ type: 'answer-start' })

    const appeared = await page.waitForAnswerChange(baseline, 45000, token)
    if (token.cancelled) return
    if (!appeared) throw new Error('等不到新的回答')

    const got = await page.streamLastAnswer(
      (text, html) => {
        quick.sendEvent({ type: 'answer-update', text, html })
      },
      120000,
      token,
    )

    if (token.cancelled) return
    if (!got) throw new Error('没有读到回答')
  } catch (err) {
    // 用户点了停止：轮询提前退出，这不是错误，也不该再推 answer-done
    if (token.cancelled) return
    const message = err instanceof Error ? err.message : String(err)
    console.error('[快捷窗口] 提问失败:', message)
    quick.sendEvent({ type: 'error', message })
    return
  } finally {
    if (activeToken === token) activeToken = null
  }

  quick.sendEvent({ type: 'answer-done' })
}

/**
 * 停止生成：点掉 DeepSeek 页面上的停止按钮，并告诉面板停在哪。
 *
 * 面板在点击的那一刻就已经把按钮切回发送态（乐观更新）。
 * 这里只有在真的停成功之后才取消轮询；如果没停成，就让回答继续流，
 * 并通知界面把按钮恢复成停止态。
 */
async function handleStopGeneration(): Promise<void> {
  const win = mainWindow
  const quick = quickWindow
  if (!win || !quick) return

  const token = activeToken
  if (!token) {
    console.log('[快捷窗口] 没有正在生成的任务，忽略停止')
    return
  }

  const page = new DeepSeekPage(win.pageView)
  const stopped = await page.stopGenerating()
  console.log(`[快捷窗口] 停止生成 → ${stopped ? '已点击停止' : '没找到停止按钮'}`)

  if (!stopped) {
    // 页面还在生成：不取消轮询，让回答继续更新；界面会恢复停止态
    quick.sendEvent({ type: 'answer-stopped', stopped: false, canContinue: false })
    return
  }

  token.cancelled = true

  // 给页面一点时间把「继续生成」渲染出来
  await delay(600)
  const canContinue = await page.hasContinueButton()

  quick.sendEvent({ type: 'answer-stopped', stopped: true, canContinue })
}

/**
 * 继续生成：点页面上的「继续生成」，然后重新进入流式读取。
 *
 * 一条被截断的回答继续增长时，`waitForAnswerChange` 拿当前文本当 baseline，
 * 只要文本变了就说明续上了；之后复用 `streamLastAnswer`。
 */
async function handleContinueGeneration(): Promise<void> {
  const win = mainWindow
  const quick = quickWindow
  if (!win || !quick) return
  if (activeToken) {
    console.log('[快捷窗口] 已经在生成中，忽略继续')
    return
  }

  const page = new DeepSeekPage(win.pageView)
  const baseline = await page.listAnswers()
  const started = await page.continueGenerating()
  if (!started) {
    console.error('[快捷窗口] 继续生成失败：没找到按钮')
    quick.sendEvent({
      type: 'answer-stopped',
      stopped: true,
      canContinue: await page.hasContinueButton(),
    })
    return
  }

  const token: StreamToken = { cancelled: false }
  activeToken = token
  quick.sendEvent({ type: 'answer-start' })

  try {
    // 10 秒还没续上，就把「继续生成」还给用户，不要一直卡在生成态
    const appeared = await page.waitForAnswerChange(baseline, 10000, token)
    if (token.cancelled) return
    if (!appeared) {
      quick.sendEvent({
        type: 'answer-stopped',
        stopped: true,
        canContinue: await page.hasContinueButton(),
      })
      return
    }

    const got = await page.streamLastAnswer(
      (text, html) => {
        quick.sendEvent({ type: 'answer-update', text, html })
      },
      120000,
      token,
    )

    if (token.cancelled) return
    if (!got) throw new Error('没有读到回答')
  } catch (err) {
    if (token.cancelled) return
    const message = err instanceof Error ? err.message : String(err)
    console.error('[快捷窗口] 继续生成失败:', message)
    quick.sendEvent({ type: 'error', message })
    return
  } finally {
    if (activeToken === token) activeToken = null
  }

  quick.sendEvent({ type: 'answer-done' })
}

// ── 历史对话 ────────────────────────────────────────────────────

/** 接口一次取回 100 条，快捷窗口每次先显示 30 条，滚动再追加 */
const HISTORY_API_CHUNK = 30

let historyPanelOpen = false
let historyLoadingMore = false
let historySentIds = new Set<string>()
let historyOldestKey: string | null = null
let historyOlderLoading = false
/**
 * 接口列表状态。非 null 表示当前走的是接口路径。
 * items 是已经从接口拿到的全部条目，sent 是已经推给快捷窗口的条数。
 */
let historyApiItems: HistoryEntry[] | null = null
let historyApiSeen = new Set<string>()
let historyApiSent = 0
let historyApiCursor: number | null = null
let historyApiHasMore = false
/** 列表请求序号：弹框快速开合时，旧请求的结果直接丢掉 */
let historyListEpoch = 0
/** 当前快捷窗口正在预览的历史会话（预览阶段不切主页面） */
let activeHistoryId: string | null = null
/** 历史选择请求序号：连续点击时只让最后一次生效 */
let historySelectEpoch = 0

/** 把接口列表里下一段（30 条）推给快捷窗口 */
function sendApiHistoryChunk(quick: QuickWindow): void {
  const items = historyApiItems ?? []
  const next = items.slice(historyApiSent, historyApiSent + HISTORY_API_CHUNK)
  // 第一次发送是覆盖，后续滚动加载是追加
  const append = historyApiSent > 0
  historyApiSent += next.length

  quick.sendEvent({
    type: 'history-list',
    items: next,
    append,
    hasMore: historyApiSent < items.length || historyApiHasMore,
  })
}

async function handleHistoryToggle(open: boolean): Promise<void> {
  const win = mainWindow
  const quick = quickWindow
  if (!win || !quick) return

  if (!open) {
    historyPanelOpen = false
    historyListEpoch += 1
    historyApiItems = null
    historyApiSeen = new Set()
    historyApiSent = 0
    historyApiHasMore = false
    quick.closeHistoryPanel()
    return
  }

  // 生成中不允许切走，否则正在跑的轮询会读到别的会话
  if (activeToken) {
    quick.sendEvent({ type: 'history-panel', open: false })
    return
  }

  historyPanelOpen = true
  historySentIds = new Set()
  historyApiItems = null
  historyApiSeen = new Set()
  historyApiSent = 0
  historyApiCursor = null
  historyApiHasMore = false
  historyLoadingMore = false
  const epoch = ++historyListEpoch
  quick.openHistoryPanel()

  const page = new DeepSeekPage(win.pageView)

  /*
   * 接口优先：和主窗口大小、侧边栏是否渲染无关。
   * 主窗口被缩得很小时，侧边栏 DOM 会被隐藏，旧的 readHistory 会读到空列表。
   */
  const list = await page.fetchHistoryList(null)
  if (epoch !== historyListEpoch || !historyPanelOpen) return

  if (list) {
    console.log(
      `[历史] 列表来源=api，${list.items.length} 条，hasMore=${list.hasMore}，cursor=${list.cursor}`,
    )
    historyApiItems = list.items
    historyApiCursor = list.cursor
    historyApiHasMore = list.hasMore
    for (const item of list.items) historyApiSeen.add(item.id)

    if (!list.items.length) {
      quick.sendEvent({ type: 'history-list', items: [], append: false, hasMore: false })
      return
    }

    sendApiHistoryChunk(quick)
    return
  }

  // 接口不可用（未登录 / 没有请求头 / 网络失败）时退回读侧边栏
  let result: { items: HistoryEntry[]; scrollable: boolean } = { items: [], scrollable: false }
  for (let i = 0; i < 20; i++) {
    result = await page.readHistory()
    if (epoch !== historyListEpoch || !historyPanelOpen) return
    if (result.items.length > 0) break
    await delay(500)
  }

  if (epoch !== historyListEpoch || !historyPanelOpen) return
  console.log(`[历史] 列表来源=dom，${result.items.length} 条`)
  for (const item of result.items) historySentIds.add(item.id)
  quick.sendEvent({
    type: 'history-list',
    items: result.items,
    append: false,
    // 列表比视口高就说明可能还有下一页；至少让用户有机会加载一次
    hasMore: result.scrollable && result.items.length > 0,
  })
}

async function handleHistoryMore(): Promise<void> {
  const win = mainWindow
  const quick = quickWindow
  if (!win || !quick || !historyPanelOpen || historyLoadingMore) return

  historyLoadingMore = true
  const epoch = historyListEpoch
  try {
    // 接口路径：内存里还有就直接发；没有就带 cursor 再取一页
    if (historyApiItems) {
      if (historyApiSent < historyApiItems.length) {
        sendApiHistoryChunk(quick)
        return
      }

      if (!historyApiHasMore) {
        quick.sendEvent({ type: 'history-list', items: [], append: true, hasMore: false })
        return
      }

      const page = new DeepSeekPage(win.pageView)
      const nextPage = await page.fetchHistoryList(historyApiCursor)
      if (epoch !== historyListEpoch || !historyPanelOpen) return
      if (!nextPage) {
        historyApiHasMore = false
        quick.sendEvent({ type: 'history-list', items: [], append: true, hasMore: false })
        return
      }

      // 接口的 cursor 是闭区间（会重复上一页最后一条），按 id 去重
      const fresh = nextPage.items.filter((item) => !historyApiSeen.has(item.id))
      for (const item of fresh) historyApiSeen.add(item.id)
      historyApiItems.push(...fresh)
      if (nextPage.cursor !== null) historyApiCursor = nextPage.cursor
      // 整页都是重复内容时直接收尾，避免 cursor 不前进导致死循环
      historyApiHasMore = nextPage.hasMore && fresh.length > 0

      if (!fresh.length) {
        quick.sendEvent({ type: 'history-list', items: [], append: true, hasMore: false })
        return
      }

      sendApiHistoryChunk(quick)
      return
    }

    // DOM 兜底：滚侧边栏加载下一屏
    const page = new DeepSeekPage(win.pageView)
    const scrolled = await page.scrollHistoryToBottom()
    if (epoch !== historyListEpoch || !historyPanelOpen) return
    if (!scrolled) {
      quick.sendEvent({ type: 'history-list', items: [], append: true, hasMore: false })
      return
    }

    // 侧边栏加载下一页需要一点时间；等太短会误判成「到底了」
    await delay(1200)
    const { items } = await page.readHistory()
    const fresh = items.filter((item) => !historySentIds.has(item.id))
    for (const item of fresh) historySentIds.add(item.id)

    if (epoch !== historyListEpoch || !historyPanelOpen) return
    quick.sendEvent({
      type: 'history-list',
      items: fresh,
      append: true,
      // 这一屏确实拉到了新内容，就认为后面可能还有；没有新增就到底了
      hasMore: fresh.length > 0,
    })
  } finally {
    historyLoadingMore = false
  }
}

async function handleHistorySelect(id: string): Promise<void> {
  const win = mainWindow
  const quick = quickWindow
  if (!win || !quick) return
  if (activeToken) return

  const epoch = ++historySelectEpoch
  activeHistoryId = null
  historyPanelOpen = false
  historyListEpoch += 1
  historyApiItems = null
  historyApiSeen = new Set()
  historyApiSent = 0
  historyApiHasMore = false
  // 空态点历史时窗口是临时撑高的，切到有内容态会重新算尺寸
  quick.setMode('content')
  quick.sendEvent({ type: 'history-panel', open: false })
  quick.sendEvent({ type: 'history-start' })

  historyOldestKey = null
  historyOlderLoading = false

  const started = Date.now()
  const page = new DeepSeekPage(win.pageView)
  let messages: HistoryMessage[] | null = null
  let hasOlder = false
  let source = 'api'

  // 一步到位：优先用接口拿完整对话，自己渲染 Markdown
  messages = await page.openHistoryViaApi(id)
  if (epoch !== historySelectEpoch) return

  if (!messages) {
    source = 'dom'
    const result = await page.openHistoryLastExchange(id)
    if (epoch !== historySelectEpoch) return
    if (result) {
      messages = result.messages
      hasOlder = result.hasOlder
    }
  }

  // 最后一段加载失败时退回全量，保证至少能看
  if (!messages) {
    source = 'dom-full'
    messages = await page.openHistory(id)
    if (epoch !== historySelectEpoch) return
    hasOlder = false
  }

  console.log(
    `[快捷窗口] 历史加载耗时 ${Date.now() - started}ms，消息 ${messages?.length ?? 0} 条，来源=${source}，hasOlder=${hasOlder}`,
  )

  if (!messages) {
    quick.sendEvent({ type: 'error', message: '打不开这个历史对话，稍后再试' })
    return
  }

  if (epoch !== historySelectEpoch) return

  historyOldestKey = messages[0]?.key ?? null
  activeHistoryId = id
  quick.sendEvent({ type: 'history-loaded', messages, hasOlder, source: source === 'api' ? 'api' : 'dom' })
}

/** 滚到顶部后，继续加载更早的一批消息 */
async function handleHistoryOlder(): Promise<void> {
  const win = mainWindow
  const quick = quickWindow
  if (!win || !quick || historyOlderLoading) return

  historyOlderLoading = true
  const epoch = historySelectEpoch
  try {
    const page = new DeepSeekPage(win.pageView)
    const result = await page.loadOlderHistory(historyOldestKey)
    if (epoch !== historySelectEpoch) return
    if (!result) {
      quick.sendEvent({ type: 'history-prepended', messages: [], hasOlder: false })
      return
    }
    if (result.messages.length) {
      historyOldestKey = result.messages[0]?.key ?? historyOldestKey
    }
    quick.sendEvent({
      type: 'history-prepended',
      messages: result.messages,
      hasOlder: result.hasOlder,
    })
  } finally {
    historyOlderLoading = false
  }
}

/** 扩大：先确保主页面已经切到当前预览的历史会话，再显示主窗口 */
async function handleQuickExpand(): Promise<void> {
  const win = mainWindow
  const quick = quickWindow
  if (activeHistoryId && win) {
    const target = activeHistoryId
    activeHistoryId = null
    const page = new DeepSeekPage(win.pageView)
    await page.switchToHistory(target).catch(() => false)
  }
  quick?.hide()
  win?.show()
}

/** 让 DeepSeek 网页开一个新对话，并把面板收回空态 */
async function startNewChatOnPage(): Promise<void> {
  const win = mainWindow
  if (!win) return

  activeHistoryId = null

  // 如果上一轮还在生成，先让它停下来，避免旧轮询继续读新会话
  if (activeToken) activeToken.cancelled = true

  // 面板立刻开始收起（反向动画）；页面那边并行去开新对话，
  // 动画结束时 setMode 会通知界面清空并切回空态。
  quickWindow?.setMode('empty')

  const page = new DeepSeekPage(win.pageView)
  const started = await page.startNewChat()
  console.log(
    `[快捷窗口] 新对话 → ${started ? '成功' : '没找到按钮'}，URL: ${win.pageView.webContents.getURL()}`,
  )

  await delay(500)
  console.log(`[快捷窗口] 新对话后 URL: ${win.pageView.webContents.getURL()}`)
}

// ── 开发辅助 ────────────────────────────────────────────────────

/** 端到端验证「往网页写文字 → 点发送 → 读回回答」 */
async function runDriveSelfCheck(win: MainWindow | null): Promise<void> {
  if (!win) return
  const page = new DeepSeekPage(win.pageView)

  await delay(6000)

  console.log('\n[驱动自检] 选择器命中情况:')
  const checks = await page.selfCheck()
  for (const [key, ok] of Object.entries(checks ?? {})) {
    console.log(`  ${ok ? '✅' : '❌'} ${key}`)
  }
  if (!checks?.composer) {
    console.log('[驱动自检] 没找到输入框 —— 未登录或不在对话页，中止。')
    return
  }

  console.log('[驱动自检] 开关状态:', JSON.stringify(await page.getSwitchStates()))

  const baseline = (await page.listAnswers()).length
  console.log(`[驱动自检] 页面上已有 ${baseline} 条回答`)

  const text = '用一句话说明什么是 Electron。'
  const typed = await page.setComposerText(text)
  console.log(`[驱动自检] 写入输入框「${text}」→ ${typed ? '成功' : '失败'}`)

  await delay(600)
  console.log(`[驱动自检] 点发送 → ${(await page.clickSend()) ? '成功' : '失败'}`)

  let updates = 0
  const got = await page.streamLastAnswer((answer) => {
    updates += 1
    if (updates <= 3 || updates % 10 === 0) {
      console.log(`[驱动自检] 第 ${updates} 次更新 (${answer.length} 字): ${answer.slice(0, 50)}…`)
    }
  })

  console.log(`[驱动自检] ${got ? '✅ 收到回答' : '❌ 没收到回答'}，共 ${updates} 次增量更新\n`)
}

/** 开一次设置窗口并探一探它的界面，顺带试改键 */
function runSettingsSelfCheck(): void {
  setTimeout(() => {
    void (async () => {
      openSettingsWindow()
      await delay(1500)

      const win = getSettingsWindow()
      if (!win) {
        console.log('[设置自检] ❌ 窗口没开起来')
        return
      }

      const probe = await win.webContents.executeJavaScript(
        `(() => ({
          title: document.getElementById('title').textContent,
          hotkey: document.getElementById('hotkey').textContent,
          resetOptions: Array.from(document.getElementById('resetAfter').options).map((o) => o.textContent),
          resetValue: document.getElementById('resetAfter').value,
          languageOptions: Array.from(document.getElementById('language').options).map((o) => o.textContent),
          languageValue: document.getElementById('language').value,
          themeOptions: Array.from(document.getElementById('theme').options).map((o) => o.textContent),
          themeValue: document.getElementById('theme').value,
          version: document.getElementById('version').textContent,
          logout: document.getElementById('logout').textContent,
          window: [innerWidth, innerHeight],
        }))()`,
      )
      console.log('[设置自检] 界面:', JSON.stringify(probe, null, 1))
      try {
        writeFileSync('/tmp/ds-settings.png', (await win.webContents.capturePage()).toPNG())
      } catch (error) {
        console.log('[设置自检] 截图失败:', String(error))
      }

      // 改键：Alt+Space → Control+Shift+D，再改回来。
      // 重点看失败时会不会把用户原来的键弄丢。
      console.log('[设置自检] 改成 Control+Shift+D →', JSON.stringify(handleSetHotkey('Control+Shift+D')))
      await delay(400)
      console.log('[设置自检] 改回 Alt+Space →', JSON.stringify(handleSetHotkey('Alt+Space')))
      await delay(400)
      // 故意传一个必然失败的组合，验证回滚
      console.log('[设置自检] 故意传空串 →', JSON.stringify(handleSetHotkey('')))
      await delay(400)

      // 切英文，看文案跟不跟着变
      save({ language: 'en' })
      rebuildMenu()
      closeSettingsWindow()
      openSettingsWindow()
      await delay(1400)

      const enProbe = await getSettingsWindow()?.webContents.executeJavaScript(
        `(() => ({
          title: document.getElementById('title').textContent,
          hotkeyLabel: document.getElementById('lbHotkey').textContent,
          resetOptions: Array.from(document.getElementById('resetAfter').options).map((o) => o.textContent),
          languageOptions: Array.from(document.getElementById('language').options).map((o) => o.textContent),
          logout: document.getElementById('logout').textContent,
        }))()`,
      )
      console.log('[设置自检] 英文界面:', JSON.stringify(enProbe))

      // 先还原语言，再切浅色主题截图对比设计稿
      save({ language: 'system' })
      rebuildMenu()
      nativeTheme.themeSource = 'light'
      save({ theme: 'light' })
      closeSettingsWindow()
      openSettingsWindow()
      await delay(1200)
      try {
        const lightWin = getSettingsWindow()
        if (lightWin) {
          writeFileSync('/tmp/ds-settings-light.png', (await lightWin.webContents.capturePage()).toPNG())
        }
      } catch (error) {
        console.log('[设置自检] 浅色截图失败:', String(error))
      }
      nativeTheme.themeSource = 'system'
      save({ theme: 'system' })
    })()
  }, 4000)
}

/**
 * 多桌面自检：模拟「主窗口隐藏 → 面板收起（会 app.hide）→ 再唤出」。
 *
 * Space 本身没法自动化，这里至少确认 App 能从隐藏状态恢复、窗口真的可见，
 * 以及位置没有被意外改动。
 */
function runSpaceSelfCheck(win: MainWindow | null, quick: QuickWindow | null): void {
  if (!win || !quick) return

  const state = (): unknown => ({
    appHidden: app.isHidden(),
    dockVisible: app.dock?.isVisible() ?? null,
    windowVisible: quick.isVisible,
    bounds: quick.window.getBounds(),
  })

  setTimeout(() => {
    void (async () => {
      console.log('[桌面测试] 初始:', JSON.stringify(state()))
      // 主窗口不可见，收起面板时才会走 app.hide() 这条路
      win.window.hide()
      await delay(600)

      quick.show()
      await delay(800)
      console.log('[桌面测试] 首次唤出:', JSON.stringify(state()))

      quick.hide()
      await delay(600)
      console.log('[桌面测试] 收起后:', JSON.stringify(state()))

      quick.show()
      await delay(800)
      console.log('[桌面测试] 再次唤出:', JSON.stringify(state()))
    })()
  }, 6000)
}

/**
 * 焦点自检：
 *   1. 发送后光标是否仍在输入框
 *   2. answer-done 之后是否回到输入框
 *   3. 窗口重新获得焦点时是否回到输入框
 *
 * 会把 ds:quick-submit 的监听摘掉，避免真的往 DeepSeek 发消息。
 */
function runFocusSelfCheck(quick: QuickWindow | null): void {
  if (!quick) return

  const probe = (): Promise<unknown> =>
    quick.window.webContents.executeJavaScript(`(() => ({
      active: document.activeElement
        ? (document.activeElement.id || document.activeElement.tagName)
        : 'none',
      mode: document.getElementById('app').dataset.mode,
      hasFocus: document.hasFocus(),
    }))()`)

  setTimeout(() => {
    void (async () => {
      quick.show()
      await delay(1500)

      ipcMain.removeAllListeners('ds:quick-submit')

      await quick.window.webContents.executeJavaScript(`(() => {
        const input = document.getElementById('input')
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        setter.call(input, '焦点自检')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        document.getElementById('send').focus()
      })()`)
      console.log('[焦点测试] 点发送前:', JSON.stringify(await probe()))

      await quick.window.webContents.executeJavaScript(`document.getElementById('send').click()`)
      await delay(400)
      console.log('[焦点测试] 发送后:', JSON.stringify(await probe()))

      await quick.window.webContents.executeJavaScript(`document.getElementById('input').blur()`)
      quick.sendEvent({ type: 'answer-done' })
      await delay(300)
      console.log('[焦点测试] answer-done 后:', JSON.stringify(await probe()))

      await quick.window.webContents.executeJavaScript(`(() => {
        document.getElementById('input').blur()
        window.dispatchEvent(new Event('focus'))
      })()`)
      await delay(300)
      console.log('[焦点测试] 窗口 focus 后:', JSON.stringify(await probe()))
    })()
  }, 5000)
}

/**
 * 启动门禁自检：打印主窗口/快捷窗口谁可见、登录提示是什么。
 * `DS_FAKE_LOGIN=1` 会模拟一次登录完成，验证「主窗口收起、快捷窗口出现」。
 */
function runStartupSelfCheck(
  win: MainWindow | null,
  quick: QuickWindow | null,
  getFlow: () => StartupFlow | null,
): void {
  const readState = (): unknown => ({
    mainVisible: win?.isVisible ?? null,
    quickVisible: quick?.isVisible ?? null,
    knownLoggedIn: load().login.knownLoggedIn,
    settled: getFlow()?.isSettled ?? null,
  })

  setTimeout(async () => {
    console.log('[启动测试] 启动完成:', JSON.stringify(readState()))

    if (process.env.DS_FAKE_LOGIN === '1') {
      // 走的和真实登录成功完全同一段逻辑
      getFlow()?.onLoginConfirmed()
      await delay(1500)
      console.log('[启动测试] 模拟登录后:', JSON.stringify(readState()))
    }

    // 模拟按快捷键：未登录时应该没有任何变化；已登录时会 隐藏 → 再显示
    if (process.env.DS_HOTKEY_TEST === '1') {
      console.log('[启动测试] 模拟快捷键（1/2）')
      toggleQuickWindow()
      await delay(800)
      console.log('[启动测试] 快捷键后:', JSON.stringify(readState()))

      console.log('[启动测试] 模拟快捷键（2/2）')
      toggleQuickWindow()
      await delay(800)
      console.log('[启动测试] 再按一次后:', JSON.stringify(readState()))
    }
  }, 8000)
}

/**
 * 「新对话」按钮自检：发一条 → 点顶栏新对话 → 再发一条，
 * 对比三次的会话 URL，确认确实换了会话。
 *
 * ★ 会真的往当前登录的 DeepSeek 账号发两条消息。
 */
async function runNewChatSelfCheck(
  win: MainWindow | null,
  quick: QuickWindow | null,
): Promise<void> {
  if (!win || !quick) return

  const sendViaPanel = async (text: string): Promise<void> => {
    await quick.window.webContents.executeJavaScript(`(() => {
      const input = document.getElementById('input')
      input.value = ${JSON.stringify(text)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('send').click()
    })()`)
  }

  const panelState = (): Promise<unknown> =>
    quick.window.webContents.executeJavaScript(`(() => ({
      mode: document.getElementById('app').dataset.mode,
      groups: document.getElementById('messagesInner').children.length,
      text: (document.getElementById('messagesInner').innerText || '').replace(/\\s+/g, ' ').slice(0, 40),
    }))()`)

  await delay(8000)
  console.log('[新对话测试] 起始 URL:', win.pageView.webContents.getURL())

  quick.show()
  await delay(1500)

  await sendViaPanel('自动化测试-新对话-A：用一句话说明什么是 Electron。')
  await delay(10_000)
  console.log('[新对话测试] 第一条后 URL:', win.pageView.webContents.getURL())
  console.log('[新对话测试] 第一条后面板:', JSON.stringify(await panelState()))

  // 点顶栏最右边的「新对话」
  await quick.window.webContents.executeJavaScript(
    `document.getElementById('tbNewChat').click()`,
  )
  await delay(3000)
  console.log('[新对话测试] 点新对话后 URL:', win.pageView.webContents.getURL())
  console.log('[新对话测试] 点新对话后面板:', JSON.stringify(await panelState()))

  await sendViaPanel('自动化测试-新对话-B：用一句话说明什么是 Vite。')
  await delay(10_000)
  console.log('[新对话测试] 第二条后 URL:', win.pageView.webContents.getURL())
  console.log('[新对话测试] 第二条后面板:', JSON.stringify(await panelState()))
}

/**
 * 停止生成自检：发送 → 生成中停止 → 继续 → 再停止。
 *
 * ★ 会往当前登录的 DeepSeek 账号发一条测试消息。
 */
function runStopSelfCheck(win: MainWindow | null, quick: QuickWindow | null): void {
  if (!win || !quick) return

  const page = new DeepSeekPage(win.pageView)

  const panelState = (): Promise<unknown> =>
    quick.window.webContents.executeJavaScript(`(() => {
      const send = document.getElementById('send')
      const bodies = document.querySelectorAll('.msg-ai .body')
      const last = bodies[bodies.length - 1]
      return {
        mode: document.getElementById('app').dataset.mode,
        stopIcon: !!send.querySelector('svg rect'),
        sendDisabled: send.disabled,
        continueButton: !!document.querySelector('.continue-btn'),
        groups: document.getElementById('messagesInner').children.length,
        hasFocus: document.hasFocus(),
        tail: last ? (last.innerText || '').slice(-40) : '',
      }
    })()`)

  setTimeout(() => {
    void (async () => {
      quick.show()
      await delay(1500)

      await quick.window.webContents.executeJavaScript(`(() => {
        const input = document.getElementById('input')
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
        setter.call(input, '自动化测试-停止生成：请用 800 字左右详细解释什么是量子纠缠。')
        input.dispatchEvent(new Event('input', { bubbles: true }))
        document.getElementById('send').click()
      })()`)

      // 等回答正文真的出现再停止，避免模型还没开口就点掉
      let waited = 0
      while (waited < 12000) {
        const state = (await panelState()) as { tail?: string }
        if (state.tail && state.tail.length > 0) break
        await delay(300)
        waited += 300
      }
      console.log(`[停止测试] 等回答 ${waited}ms 后（面板）:`, JSON.stringify(await panelState()))
      console.log('[停止测试] 生成中（页面）:', await page.isGenerating())

      // 点面板上的停止
      await quick.window.webContents.executeJavaScript(`document.getElementById('send').click()`)
      await delay(150)
      console.log('[停止测试] 点击后 150ms（面板）:', JSON.stringify(await panelState()))
      await delay(2050)
      console.log('[停止测试] 停止后（面板）:', JSON.stringify(await panelState()))
      console.log('[停止测试] 停止后（页面有继续按钮）:', await page.hasContinueButton())

      // 点「继续生成」
      await quick.window.webContents.executeJavaScript(
        `document.querySelector('.continue-btn')?.click()`,
      )
      await delay(800)
      console.log('[停止测试] 继续点击后（面板）:', JSON.stringify(await panelState()))

      await delay(3000)
      console.log('[停止测试] 继续 3 秒后（面板）:', JSON.stringify(await panelState()))
      console.log('[停止测试] 继续 3 秒后（页面）:', await page.isGenerating())

      // 再停一次，别让测试会话一直生成下去
      await quick.window.webContents.executeJavaScript(`document.getElementById('send').click()`)
      await delay(1500)
      console.log('[停止测试] 再次停止后（面板）:', JSON.stringify(await panelState()))
    })()
  }, 6000)
}

/**
 * 端到端对话自检：发送一条真实消息，盯住
 *   1. 页面里的回答列表有没有变化
 *   2. 快捷窗口有没有收到 answer-update
 *   3. 内容态隐藏再唤出后，界面上的消息还在不在
 *
 * ★ 会真的往当前登录的 DeepSeek 账号发一条消息。
 */
async function runChatSelfCheck(
  win: MainWindow | null,
  quick: QuickWindow | null,
): Promise<void> {
  if (!win || !quick) return
  const page = new DeepSeekPage(win.pageView)

  await delay(8000)
  console.log('[对话测试] 页面 URL:', win.pageView.webContents.getURL())
  console.log('[对话测试] 发送前回答:', JSON.stringify(await page.listAnswers()))

  quick.show()
  await delay(1500)

  console.log('[对话测试] 触发发送（深度思考=' + (process.env.DS_CHAT_DEEP === '1') + '）')
  await quick.window.webContents.executeJavaScript(`(() => {
    const input = document.getElementById('input')
    input.value = '自动化测试：用一句话说明什么是 Electron。'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    if (${process.env.DS_CHAT_DEEP === '1'}) {
      document.getElementById('deepThink').setAttribute('aria-pressed', 'true')
    }
    document.getElementById('send').click()
  })()`)

  // 模拟用户行为：发出去一会儿没等到回答就收起面板（主窗口也隐藏 → app.hide）
  const earlyHide = process.env.DS_CHAT_EARLY_HIDE === '1'
  if (earlyHide) {
    await delay(1500)
    win.window.hide()
    quick.hide()
    console.log('[对话测试] 已提前收起面板（主窗口隐藏）')
  }

  const started = Date.now()
  let lastKey = ''
  let lastText = ''
  while (Date.now() - started < 45_000) {
    const answers = await page.listAnswers()
    const text = answers.length ? answers[answers.length - 1] : ''
    const key = `${answers.length}:${text.length}`
    if (key !== lastKey) {
      lastKey = key
      lastText = text
      console.log(
        `[对话测试] +${((Date.now() - started) / 1000).toFixed(1)}s ` +
          `answers=${answers.length} lastLen=${text.length}`,
      )
    }
    await delay(500)
  }
  console.log('[对话测试] 页面最后一条回答:', JSON.stringify(lastText.slice(0, 80)))

  if (earlyHide) {
    win.show()
    quick.show()
    await delay(1500)
  }

  const readDom = async (): Promise<unknown> =>
    quick.window.webContents.executeJavaScript(`(() => ({
      mode: document.getElementById('app').dataset.mode,
      contentEnter: document.getElementById('app').classList.contains('content-enter'),
      groups: document.getElementById('messagesInner').children.length,
      text: (document.getElementById('messagesInner').innerText || '').replace(/\\s+/g, ' ').slice(0, 100),
      active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : 'none',
    }))()`)

  console.log('[对话测试] 快捷窗口 DOM:', JSON.stringify(await readDom()))

  // 场景 A：主窗口还在 → 收起面板不会 app.hide()
  quick.hide()
  await delay(1200)
  quick.show()
  await delay(1200)
  console.log('[对话测试] 隐藏再显示后:', JSON.stringify(await readDom()))

  // 场景 B：主窗口已隐藏 → 收起面板会 app.hide()，再唤出
  win.window.hide()
  await delay(600)
  quick.hide()
  await delay(1500)
  quick.show()
  await delay(1500)
  console.log('[对话测试] 主窗口隐藏后唤出:', JSON.stringify(await readDom()))
  win.show()
}

/** 走一遍快捷窗口的完整生命周期 */
function runQuickWindowSelfCheck(quick: QuickWindow | null): void {
  const typeInto = (text: string): void => {
    void quick?.window.webContents.executeJavaScript(
      `(() => {
        const el = document.getElementById('input')
        if (!el) return
        el.value = ${JSON.stringify(text)}
        el.dispatchEvent(new Event('input', { bubbles: true }))
      })()`,
    )
  }

  setTimeout(() => quick?.show(), 2000)
  setTimeout(() => typeInto('这是一段用来把输入框撑到最大的测试文字。'.repeat(12)), 3400)
  setTimeout(() => quick?.hide(), 5200)
  setTimeout(() => quick?.show(), 6800)
  setTimeout(() => quick?.setMode('content'), 8600)

  // 界面探针：确认拖拽区只开在该开的地方，且 mousemove 能唤出顶栏
  setTimeout(() => {
    void quick?.window.webContents
      .executeJavaScript(
        `(() => {
          const app = document.getElementById('app')
          const messages = document.getElementById('messages')
          const inner = document.getElementById('messagesInner')
          const topbar = document.getElementById('topbar')
          app.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))

          const barRect = topbar.getBoundingClientRect()
          const msRect = messages.getBoundingClientRect()
          const innerRect = inner.getBoundingClientRect()

          return {
            mode: app.dataset.mode,
            contentEnter: app.classList.contains('content-enter'),
            appRegion: getComputedStyle(app).webkitAppRegion,
            messagesRegion: getComputedStyle(messages).webkitAppRegion,
            topbarRegion: getComputedStyle(topbar).webkitAppRegion,
            topbarShown: topbar.classList.contains('show'),
            topbarButtons: Array.from(topbar.querySelectorAll('.tb-btn')).map((b) => b.id),
            topbar: {
              position: getComputedStyle(topbar).position,
              height: Math.round(barRect.height),
              top: Math.round(barRect.top),
            },
            messages: {
              top: Math.round(msRect.top),
              paddingTop: getComputedStyle(messages).paddingTop,
              innerPaddingTop: getComputedStyle(inner).paddingTop,
              firstMessageTop: Math.round(innerRect.top),
              overflowY: getComputedStyle(messages).overflowY,
            },
            appHeight: Math.round(app.getBoundingClientRect().height),
          }
        })()`,
      )
      .then((r) => console.log('[自检] 界面状态:', JSON.stringify(r)))
  }, 9400)

  // 有内容态隐藏再唤出：尺寸和位置应原样恢复
  setTimeout(() => quick?.hide(), 9800)
  setTimeout(() => quick?.show(), 10200)

  setTimeout(() => quick?.setMode('empty'), 10600)

  // 拖动测试：模拟按住面板拖动 60×40，确认窗口真的跟着走、并且位置写进了配置
  setTimeout(() => {
    if (!quick) return
    const before = quick.window.getBounds()
    void quick.window.webContents
      .executeJavaScript(
        `(() => {
          const app = document.getElementById('app')
          const fire = (type, x, y) =>
            app.dispatchEvent(new PointerEvent(type, {
              bubbles: true, pointerId: 1, button: 0,
              buttons: type === 'pointerup' ? 0 : 1,
              screenX: x, screenY: y,
            }))
          fire('pointerdown', 900, 300)
          fire('pointermove', 960, 340)
          fire('pointerup', 960, 340)
        })()`,
      )
      .then(() => {
        setTimeout(() => {
          console.log(
            '[自检] 拖动测试:',
            JSON.stringify({ before, after: quick.window.getBounds() }),
          )
          console.log('[自检] 位置记忆:', JSON.stringify(load().quickWindow))
        }, 300)
      })
  }, 11200)
}

/** 临时自检：滚动到底部按钮的出现 / 点击 / 生成中不自动跟随 */
function runScrollSelfCheck(quick: QuickWindow | null): void {
  const run = (js: string): Promise<unknown> =>
    quick ? quick.window.webContents.executeJavaScript(js) : Promise.resolve(null)

  const state = `(() => {
    const m = document.getElementById('messages')
    const b = document.getElementById('scrollBottom')
    return {
      scrollTop: Math.round(m.scrollTop),
      max: Math.round(m.scrollHeight - m.clientHeight),
      shown: b.classList.contains('show'),
      opacity: getComputedStyle(b).opacity,
    }
  })()`

  setTimeout(() => quick?.show(), 1200)
  setTimeout(() => quick?.setMode('content'), 2200)

  // 注入一段长对话，滚到顶部
  setTimeout(() => {
    void run(`(() => {
      const inner = document.getElementById('messagesInner')
      const add = (tplId, text, kind) => {
        const g = document.createElement('div')
        g.className = 'msg-group'
        g.appendChild(document.getElementById(tplId).content.cloneNode(true))
        g.querySelector(kind === 'user' ? '.bubble' : '.body').textContent = text
        inner.appendChild(g)
      }
      add('tplUser', '滚动测试', 'user')
      add('tplAi', '这是一段很长的回答。'.repeat(80), 'ai')
      document.getElementById('messages').scrollTop = 0
    })()`)
  }, 3000)

  setTimeout(() => {
    void run(state).then((r) => console.log('[滚动测试] 顶部:', JSON.stringify(r)))
  }, 3500)

  // 点「滚动到底部」
  setTimeout(() => {
    void run(`document.getElementById('scrollBottom').click()`)
  }, 4000)
  setTimeout(() => {
    void run(state).then((r) => console.log('[滚动测试] 点击瞬间:', JSON.stringify(r)))
  }, 4120)
  setTimeout(() => {
    void run(state).then((r) => console.log('[滚动测试] 点击后:', JSON.stringify(r)))
  }, 5000)

  // 已经在底部时追加文字：不应该自动滚动，按钮应该重新出现
  setTimeout(() => {
    void run(`(() => {
      const bodies = document.querySelectorAll('.msg-ai .body')
      const last = bodies[bodies.length - 1]
      last.textContent += '\\n追加的内容。'.repeat(30)
    })()`)
  }, 5400)
  setTimeout(() => {
    void run(state).then((r) => console.log('[滚动测试] 追加后:', JSON.stringify(r)))
  }, 6200)

  // 再发一条消息：新消息应该被顶到「顶栏下方 10px」（临时数据目录，不会发到账号）
  setTimeout(() => {
    void run(`(() => {
      const input = document.getElementById('input')
      input.value = '第二条消息'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('send').click()
    })()`)
  }, 6600)
  const measure = `(() => {
    const m = document.getElementById('messages')
    const users = document.querySelectorAll('.msg-user')
    const last = users[users.length - 1]
    return {
      userTop: Math.round(last.getBoundingClientRect().top - m.getBoundingClientRect().top),
      scrollTop: Math.round(m.scrollTop),
      tail: Math.round(document.getElementById('messagesTail').offsetHeight),
      shown: document.getElementById('scrollBottom').classList.contains('show'),
    }
  })()`

  // 动画过程采样：userTop 应该从视口下方一路减到 50
  setTimeout(() => {
    void run(measure).then((r) => console.log('[滚动测试] 动画中 1:', JSON.stringify(r)))
  }, 6660)
  setTimeout(() => {
    void run(measure).then((r) => console.log('[滚动测试] 动画中 2:', JSON.stringify(r)))
  }, 6780)

  setTimeout(() => {
    void run(measure).then((r) => console.log('[滚动测试] 新消息:', JSON.stringify(r)))
  }, 6950)

  // 模拟回答结束：补位只收到不夹走视图的程度，消息应该还在 50px
  setTimeout(() => quick?.sendEvent({ type: 'answer-done' }), 7150)
  setTimeout(() => {
    void run(measure).then((r) => console.log('[滚动测试] 结束后:', JSON.stringify(r)))
  }, 7400)

  // 历史对话落点：最后一条用户消息应该顶到「顶栏下方 10px」
  setTimeout(() => {
    quick?.sendEvent({
      type: 'history-loaded',
      messages: [
        { role: 'user', text: '历史里的最后一问' },
        { role: 'ai', text: '这是一段很长的历史回答。'.repeat(80) },
      ],
      hasOlder: false,
    })
  }, 7600)
  setTimeout(() => {
    void run(measure).then((r) => console.log('[滚动测试] 历史落点:', JSON.stringify(r)))
  }, 8000)

  setTimeout(() => process.exit(0), 8600)
}

/** 历史对话功能自检：打开弹框 → 读列表 → 选第一条 → 检查快捷窗口内容 */
/** 自检：快捷窗口内的本地快捷键（⌘H / ⌘N） */
function runLocalShortcutSelfCheck(quick: QuickWindow | null): void {
  if (!quick) return

  setTimeout(() => {
    quick.show()
    app.focus({ steal: true })
    quick.window.focus()
  }, 800)

  setTimeout(async () => {
    quick.setMode('content')
    await delay(300)
    app.focus({ steal: true })
    quick.window.show()
    quick.window.focus()
    await delay(200)
    console.log(
      '[快捷键测试] 初始:',
      JSON.stringify({
        content: quick.isContentMode(),
        focused: quick.window.isFocused(),
        visible: quick.window.isVisible(),
        appHidden: app.isHidden(),
      }),
    )

    quick.window.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: 'y',
      modifiers: ['meta'],
    })
    quick.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'y', modifiers: ['meta'] })
    await delay(600)

    const panel = await quick.window.webContents.executeJavaScript(`(() => {
      const el = document.getElementById('historyPanel')
      return {
        open: el.classList.contains('open'),
        hidden: el.hidden,
        items: document.querySelectorAll('.history-item').length,
        selected: document.querySelectorAll('.history-item.selected').length,
      }
    })()`)
    console.log(
      '[快捷键测试] ⌘Y 后:',
      JSON.stringify({
        panel,
        appHidden: app.isHidden(),
        windowVisible: quick.window.isVisible(),
        content: quick.isContentMode(),
      }),
    )

    if (panel.items > 0) {
      quick.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
      quick.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
      await delay(250)
      const selectedIndex = await quick.window.webContents.executeJavaScript(
        `[...document.querySelectorAll('.history-item')].findIndex((el) => el.classList.contains('selected'))`,
      )
      console.log('[快捷键测试] ↓ 后 selectedIndex:', selectedIndex)

      quick.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
      quick.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
      await delay(1200)
      const afterEnter = await quick.window.webContents.executeJavaScript(`(() => ({
        panelOpen: document.getElementById('historyPanel').classList.contains('open'),
        panelHidden: document.getElementById('historyPanel').hidden,
        users: document.querySelectorAll('.msg-user').length,
        answers: document.querySelectorAll('.msg-ai').length,
        mode: document.getElementById('app').dataset.mode,
      }))()`)
      console.log('[快捷键测试] 回车后:', JSON.stringify(afterEnter))
      process.exit(0)
    }

    quick.window.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: 'n',
      modifiers: ['meta'],
    })
    quick.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'n', modifiers: ['meta'] })
    await delay(600)
    console.log('[快捷键测试] ⌘N 后 content:', quick.isContentMode())
    process.exit(0)
  }, 1500)
}

/** 自检：空态 ↔ 有内容态动画的窗口尺寸和输入框位置 */
function runModeTransitionSelfCheck(quick: QuickWindow | null): void {
  if (!quick) return
  const run = <T>(js: string): Promise<T> => quick.window.webContents.executeJavaScript(js)

  const composerState = (): Promise<{ x: number; y: number; w: number; h: number; gap: number }> =>
    run(`(() => {
      const el = document.querySelector('.composer')
      const r = el.getBoundingClientRect()
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        gap: Math.round(innerHeight - (r.y + r.height)),
      }
    })()`)

  setTimeout(() => quick.show(), 800)
  setTimeout(async () => {
    // 模拟用户输入多行、空态窗口已经长到 200 高
    await run(`window.ds.resizeQuickWindow(200); true`)
    await new Promise((resolve) => setTimeout(resolve, 200))
    console.log('[动效测试] 初始窗口:', JSON.stringify(quick.window.getBounds()))

    await run(`window.ds.setQuickMode('content'); true`)

    const forward = []
    const startedAt = Date.now()
    for (let i = 0; i < 26; i += 1) {
      forward.push({
        t: Date.now() - startedAt,
        window: quick.window.getBounds(),
        composer: await composerState(),
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    console.log('[动效测试] 展开采样:', JSON.stringify(forward))

    await run(`window.ds.quickNewChat(); true`)

    const reverse = []
    const startedAt2 = Date.now()
    for (let i = 0; i < 26; i += 1) {
      reverse.push({
        t: Date.now() - startedAt2,
        window: quick.window.getBounds(),
        composer: await composerState(),
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    console.log('[动效测试] 收起采样:', JSON.stringify(reverse))
    console.log('[动效测试] 结束窗口:', JSON.stringify(quick.window.getBounds()))
    process.exit(0)
  }, 1400)
}

/** 自检：点历史按钮的图标/文字时，事件目标和窗口位置是否正确 */
function runHistoryClickSelfCheck(quick: QuickWindow | null): void {
  if (!quick) return
  const run = <T>(js: string): Promise<T> => quick.window.webContents.executeJavaScript(js)

  setTimeout(() => quick.show(), 800)
  setTimeout(async () => {
    const info = await run<{
      svg: { x: number; y: number; w: number; h: number }
      label: { x: number; y: number; w: number; h: number }
      iconHit: unknown
      labelHit: unknown
    }>(`(() => {
      const btn = document.getElementById('history')
      const svg = btn.querySelector('svg')
      const label = document.getElementById('historyLabel')
      const sr = svg.getBoundingClientRect()
      const lr = label.getBoundingClientRect()
      const hit = (x, y) => {
        const el = document.elementFromPoint(x, y)
        return {
          tag: el ? el.tagName : null,
          cls: el ? String(el.className || '') : '',
          button: el && el.closest ? ((el.closest('button') || {}).id || null) : null,
        }
      }
      return {
        svg: { x: sr.left, y: sr.top, w: sr.width, h: sr.height },
        label: { x: lr.left, y: lr.top, w: lr.width, h: lr.height },
        iconHit: hit(sr.left + sr.width / 2, sr.top + sr.height / 2),
        labelHit: hit(lr.left + lr.width / 2, lr.top + lr.height / 2),
      }
    })()`)

    console.log('[点击测试] 命中:', JSON.stringify(info))

    const ix = Math.round(info.svg.x + info.svg.w / 2)
    const iy = Math.round(info.svg.y + info.svg.h / 2)
    const before = quick.window.getBounds()
    quick.window.webContents.sendInputEvent({ type: 'mouseMove', x: ix, y: iy })
    quick.window.webContents.sendInputEvent({
      type: 'mouseDown',
      x: ix,
      y: iy,
      button: 'left',
      clickCount: 1,
    })
    quick.window.webContents.sendInputEvent({ type: 'mouseMove', x: ix + 3, y: iy + 2 })
    quick.window.webContents.sendInputEvent({
      type: 'mouseUp',
      x: ix + 3,
      y: iy + 2,
      button: 'left',
      clickCount: 1,
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const after = quick.window.getBounds()
    const opened = await run<{ height: number; composer: number; cls: string }>(`(() => ({
      height: innerHeight,
      composer: Math.round(document.querySelector('.composer').getBoundingClientRect().height),
      cls: document.getElementById('app').className,
    }))()`)
    console.log(
      `[点击测试] 图标按下并移动 3,2 后 bounds=${JSON.stringify(after)}（之前 ${JSON.stringify(before)}，底边应保持 ${before.y + before.height}），界面=${JSON.stringify(opened)}`,
    )

    // 再点一次图标关闭：窗口收起缓冲期内 composer 不能撑满窗口
    const rect2 = await run<{ x: number; y: number; w: number; h: number }>(`(() => {
      const r = document.querySelector('#history svg').getBoundingClientRect()
      return { x: r.left, y: r.top, w: r.width, h: r.height }
    })()`)
    const cx = Math.round(rect2.x + rect2.w / 2)
    const cy = Math.round(rect2.y + rect2.h / 2)
    quick.window.webContents.sendInputEvent({ type: 'mouseMove', x: cx, y: cy })
    quick.window.webContents.sendInputEvent({
      type: 'mouseDown',
      x: cx,
      y: cy,
      button: 'left',
      clickCount: 1,
    })
    quick.window.webContents.sendInputEvent({
      type: 'mouseUp',
      x: cx,
      y: cy,
      button: 'left',
      clickCount: 1,
    })

    for (const wait of [0, 100, 300, 600]) {
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait))
      const b = quick.window.getBounds()
      const ui = await run<{ height: number; composer: number; cls: string }>(`(() => ({
        height: innerHeight,
        composer: Math.round(document.querySelector('.composer').getBoundingClientRect().height),
        cls: document.getElementById('app').className,
      }))()`)
      console.log(
        `[点击测试] 关闭 +${wait}ms bounds=${b.width}x${b.height} 界面=${JSON.stringify(ui)}`,
      )
    }
    process.exit(0)
  }, 1400)
}

/** 自检：拖动窗口时收到 NaN 坐标不应崩溃，有效坐标仍能移动 */
function runDragSelfCheck(quick: QuickWindow | null): void {
  if (!quick) return
  const run = (js: string): Promise<unknown> => quick.window.webContents.executeJavaScript(js)

  setTimeout(() => quick.show(), 800)
  setTimeout(async () => {
    const before = quick.window.getBounds()
    await run(`window.ds.beginWindowDrag(NaN, NaN); window.ds.moveWindowDrag(NaN, NaN); true`)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const afterNaN = quick.window.getBounds()
    console.log(
      `[拖动测试] NaN 后窗口位置 ${afterNaN.x},${afterNaN.y}（原 ${before.x},${before.y}）`,
    )

    await run(`window.ds.beginWindowDrag(100, 100); window.ds.moveWindowDrag(140, 130); true`)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const afterMove = quick.window.getBounds()
    console.log(
      `[拖动测试] 有效拖动后窗口位置 ${afterMove.x},${afterMove.y}（应为原位置 +40,+30）`,
    )

    await run(`window.ds.endWindowDrag(); true`)
    process.exit(0)
  }, 1400)
}

/**
 * 自检：连续快速点击「历史」按钮。
 * 期望窗口在点击期间一直保持撑高（230），停止点击后延迟一小会儿才缩回；
 * 不应该每点一次就 100↔230 反复缩放（浅色背景下那会看到阴影闪烁）。
 */
function runHistoryToggleSelfCheck(quick: QuickWindow | null): void {
  if (!quick) return
  const run = (js: string): Promise<unknown> => quick.window.webContents.executeJavaScript(js)

  setTimeout(() => quick.show(), 800)
  setTimeout(() => {
    let clicks = 0
    const click = (): void => {
      clicks += 1
      void run(`document.getElementById('history').click()`)
        .then(async () => {
          const bounds = quick.window.getBounds()
          const panel = await run(`(() => {
            const el = document.getElementById('historyPanel')
            return { open: el.classList.contains('open'), hidden: el.hidden }
          })()`)
          console.log(
            `[切换测试] 第 ${clicks} 次点击 bounds=${bounds.width}x${bounds.height} panel=${JSON.stringify(panel)}`,
          )

          if (clicks < 8) {
            setTimeout(click, 120)
            return
          }
          // 最后一次是「关闭」，等过缓冲期后窗口应该缩回
          await new Promise((resolve) => setTimeout(resolve, 500))
          const settled = quick.window.getBounds()
          console.log(`[切换测试] 停止点击 500ms 后 bounds=${settled.width}x${settled.height}`)
          process.exit(0)
        })
        .catch((error) => console.log('[切换测试] 失败:', String(error)))
    }
    click()
  }, 1400)
}

function runHistorySelfCheck(win: MainWindow | null, quick: QuickWindow | null): void {
  if (!win || !quick) return
  const run = (js: string): Promise<unknown> =>
    quick ? quick.window.webContents.executeJavaScript(js) : Promise.resolve(null)

  const log = async (tag: string, js: string): Promise<unknown> => {
    const result = await run(js).catch((error) => ({ error: String(error) }))
    console.log(`[历史测试] ${tag}:`, JSON.stringify(result))
    return result
  }

  const shot = async (name: string): Promise<void> => {
    try {
      // 等合成器把最新一帧画出来
      await new Promise((resolve) => setTimeout(resolve, 500))
      const image = await quick.window.webContents.capturePage()
      writeFileSync(`/tmp/ds-history-${name}.png`, image.toPNG())
    } catch (error) {
      console.log('[历史测试] 截图失败:', String(error))
    }
  }

  setTimeout(() => quick.show(), 1500)
  setTimeout(() => void shot('empty'), 2500)
  setTimeout(() => void run(`document.getElementById('history').click()`), 3500)

  const listState = `(() => {
    const panel = document.getElementById('historyPanel')
    const app = document.getElementById('app')
    const r = panel.getBoundingClientRect()
    const item = document.querySelector('.history-item')
    const list = document.getElementById('historyList')
    return {
      open: panel.classList.contains('open'),
      items: document.querySelectorAll('.history-item').length,
      pressed: document.getElementById('history').getAttribute('aria-pressed'),
      mode: app.dataset.mode,
      window: [innerWidth, innerHeight],
      panel: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      appBg: getComputedStyle(app).backgroundColor,
      clipped: item ? getComputedStyle(item).textOverflow : null,
      list: [list.clientHeight, list.scrollHeight, Math.round(list.scrollTop)],
    }
  })()`

  const conversationState = `(() => {
    const m = document.getElementById('messages')
    const app = document.getElementById('app')
    const users = document.querySelectorAll('.msg-user')
    const lastUser = users[users.length - 1]
    return {
      lastUserTop: lastUser ? Math.round(lastUser.getBoundingClientRect().top - m.getBoundingClientRect().top) : null,
      scrollTop: Math.round(m.scrollTop),
      mode: app.dataset.mode,
      window: [innerWidth, innerHeight],
      groups: document.querySelectorAll('.msg-group').length,
      users: document.querySelectorAll('.msg-user').length,
      answers: document.querySelectorAll('.msg-ai').length,
      thinking: !!document.querySelector('.thinking'),
      atBottom: m.scrollHeight - m.scrollTop - m.clientHeight <= 4,
      historyOpen: document.getElementById('historyPanel').classList.contains('open'),
    }
  })()`

  // 等列表出来（页面侧边栏可能还在加载）
  let waited = 0
  const poll = setInterval(() => {
    waited += 500
    void run(`document.querySelectorAll('.history-item').length`).then((count) => {
      if ((count as number) === 0 && waited < 15000) return
      clearInterval(poll)

      void (async () => {
        await log('列表', listState)
        await shot('list')

        // 懒加载：把弹框滚到底
        await run(`(() => { const l = document.getElementById('historyList'); l.scrollTop = l.scrollHeight; })()`)
        await new Promise((resolve) => setTimeout(resolve, 2000))
        await log('加载更多', `({ items: document.querySelectorAll('.history-item').length })`)

        // 选第一条历史对话
        const urlBefore = win.pageView.webContents.getURL()
        await run(`(() => { const items = [...document.querySelectorAll('.history-item')]; const hit = items.find((el) => (el.textContent || '').includes('回复样式')); (hit || items[0])?.click(); return !!hit; })()`)
        await new Promise((resolve) => setTimeout(resolve, 6500))
        await log('对话', conversationState)
        await shot('content')

        // Markdown 渲染检查：滚到第一条 AI 回答顶部，统计各类元素
        await run(`(() => {
          const m = document.getElementById('messages')
          const body = document.querySelector('.msg-ai .body.md')
          if (body) {
            const top = body.getBoundingClientRect().top - m.getBoundingClientRect().top + m.scrollTop
            m.scrollTop = Math.max(0, top - 50)
          }
          return true
        })()`)
        await new Promise((resolve) => setTimeout(resolve, 400))
        await log('Markdown', `(() => ({
          mdBodies: document.querySelectorAll('.msg-ai .body.md').length,
          h1: document.querySelectorAll('.md h1').length,
          h2: document.querySelectorAll('.md h2').length,
          h3: document.querySelectorAll('.md h3').length,
          h4: document.querySelectorAll('.md h4').length,
          ul: document.querySelectorAll('.md ul').length,
          ol: document.querySelectorAll('.md ol').length,
          blockquote: document.querySelectorAll('.md blockquote').length,
          tables: document.querySelectorAll('.md table').length,
          pres: document.querySelectorAll('.md pre').length,
          inlineCode: document.querySelectorAll('.md :not(pre) > code').length,
          links: document.querySelectorAll('.md a').length,
          mathInline: document.querySelectorAll('.md .md-math-inline').length,
          mathDisplay: document.querySelectorAll('.md .md-math-display').length,
          katexLeftover: document.querySelectorAll('.md .katex').length,
          svgLeftover: document.querySelectorAll('.md svg').length,
          tokens: document.querySelectorAll('.md .token').length,
          codeBlocks: document.querySelectorAll('.md .md-code-block').length,
          codeHeads: document.querySelectorAll('.md .md-code-head').length,
          codeLangs: [...document.querySelectorAll('.md .md-code-lang')].map((el) => (el.textContent || '').trim()),
          codeCopies: document.querySelectorAll('.md .md-code-copy').length,
          codeCopyLabels: [...document.querySelectorAll('.md .md-code-copy')].map((el) => el.getAttribute('aria-label')),
          codeBg: (() => { const el = document.querySelector('.md .md-code-block'); return el ? getComputedStyle(el).backgroundColor : null })(),
          codeHeadBg: (() => { const el = document.querySelector('.md .md-code-head'); return el ? getComputedStyle(el).backgroundColor : null })(),
        }))()`)
        await shot('md-top')

        // 引用角标：数字胶囊 + 来源图标
        await log('角标', `(() => {
          const cites = [...document.querySelectorAll('.md .md-cite')];
          const icons = [...document.querySelectorAll('.md .md-cite-icon')];
          return {
            cites: cites.length,
            brands: document.querySelectorAll('.md .md-cite-brand').length,
            icons: icons.length,
            labels: cites.slice(0, 10).map((el) => (el.textContent || '').trim()),
            iconLoaded: icons.map((img) => ({ complete: img.complete, w: img.naturalWidth })),
          };
        })()`)
        await run(`(() => {
          const m = document.getElementById('messages');
          const el = document.querySelector('.md .md-cite');
          if (el) {
            const top = el.getBoundingClientRect().top - m.getBoundingClientRect().top + m.scrollTop;
            m.scrollTop = Math.max(0, top - 140);
          }
          return true;
        })()`)
        await new Promise((resolve) => setTimeout(resolve, 700))
        await shot('md-cite')

        // 滚到第一个表格/代码/公式附近再截一张
        await run(`(() => {
          const m = document.getElementById('messages')
          const el = document.querySelector('.md .md-code-block, .md table, .md pre, .md .md-math-display')
          if (el) {
            const top = el.getBoundingClientRect().top - m.getBoundingClientRect().top + m.scrollTop
            m.scrollTop = Math.max(0, top - 60)
          }
          return true
        })()`)
        await new Promise((resolve) => setTimeout(resolve, 400))
        await shot('md-block')

        // 首屏 2 页 + 内存懒加载
        const groupsBefore = await run(`document.querySelectorAll('.msg-group').length`)
        await run(`(() => {
          const m = document.getElementById('messages');
          m.scrollTop = 100;
          m.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
          return true;
        })()`)
        await new Promise((resolve) => setTimeout(resolve, 900))
        const groupsAfter = await run(`(() => ({
          groups: document.querySelectorAll('.msg-group').length,
          loaderHidden: document.getElementById('historyLoader').hidden,
        }))()`)
        console.log(
          '[历史测试] 内存懒加载:',
          JSON.stringify({ before: groupsBefore, after: groupsAfter }),
        )
        console.log('[历史测试] 预览是否切页:', JSON.stringify({ before: urlBefore, after: win.pageView.webContents.getURL() }))

        // 代码块复制按钮：用真实鼠标事件点击，读剪贴板验证
        const previousClipboard = await clipboard.readText()
        const point = (await run(`(() => {
          const button = document.querySelector('.md-code-copy');
          if (!button) return null;
          const r = button.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        })()`)) as { x: number; y: number } | null
        if (point) {
          quick.window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
          quick.window.webContents.sendInputEvent({
            type: 'mouseDown',
            x: point.x,
            y: point.y,
            button: 'left',
            clickCount: 1,
          })
          quick.window.webContents.sendInputEvent({
            type: 'mouseUp',
            x: point.x,
            y: point.y,
            button: 'left',
            clickCount: 1,
          })
          await new Promise((resolve) => setTimeout(resolve, 450))
          const copied = await clipboard.readText()
          const state = await run(`(() => {
            const button = document.querySelector('.md-code-copy');
            return button ? { copied: button.classList.contains('copied'), label: button.getAttribute('aria-label') } : null;
          })()`)
          console.log(
            '[历史测试] 代码复制:',
            JSON.stringify({ len: copied.length, preview: copied.slice(0, 24), state }),
          )
          await clipboard.writeText(previousClipboard)
        }

        // 有内容态再打开历史（不应改窗口尺寸）
        await run(`document.getElementById('history').click()`)
        await new Promise((resolve) => setTimeout(resolve, 1800))
        await log('内容态弹框', listState)
        await shot('content-history')

        // 扩大：应该先把主页面切到当前预览的历史会话，再显示主窗口
        const urlBeforeExpand = win.pageView.webContents.getURL()
        await run(`document.getElementById('tbExpand')?.click()`)
        await new Promise((resolve) => setTimeout(resolve, 1600))
        console.log(
          '[历史测试] 扩大切换:',
          JSON.stringify({ before: urlBeforeExpand, after: win.pageView.webContents.getURL() }),
        )
        process.exit(0)
      })()
    })
  }, 500)

  // 兜底：列表一直不出来也别卡死
  setTimeout(() => process.exit(0), 30000)
}


/** 自检：注入一段 Markdown HTML，验证代码/表格/公式/链接和浅色配色 */
function runMarkdownUiSelfCheck(quick: QuickWindow | null): void {
  if (!quick) return

  const sample = `
    <div class="ds-markdown ds-assistant-message-main-content">
      <h2>代码与表格</h2>
      <p>行内 <code>inlineCode</code>，链接 <a href="https://example.com" target="_blank">example.com</a></p>
      <div class="md-code-block md-code-block-dark">
        <div>类型提示</div>
        <pre><code><span class="token comment">// 示例</span>
<span class="token keyword">const</span> <span class="token function">add</span> <span class="token operator">=</span> <span class="token punctuation">(</span><span class="token parameter">a</span><span class="token punctuation">,</span> <span class="token parameter">b</span><span class="token punctuation">)</span> <span class="token operator">=&gt;</span> <span class="token parameter">a</span> <span class="token operator">+</span> <span class="token parameter">b</span><span class="token punctuation">;</span>
<span class="token function">add</span><span class="token punctuation">(</span><span class="token number">1</span><span class="token punctuation">,</span> <span class="token number">2</span><span class="token punctuation">)</span><span class="token punctuation">;</span></code></pre>
        <svg viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></svg>
      </div>
      <table>
        <thead><tr><th>列一</th><th>列二</th></tr></thead>
        <tbody><tr><td>内容</td><td>值</td></tr></tbody>
      </table>
      <p>公式：<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></mrow></semantics></math></span><span class="katex-html">坏掉的排版</span></span></p>
      <span class="katex-display ds-markdown-math"><span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><semantics><mrow><mfrac><mn>1</mn><mn>2</mn></mfrac></mrow></semantics></math></span><span class="katex-html">坏掉的排版</span></span></span>
      <script>alert('xss')</script>
      <span class="ds-markdown-html">&lt;kbd&gt;</span>
    </div>
  `

  setTimeout(() => quick.show(), 1200)
  setTimeout(() => quick.setMode('content'), 2000)
  setTimeout(() => {
    nativeTheme.themeSource = 'light'
    quick.sendEvent({
      type: 'history-loaded',
      messages: [
        { role: 'user', text: '代码和高亮测试' },
        { role: 'ai', text: '示例', html: sample },
      ],
      hasOlder: false,
    })
  }, 2600)

  setTimeout(() => {
    void quick.window.webContents
      .executeJavaScript(
        `(() => {
          const pre = document.querySelector('.md pre');
          const bubble = document.querySelector('.msg-user .bubble');
          const fade = document.getElementById('messagesFade');
          const composer = document.querySelector('.composer');
          const fr = fade ? fade.getBoundingClientRect() : null;
          const cr = composer ? composer.getBoundingClientRect() : null;
          const messageBox = document.getElementById('messages');
          const answerBody = document.querySelector('.msg-ai .body');
          const mb = messageBox ? messageBox.getBoundingClientRect() : null;
          const ab = answerBody ? answerBody.getBoundingClientRect() : null;
          return {
            margins: mb && ab ? {
              left: Math.round(ab.left - mb.left),
              right: Math.round(mb.right - ab.right),
              clientWidth: messageBox.clientWidth,
              offsetWidth: messageBox.offsetWidth,
            } : null,
            fade: fade && fr && cr ? {
              rect: [Math.round(fr.left), Math.round(fr.top), Math.round(fr.width), Math.round(fr.height)],
              bottom: Math.round(fr.bottom),
              composerTop: Math.round(cr.top),
              opacity: getComputedStyle(fade).opacity,
              z: getComputedStyle(fade).zIndex,
              bg: getComputedStyle(fade).backgroundImage,
            } : null,
            preBg: pre ? getComputedStyle(pre).backgroundColor : null,
            bubbleBg: bubble ? getComputedStyle(bubble).backgroundColor : null,
            tokens: document.querySelectorAll('.md .token').length,
            tables: document.querySelectorAll('.md table').length,
            math: document.querySelectorAll('.md math').length,
            links: document.querySelectorAll('.md a').length,
            scripts: document.querySelectorAll('.md script').length,
            svg: document.querySelectorAll('.md svg').length,
            katexLeftover: document.querySelectorAll('.md .katex').length,
            groups: document.querySelectorAll('.msg-group').length,
          };
        })()`,
      )
      .then(async (state) => {
        console.log('[MD UI测试] ' + JSON.stringify(state))
        try {
          writeFileSync(
            '/tmp/ds-md-ui-light.png',
            (await quick.window.webContents.capturePage()).toPNG(),
          )
        } catch (error) {
          console.log('[MD UI测试] 截图失败:', String(error))
        }
        nativeTheme.themeSource = 'system'
        setTimeout(() => process.exit(0), 400)
      })
  }, 3400)
}


/** 自检：接口 Markdown 渲染（标题/列表/任务/表格/代码/公式/引用/脚注） */
function runApiMarkdownSelfCheck(quick: QuickWindow | null): void {
  if (!quick) return
  const sample = [
    '## 标题',
    '',
    '**加粗** *斜体* ~~删除线~~ [citation:1] [reference:2]',
    '',
    '- 无序列表',
    '- [x] 已完成任务',
    '',
    '> 一段引用',
    '',
    '| 列一 | 列二 |',
    '|---|---|',
    '| 内容 | 值 |',
    '',
    '```js',
    'const answer = 42;',
    'console.log(answer);',
    '```',
    '',
    '行内公式 $E=mc^2$',
    '',
    '\\[',
    '\\frac{1}{2}',
    '\\]',
    '',
    '脚注[^1]',
    '',
    '[^1]: 这是脚注内容',
  ].join('\n')

  setTimeout(() => quick.show(), 1200)
  setTimeout(() => quick.setMode('content'), 2000)
  setTimeout(() => {
    quick.sendEvent({
      type: 'history-loaded',
      messages: [
        { role: 'user', text: 'Markdown 渲染测试' },
        { role: 'ai', text: '', markdown: sample },
      ],
      hasOlder: false,
    })
  }, 2600)

  setTimeout(() => {
    void quick.window.webContents
      .executeJavaScript(
        `(() => ({
          katex: document.querySelectorAll('.md .katex').length,
          cites: document.querySelectorAll('.md .md-cite').length,
          tables: document.querySelectorAll('.md table').length,
          codeBlocks: document.querySelectorAll('.md .md-code-block').length,
          codeCopies: document.querySelectorAll('.md .md-code-copy').length,
          tasks: document.querySelectorAll('.md .task-list-item').length,
          checkboxes: document.querySelectorAll('.md .task-list-item-checkbox').length,
          footnotes: document.querySelectorAll('.md .footnotes').length,
          headings: document.querySelectorAll('.md h2').length,
          lists: document.querySelectorAll('.md ul').length,
          quote: document.querySelectorAll('.md blockquote').length,
        }))()`,
      )
      .then(async (state) => {
        console.log('[API MD测试] ' + JSON.stringify(state))
        try {
          writeFileSync(
            '/tmp/ds-api-md.png',
            (await quick.window.webContents.capturePage()).toPNG(),
          )
        } catch (error) {
          console.log('[API MD测试] 截图失败:', String(error))
        }
        process.exit(0)
      })
  }, 3600)
}

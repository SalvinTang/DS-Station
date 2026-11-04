import { app, ipcMain } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DEEPSEEK_URL } from '../shared/constants'
import { translate, type Language } from '../shared/i18n'
import type {
  HotkeyUpdateResult,
  QuickMode,
  QuickSubmitPayload,
  SettingsSnapshot,
} from '../shared/types'
import { setQuitting } from './app-state'
import { writeDomReport } from './deepseek/inspector'
import { DeepSeekPage, delay } from './deepseek/page-driver'
import { buildAppMenu } from './menu'
import { getDeepseekSession } from './session'
import { currentLanguage, load, messages, save } from './settings'
import { registerQuickHotkey, toDisplayAccelerator, unregisterAllHotkeys } from './shortcut'
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
app.setName('DS Desktop')

// 测试辅助：把数据目录指到别处。正式运行不会设置这个变量，
// userData 落在 ~/Library/Application Support/DS Desktop/
if (process.env.DS_USER_DATA) {
  app.setPath('userData', process.env.DS_USER_DATA)
}

let mainWindow: MainWindow | null = null
let quickWindow: QuickWindow | null = null
let startupFlow: StartupFlow | null = null

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
    // 开发/预览时 Dock 还显示 Electron 的默认图标，这里换成自己的。
    // 打包后由 build/icon.icns 提供，不需要这一步。
    if (!app.isPackaged) {
      const devIcon = join(app.getAppPath(), 'build/icon.png')
      if (existsSync(devIcon)) app.dock?.setIcon(devIcon)
    }

    mainWindow = new MainWindow()

    createTray({ showMainWindow: () => mainWindow?.show() })

    // 快捷窗口纯自绘、开销可忽略，直接建好 —— 免得第一次按快捷键要等
    quickWindow = new QuickWindow(
      () => mainWindow?.isVisible ?? false,
      () => void startNewChatOnPage(),
    )

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

    // 「新对话」按钮自检：发一条、点新对话、再发一条，看会话 URL 有没有变
    // ★ 会往账号里发两条测试消息
    if (process.env.DS_NEWCHAT_TEST === '1') {
      void runNewChatSelfCheck(mainWindow, quickWindow)
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
  ipcMain.handle('ds:get-version', () => app.getVersion())
  ipcMain.handle('ds:get-messages', () => messages())

  ipcMain.handle('ds:get-settings', (): SettingsSnapshot => settingsSnapshot())
  ipcMain.handle('ds:set-hotkey', (_event, accelerator: unknown): HotkeyUpdateResult =>
    handleSetHotkey(typeof accelerator === 'string' ? accelerator : ''),
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
  ipcMain.handle('ds:logout', () => handleLogout())

  // ── 快捷窗口 ──────────────────────────────────────────────

  ipcMain.on('ds:quick-hide', () => quickWindow?.hide())

  ipcMain.on('ds:window-drag-start', (_event, screenX: unknown, screenY: unknown) => {
    if (typeof screenX === 'number' && typeof screenY === 'number') {
      quickWindow?.beginDrag(screenX, screenY)
    }
  })

  ipcMain.on('ds:window-drag-move', (_event, screenX: unknown, screenY: unknown) => {
    if (typeof screenX === 'number' && typeof screenY === 'number') {
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
    // 设计稿：扩大 = 切到主窗口，快捷窗口关闭。
    // 因为两边本来就是同一个对话线程（决策 D1），所以不需要"搬运"任何东西。
    quickWindow?.hide()
    mainWindow?.show()
  })

  ipcMain.on('ds:quick-submit', (_event, payload: QuickSubmitPayload) => {
    void handleQuickSubmit(payload)
  })
}

// ── 设置 ────────────────────────────────────────────────────────

function settingsSnapshot(): SettingsSnapshot {
  const settings = load()
  return {
    messages: messages(),
    language: currentLanguage(),
    languageSetting: settings.language,
    hotkey: settings.quickWindow.hotkey,
    hotkeyDisplay: toDisplayAccelerator(settings.quickWindow.hotkey),
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

/** 退出登录：清掉 DeepSeek 分区里的登录态，页面会回到登录页 */
async function handleLogout(): Promise<void> {
  try {
    await getDeepseekSession().clearStorageData()
  } catch (err) {
    console.error('[设置] 清理登录态失败:', err)
  }

  save({ login: { knownLoggedIn: false } })
  startupFlow?.onLoggedOut()
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

  try {
    /*
     * 空态发出的消息 = 新对话的第一条。
     * 必须先把 DeepSeek 切到新会话，否则会接着主窗口里正在看的会话写。
     * 刚启动时页面可能还没就绪，所以输入框用重试的方式等它出现。
     */
    if (payload.startNewChat) {
      const started = await page.startNewChat()
      console.log(`[快捷窗口] 空态发送，开新对话 → ${started ? '成功' : '没找到按钮，直接发'}`)
      await delay(600)
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

    const appeared = await page.waitForAnswerChange(baseline)
    if (!appeared) throw new Error('等不到新的回答')

    const got = await page.streamLastAnswer((text) => {
      quick.sendEvent({ type: 'answer-update', text })
    })

    if (!got) throw new Error('没有读到回答')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[快捷窗口] 提问失败:', message)
    quick.sendEvent({ type: 'error', message })
    return
  }

  quick.sendEvent({ type: 'answer-done' })
}

/** 让 DeepSeek 网页开一个新对话，并把面板收回空态 */
async function startNewChatOnPage(): Promise<void> {
  const win = mainWindow
  if (!win) return

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
          version: document.getElementById('version').textContent,
          logout: document.getElementById('logout').textContent,
        }))()`,
      )
      console.log('[设置自检] 界面:', JSON.stringify(probe, null, 1))

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

      // 还原
      save({ language: 'system' })
      rebuildMenu()
    })()
  }, 4000)
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

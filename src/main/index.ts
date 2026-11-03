import { app, ipcMain } from 'electron'
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

const toggleQuickWindow = (): void => quickWindow?.toggle()

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
    mainWindow = new MainWindow()

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

    app.on('activate', () => mainWindow?.show())

    // ── 开发辅助（正式运行不会设置这些环境变量）────────────────

    // 在命令行下没法按 ⌥Space、也没法打字，用它跑一遍面板的生命周期
    if (process.env.DS_SHOW_QUICK === '1') {
      runQuickWindowSelfCheck(quickWindow)
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
  })

  // macOS 惯例：不因窗口关闭而退出应用。
  // 主窗口本来就只是隐藏（决策 D3），快捷窗口后续还要靠它常驻。
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

// ── 菜单 ────────────────────────────────────────────────────────

function rebuildMenu(): void {
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
  void mainWindow?.pageView.webContents.loadURL(DEEPSEEK_URL)
  quickWindow?.sendEvent({ type: 'conversation-cleared' })
  quickWindow?.setMode('empty')
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
    await page.setSwitch('deepThinkToggle', payload.deepThink)
    await page.setSwitch('smartSearchToggle', payload.smartSearch)

    if (!(await page.setComposerText(payload.text))) {
      throw new Error('没找到输入框，页面可能还没加载好')
    }

    // 给页面一点时间跑完它自己的状态更新，再点发送
    await delay(350)

    if (!(await page.clickSend())) {
      throw new Error('没找到发送按钮')
    }

    quick.sendEvent({ type: 'answer-start' })

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

  const page = new DeepSeekPage(win.pageView)
  await page.startNewChat()
  await delay(300)

  quickWindow?.sendEvent({ type: 'conversation-cleared' })
  quickWindow?.setMode('empty')
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

  setTimeout(() => quick?.setMode('empty'), 10600)
}

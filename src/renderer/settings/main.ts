/**
 * 设置窗口。
 *
 * 快捷窗口的呼出快捷键、新对话/历史对话本地快捷键，以及
 * 重置时间、语言、主题、版本号和退出登录。
 * 所有文案走主进程发来的文案表，所以切换语言后重开这个窗口会跟着变。
 */

import type { Language } from '../../shared/i18n'
import type { ThemeSetting } from '../../shared/types'

let messages: Record<string, string> = {}

function t(key: string, vars?: Record<string, string | number>): string {
  let text = messages[key] ?? key
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const titleEl = el('title')
const groupShortcuts = el('groupShortcuts')
const groupAppearance = el('groupAppearance')
const lbHotkey = el('lbHotkey')
const lbNewChatShortcut = el('lbNewChatShortcut')
const lbHistoryShortcut = el('lbHistoryShortcut')
const lbReset = el('lbReset')
const lbLanguage = el('lbLanguage')
const lbTheme = el('lbTheme')
const lbVersion = el('lbVersion')
const hintHotkey = el('hintHotkey')
const hintNewChat = el('hintNewChat')
const hintHistory = el('hintHistory')
const hintReset = el('hintReset')

const resetSelect = el<HTMLSelectElement>('resetAfter')
const languageSelect = el<HTMLSelectElement>('language')
const themeSelect = el<HTMLSelectElement>('theme')
const versionEl = el('version')
const statusEl = el('status')

const logoutButton = el<HTMLButtonElement>('logout')
const overlay = el('overlay')
const confirmTitle = el('confirmTitle')
const confirmDetail = el('confirmDetail')
const cancelButton = el<HTMLButtonElement>('cancel')
const confirmLogoutButton = el<HTMLButtonElement>('confirmLogout')

// ── 时间选项（默认 10 分钟）────────────────────────────────────

const RESET_CHOICES = [0, 5, 10, 30, 60, 120]

function resetLabel(minutes: number): string {
  if (minutes === 0) return t('time.never')
  if (minutes < 60) return t('time.minutes', { n: minutes })
  return t('time.hours', { n: minutes / 60 })
}

// ── 快捷键录入 ────────────────────────────────────────────────

type ShortcutField = 'hotkey' | 'newChat' | 'history'

const shortcutButtons: Record<ShortcutField, HTMLButtonElement> = {
  hotkey: el<HTMLButtonElement>('hotkey'),
  newChat: el<HTMLButtonElement>('newChatShortcut'),
  history: el<HTMLButtonElement>('historyShortcut'),
}

const shortcutDisplays: Record<ShortcutField, string> = {
  hotkey: '',
  newChat: '',
  history: '',
}

let recording: ShortcutField | null = null

function stopRecording(field: ShortcutField, display?: string): void {
  if (recording === field) recording = null
  const button = shortcutButtons[field]
  button.classList.remove('recording')
  if (display !== undefined) shortcutDisplays[field] = display
  button.textContent = shortcutDisplays[field] || '—'
}

function beginRecording(field: ShortcutField): void {
  if (recording === field) {
    stopRecording(field)
    return
  }
  if (recording) stopRecording(recording)

  recording = field
  const button = shortcutButtons[field]
  button.classList.add('recording')
  button.textContent = t('settings.shortcutRecording')
  setStatus('')
}

function setStatus(text: string, ok?: boolean): void {
  statusEl.textContent = text
  statusEl.classList.toggle('ok', ok === true)
  statusEl.classList.toggle('err', ok === false)
}

/**
 * 把一次键盘事件翻译成 Electron accelerator。
 * 返回 null 表示这次按键不构成有效组合（纯修饰键、或没有任何修饰键）。
 */
function toAccelerator(event: KeyboardEvent): string | null {
  const parts: string[] = []
  if (event.metaKey) parts.push('Command')
  if (event.ctrlKey) parts.push('Control')
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')

  // 必须带修饰键 —— 否则会抢走普通的字母输入
  if (parts.length === 0) return null

  const key = mapKey(event.code)
  if (!key) return null

  parts.push(key)
  return parts.join('+')
}

function mapKey(code: string): string | null {
  // 只按下修饰键本身不算
  if (/^(Alt|Control|Shift|Meta)(Left|Right)?$/.test(code)) return null

  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit\d$/.test(code)) return code.slice(5)
  if (/^F\d{1,2}$/.test(code)) return code

  const named: Record<string, string> = {
    Space: 'Space',
    Enter: 'Return',
    NumpadEnter: 'Return',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Escape: 'Escape',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Semicolon: ';',
    Quote: "'",
    Backquote: '`',
    Backslash: '\\',
    Comma: ',',
    Period: '.',
    Slash: '/',
  }

  return named[code] ?? null
}

for (const field of Object.keys(shortcutButtons) as ShortcutField[]) {
  shortcutButtons[field].addEventListener('click', () => beginRecording(field))
}

window.addEventListener('keydown', (event) => {
  if (!recording) return

  event.preventDefault()
  event.stopPropagation()

  if (event.key === 'Escape') {
    stopRecording(recording)
    return
  }

  const accelerator = toAccelerator(event)
  if (!accelerator) {
    setStatus(t('settings.hotkeyNeedModifier'), false)
    return
  }

  const field = recording

  if (field === 'hotkey') {
    void window.ds?.setHotkey(accelerator).then((result) => {
      stopRecording('hotkey', result.display)
      setStatus(result.message, result.ok)
    })
    return
  }

  const name = field === 'newChat' ? 'newChat' : 'history'
  void window.ds?.setQuickShortcut(name, accelerator).then((result) => {
    stopRecording(field, result.display)
    setStatus(result.message, result.ok)
  })
})

// ── 下拉框 ────────────────────────────────────────────────────

resetSelect.addEventListener('change', () => {
  void window.ds?.setResetAfter(Number(resetSelect.value))
})

languageSelect.addEventListener('change', () => {
  void window.ds?.setLanguage(languageSelect.value as Language)
})

themeSelect.addEventListener('change', () => {
  void window.ds?.setTheme(themeSelect.value as ThemeSetting)
})

// ── 退出登录 ──────────────────────────────────────────────────

logoutButton.addEventListener('click', () => {
  overlay.hidden = false
  confirmLogoutButton.focus()
})

cancelButton.addEventListener('click', () => {
  overlay.hidden = true
})

confirmLogoutButton.addEventListener('click', () => {
  overlay.hidden = true
  void window.ds?.logout()
})

overlay.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') overlay.hidden = true
})

// ── 初始化 ────────────────────────────────────────────────────

async function init(): Promise<void> {
  const snapshot = await window.ds!.getSettings()
  messages = snapshot.messages

  titleEl.textContent = t('settings.title')
  groupShortcuts.textContent = t('settings.groupShortcuts')
  groupAppearance.textContent = t('settings.groupAppearance')
  lbHotkey.textContent = t('settings.hotkey')
  lbNewChatShortcut.textContent = t('settings.newChatShortcut')
  lbHistoryShortcut.textContent = t('settings.historyShortcut')
  lbReset.textContent = t('settings.resetAfter')
  lbLanguage.textContent = t('settings.language')
  lbTheme.textContent = t('settings.theme')
  lbVersion.textContent = t('settings.version')
  hintHotkey.textContent = t('settings.hotkeyHint')
  hintNewChat.textContent = t('settings.newChatShortcutHint')
  hintHistory.textContent = t('settings.historyShortcutHint')
  hintReset.textContent = t('settings.resetHint')
  logoutButton.textContent = t('settings.logout')
  confirmTitle.textContent = t('settings.logoutConfirm')
  confirmDetail.textContent = t('settings.logoutDetail')
  cancelButton.textContent = t('settings.cancel')
  confirmLogoutButton.textContent = t('settings.logout')

  shortcutDisplays.hotkey = snapshot.hotkeyDisplay
  shortcutDisplays.newChat = snapshot.newChatShortcutDisplay
  shortcutDisplays.history = snapshot.historyShortcutDisplay
  for (const field of Object.keys(shortcutButtons) as ShortcutField[]) {
    shortcutButtons[field].textContent = shortcutDisplays[field] || '—'
  }

  resetSelect.replaceChildren(
    ...RESET_CHOICES.map((minutes) => {
      const option = document.createElement('option')
      option.value = String(minutes)
      option.textContent = resetLabel(minutes)
      return option
    }),
  )
  resetSelect.value = String(snapshot.resetAfterMinutes)

  const languages: { value: Language; label: string }[] = [
    { value: 'system', label: t('language.system') },
    { value: 'zh', label: t('language.zh') },
    { value: 'en', label: t('language.en') },
  ]
  languageSelect.replaceChildren(
    ...languages.map(({ value, label }) => {
      const option = document.createElement('option')
      option.value = value
      option.textContent = label
      return option
    }),
  )
  languageSelect.value = snapshot.languageSetting

  const themes: { value: ThemeSetting; label: string }[] = [
    { value: 'system', label: t('theme.system') },
    { value: 'light', label: t('theme.light') },
    { value: 'dark', label: t('theme.dark') },
  ]
  themeSelect.replaceChildren(
    ...themes.map(({ value, label }) => {
      const option = document.createElement('option')
      option.value = value
      option.textContent = label
      return option
    }),
  )
  themeSelect.value = snapshot.theme

  versionEl.textContent = snapshot.version
}

void init()

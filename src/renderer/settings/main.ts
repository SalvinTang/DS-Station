/**
 * 设置窗口。
 *
 * 四项设置 + 退出登录。所有文案走主进程发来的文案表，
 * 所以切换语言后重开这个窗口就会跟着变。
 */

import type { Language } from '../../shared/i18n'

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
const lbHotkey = el('lbHotkey')
const lbReset = el('lbReset')
const lbLanguage = el('lbLanguage')
const lbVersion = el('lbVersion')

const hotkeyButton = el<HTMLButtonElement>('hotkey')
const hintHotkey = el('hintHotkey')
const hintReset = el('hintReset')
const resetSelect = el<HTMLSelectElement>('resetAfter')
const languageSelect = el<HTMLSelectElement>('language')
const versionEl = el('version')
const statusEl = el('status')

const logoutButton = el<HTMLButtonElement>('logout')
const overlay = el('overlay')
const confirmTitle = el('confirmTitle')
const confirmDetail = el('confirmDetail')
const cancelButton = el<HTMLButtonElement>('cancel')
const confirmLogoutButton = el<HTMLButtonElement>('confirmLogout')

// ── 时间选项（设计稿默认 10 分钟）────────────────────────────

const RESET_CHOICES = [0, 5, 10, 30, 60, 120]

function resetLabel(minutes: number): string {
  if (minutes === 0) return t('time.never')
  if (minutes < 60) return t('time.minutes', { n: minutes })
  return t('time.hours', { n: minutes / 60 })
}

// ── 快捷键录入 ────────────────────────────────────────────────

let recording = false
let savedHotkeyDisplay = ''

function stopRecording(display?: string): void {
  recording = false
  hotkeyButton.classList.remove('recording')
  if (display) savedHotkeyDisplay = display
  hotkeyButton.textContent = savedHotkeyDisplay || '—'
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

hotkeyButton.addEventListener('click', () => {
  recording = !recording
  if (recording) {
    hotkeyButton.classList.add('recording')
    hotkeyButton.textContent = t('settings.hotkeyRecording')
    setStatus('')
  } else {
    stopRecording()
  }
})

window.addEventListener('keydown', (event) => {
  if (!recording) return

  event.preventDefault()
  event.stopPropagation()

  if (event.key === 'Escape') {
    stopRecording()
    return
  }

  const accelerator = toAccelerator(event)
  if (!accelerator) {
    setStatus(t('settings.hotkeyNeedModifier'), false)
    return
  }

  void window.ds?.setHotkey(accelerator).then((result) => {
    stopRecording(result.display)
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
  lbHotkey.textContent = t('settings.hotkey')
  lbReset.textContent = t('settings.resetAfter')
  lbLanguage.textContent = t('settings.language')
  lbVersion.textContent = t('settings.version')
  hintHotkey.textContent = t('settings.hotkeyHint')
  hintReset.textContent = t('settings.resetHint')
  logoutButton.textContent = t('settings.logout')
  confirmTitle.textContent = t('settings.logoutConfirm')
  confirmDetail.textContent = t('settings.logoutDetail')
  cancelButton.textContent = t('settings.cancel')
  confirmLogoutButton.textContent = t('settings.logout')

  savedHotkeyDisplay = snapshot.hotkeyDisplay
  hotkeyButton.textContent = savedHotkeyDisplay

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

  versionEl.textContent = snapshot.version
}

void init()

import type { TrayAction } from '../../shared/types'

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

let messages: Record<string, string> = {}

function setText(id: string, value: string): void {
  el(id).textContent = value
}

async function loadState(): Promise<void> {
  const state = await window.ds?.getTrayState()
  if (!state) return
  messages = state.messages
  const connected = state.loggedIn

  document.body.dataset.connected = connected ? 'true' : 'false'

  const accountName = el('accountName')
  if (connected) {
    accountName.hidden = false
    accountName.textContent =
      state.accountName || messages['tray.accountFallback'] || 'DeepSeek 账号'
  } else {
    accountName.hidden = true
    accountName.textContent = ''
  }

  setText('linked', connected ? messages['tray.linked'] || '已关联' : messages['tray.unlinked'] || '未关联')
  setText('openMain', messages['tray.openMain'] || '打开主窗口')
  setText('logout', messages['tray.logout'] || '退出账号')
  setText('connect', messages['tray.connect'] || '立即连接')
  setText('settings', messages['tray.settings'] || '设置')
  setText('quit', messages['tray.quit'] || '退出应用')
  setText('version', state.version)

  document.querySelectorAll<HTMLElement>('[data-connected-only]').forEach((row) => {
    row.hidden = !connected
  })
  document.querySelectorAll<HTMLElement>('[data-disconnected-only]').forEach((row) => {
    row.hidden = connected
  })
}

document.addEventListener('click', (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-action]')
  if (!button) return
  const action = button.dataset.action as TrayAction | undefined
  if (action) window.ds?.trayAction(action)
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.ds?.hideTrayMenu()
})

window.ds?.onTrayShown(() => {
  // 菜单刚出现时，鼠标可能正好压在“打开主窗口”上；首次移动鼠标前不要
  // 让首行出现悬浮底色，避免看起来它一直处于选中状态。
  document.body.classList.remove('hover-ready')
  void loadState()
})

document.addEventListener('mousemove', () => {
  document.body.classList.add('hover-ready')
}, { once: true })

void loadState()

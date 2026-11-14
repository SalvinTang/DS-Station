import type { GuideStep } from '../../shared/types'

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const pageIntro = el('pageIntro')
const pageConnect = el('pageConnect')
const keycaps = el('keycaps')

let messages: Record<string, string> = {}
let language = 'zh'
let hotkeyDisplay = '⌥ Space'

function setText(id: string, value: string): void {
  el(id).textContent = value
}

function modifierLabel(token: string): string {
  switch (token) {
    case '⌘':
      return '⌘ command'
    case '⌃':
      return '⌃ control'
    case '⌥':
      return '⌥ option'
    case '⇧':
      return '⇧ shift'
    case '↩':
      return '↩'
    default:
      return token
  }
}

function keyLabel(token: string): string {
  if (token === 'Space') return language === 'zh' ? '空格' : 'Space'
  if (token === 'Return' || token === 'Enter') return '↩'
  if (token === 'Escape') return language === 'zh' ? 'Esc' : 'Esc'
  return token
}

function renderKeycaps(display: string): void {
  keycaps.replaceChildren()
  const tokens = display.split(/\s+/).filter(Boolean)
  tokens.forEach((token, index) => {
    if (index > 0) {
      const plus = document.createElement('span')
      plus.className = 'plus'
      plus.textContent = '+'
      keycaps.appendChild(plus)
    }
    const key = document.createElement('span')
    key.className = 'keycap'
    key.textContent = modifierLabel(keyLabel(token))
    keycaps.appendChild(key)
  })
}

function applyMessages(): void {
  setText('welcomeIntro', messages['guide.welcome'] || '欢迎使用DS Station')
  setText('welcomeConnect', messages['guide.welcome'] || '欢迎使用DS Station')
  setText('miniPlaceholder', messages['quick.placeholder'] || '给Deepseek发送消息')
  setText('miniDeep', messages['quick.deepThinkShort'] || '深度')
  setText('miniSearch', messages['quick.smartSearchShort'] || '搜索')
  setText('miniHistory', messages['quick.history'] || '历史')
  setText('hotkeyPrefix', messages['guide.hotkeyPrefix'] || '任何位置使用快捷键')
  setText('hotkeySuffix', messages['guide.hotkeySuffix'] || '就能唤出快捷面板。')
  setText('hotkeyHint', messages['guide.hotkeyHint'] || '可以在设置中修改快捷键')
  setText('nextBtn', messages['guide.next'] || '下一步')
  setText('linkTitle', messages['guide.linkTitle'] || '关联到DeepSeek')
  setText('privacyLabel', messages['guide.privacyLabel'] || '隐私说明')
  setText('privacyAccount', messages['guide.privacyAccount'] || '')
  setText('privacyChat', messages['guide.privacyChat'] || '')
  setText('privacyOfficial', messages['guide.privacyOfficial'] || '')
  setText('startBtn', messages['guide.start'] || '开始')
}

function setStep(step: GuideStep): void {
  const connect = step === 2
  pageIntro.hidden = connect
  pageConnect.hidden = !connect
}

async function init(): Promise<void> {
  const settings = await window.ds?.getSettings()
  if (settings) {
    messages = settings.messages
    language = settings.language
    hotkeyDisplay = settings.hotkeyDisplay
  }
  applyMessages()
  renderKeycaps(hotkeyDisplay)
}

window.ds?.onGuideStep(setStep)

el('nextBtn').addEventListener('click', () => window.ds?.guideNext())
el('startBtn').addEventListener('click', () => window.ds?.guideStart())

void init()

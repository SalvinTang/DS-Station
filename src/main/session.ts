import { session, shell, type Session } from 'electron'
import { DEEPSEEK_HOST, IN_APP_AUTH_HOSTS, SESSION_PARTITION } from '../shared/constants'

/**
 * DeepSeek 会话管理。
 *
 * 这里的每一条规则都对应一个已知的坑，改动前请先读注释。
 */

let cached: Session | null = null

export function getDeepseekSession(): Session {
  if (cached) return cached

  const ses = session.fromPartition(SESSION_PARTITION)

  // ── UA 必须只设置一次，且此后永不修改 ────────────────────────────
  // Cloudflare 的 clearance cookie 与 UA 绑定。运行中改一次 UA，
  // 之前通过的验证立即失效，而且页面可能进入无限挑战循环。
  // 版本号取内核自带的真实 Chrome 版本，不要伪造成更新的版本。
  ses.setUserAgent(buildUserAgent())

  cached = ses
  return ses
}

function buildUserAgent(): string {
  const chrome = process.versions.chrome
  return (
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    `Chrome/${chrome} Safari/537.36`
  )
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * 判断某个地址是否应该留在应用内部。
 * 只有 DeepSeek 自己，以及第三方登录域，才允许内部导航。
 */
export function shouldNavigateInApp(target: string): boolean {
  const host = hostOf(target)
  if (!host) return false
  return (
    host === DEEPSEEK_HOST ||
    host.endsWith(`.${DEEPSEEK_HOST}`) ||
    IN_APP_AUTH_HOSTS.includes(host)
  )
}

/** 交给系统默认浏览器打开 */
export function openInBrowser(url: string): void {
  if (/^https?:\/\//i.test(url)) {
    void shell.openExternal(url)
  }
}

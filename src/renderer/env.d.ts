import type { DsApi } from '../shared/types'

declare global {
  interface Window {
    /** 由 src/preload/index.ts 注入；理论上总是存在，用可选链防御 */
    ds?: DsApi
  }
}

export {}

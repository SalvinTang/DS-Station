/// <reference types="electron-vite/node" />

/**
 * 构建时注入的常量（见 electron.vite.config.ts 的 define）。
 * 值来自 build-number.json，由 scripts/bump-build.mjs 每次打包前 +1。
 */
declare const __BUILD_NUMBER__: number

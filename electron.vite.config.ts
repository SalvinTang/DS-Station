import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

/**
 * 构建号在构建时烧进产物，不再运行时去 settings.json 里读 ——
 * 否则同一个安装包在不同机器上会显示不同的版本号。
 * 自增由 scripts/bump-build.mjs 在 `npm run build` 之前完成。
 */
function readBuildNumber(): number {
  try {
    const raw = JSON.parse(readFileSync(resolve(__dirname, 'build-number.json'), 'utf8'))
    const value = Number(raw.build)
    return Number.isInteger(value) && value >= 0 ? value : 0
  } catch {
    return 0
  }
}

/**
 * 三段式构建：主进程 / 预加载 / 渲染层，各自独立打包到 out/ 下。
 *
 * 主进程与预加载强制输出 CJS —— 这样 __dirname 可用，且预加载在
 * sandbox: true 下必须是 CJS（Electron 的限制）。
 *
 * 注意：DeepSeek 网页视图**不使用任何 preload**，
 * 远程页面拿不到哪怕一个本地接口（产品说明书 §16）。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      __BUILD_NUMBER__: JSON.stringify(readBuildNumber()),
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].js' },
      },
    },
  },

  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: {
          titlebar: resolve(__dirname, 'src/renderer/titlebar/index.html'),
          quick: resolve(__dirname, 'src/renderer/quick/index.html'),
          settings: resolve(__dirname, 'src/renderer/settings/index.html'),
        },
      },
    },
  },
})

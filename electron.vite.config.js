import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { spritePlugin } from './scripts/icons/sprite-plugin.mjs'

// 库存 / 定制（原 ajuan-erp）是 TypeScript + React，只在这些目录里生效；moyu 其余代码仍是原生 JS。
const erpAlias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@erp': resolve(__dirname, 'src/renderer/erp')
}

export default defineConfig({
  main: {
    resolve: { alias: erpAlias }
  },
  preload: {
    resolve: { alias: erpAlias },
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          inlineDynamicImports: true
        }
      }
    }
  },
  renderer: {
    // 图标 sprite 在构建期注入三个 HTML 入口（V1）。
    // 开发与生产走同一个插件，产物一致；CSP 不允许 CDN，也不允许内联样式，
    // 所以只能是纯结构的 <svg><symbol>。
    plugins: [spritePlugin(__dirname), react({ include: /src\/renderer\/erp\/.*\.[jt]sx?$/ })],
    resolve: { alias: erpAlias },
    // gs1encoder 的 Emscripten 模块通过 import.meta.url 相对加载同目录 WASM。
    // 开发期若被预构建到 node_modules/.vite/deps，WASM 不会随之复制，
    // 请求会落到 Vite 的 HTML fallback；保留原包路径即可让相对 URL 正常工作。
    optimizeDeps: {
      exclude: ['gs1encoder']
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          pin: resolve(__dirname, 'src/renderer/pin.html'),
          screenshot: resolve(__dirname, 'src/renderer/screenshot.html')
        }
      }
    }
  }
})

import type { MoyuApi } from '../../preload/index'

// window.api 由 src/preload/index.ts 暴露，类型也从那里取，不在这里另抄一份
declare global {
  interface Window {
    api: MoyuApi
  }
}

export {}

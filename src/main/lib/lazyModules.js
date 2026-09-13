// 重型依赖改为首次使用时动态加载，缩短主进程冷启动关键路径（F-018）。
// 单例缓存在这个模块里——格式工厂、条码 PNG 密度写入等多处调用方
// 共用同一份 import()，不会因为各自持有一份 promise 而重复加载。

let sharpModulePromise = null
export async function loadSharp() {
  if (!sharpModulePromise) sharpModulePromise = import('sharp').then((mod) => mod.default)
  return sharpModulePromise
}

let tesseractModulePromise = null
export async function loadTesseract() {
  if (!tesseractModulePromise) tesseractModulePromise = import('tesseract.js')
  return tesseractModulePromise
}

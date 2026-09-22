// COM 联动的错误处理（F-006）
//
// 独立成模块的原因：不依赖 DOM 与 fabric，可在 Node 侧直接测到每个分支。

/**
 * 剥掉 Electron IPC 的包装前缀。
 * 原始文案形如：
 *   Error invoking remote method 'barcode:xxx': Error: 真正的原因
 * 直接展示会让用户看到与自己无关的方法名。
 */
export function cleanIpcError(reason) {
  return String(reason ?? '')
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(Error|TypeError):\s*/, '')
    .trim()
}

/**
 * 把底层报错归类成一句用户能照做的提示。
 *
 * 每个分支都对应主进程或 com-worker 里真实存在的抛错点；
 * harness 会逐条比对，新增抛错点若没归类会落到兜底并被测出来。
 */
export function illustratorFailureHint(reason) {
  const text = cleanIpcError(reason)
  if (/仅支持 Windows/.test(text)) return '该功能仅 Windows 可用'
  if (/无法启动 Illustrator|请确认对应软件已安装/.test(text)) return '请确认已安装并可启动 Illustrator'
  if (/未返回任何结构统计/.test(text)) return 'Illustrator 未返回结果，请确认它没有弹窗等待操作'
  if (/Illustrator 脚本失败/.test(text)) return 'Illustrator 脚本执行失败，请查看提示详情'
  if (/超过 20 MB/.test(text)) return '条码 SVG 过大，请减少批量内容'
  if (/不支持的条码文件数据|条码文件格式与数据不匹配/.test(text)) return '条码数据无效，请重新生成'
  if (/刀模 SVG/.test(text)) return '刀模数据无效，请调整参数后重试'
  if (/只允许从主窗口发起/.test(text)) return '请在主窗口中操作'
  if (/正在执行，请等待/.test(text)) return '已有联动任务在执行，请等待完成'
  if (/执行超时|进程已因超时重启/.test(text)) return 'Illustrator 未响应，请关闭它的弹窗后重试'
  if (/TASK_CANCELLED|任务已取消/.test(text)) return '操作已取消'
  return '联动失败，请查看提示详情'
}

/** 兜底提示文案，harness 用它判断某条错误是否被归类。 */
export const ILLUSTRATOR_FALLBACK_HINT = '联动失败，请查看提示详情'

/** 任务被取消：这不是失败，UI 不应按错误呈现。 */
export function isComCancelled(reason) {
  return /TASK_CANCELLED|任务已取消/.test(cleanIpcError(reason))
}

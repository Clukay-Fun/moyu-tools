/**
 * 描述: 定制页通用文案与小工具 (psdLabels)
 * 主要功能:
 *   - 把技术名词（slot_01、任务状态）翻译成店主能看懂的话
 */

import type { PsdCutoutStatus, PsdJobStatus } from '@shared/erp/psd'

/** slot_03 → 第 3 位；不符合格式时原样返回 */
export function slotLabel(slotKey: string): string {
  const m = /^slot_(\d+)$/.exec(slotKey)
  return m ? `第 ${Number(m[1])} 位` : slotKey
}

export function slotKeyOf(n: number): string {
  return `slot_${String(n).padStart(2, '0')}`
}

export const JOB_STATUS_LABEL: Record<PsdJobStatus, string> = {
  queued: '排队中',
  running: '生成中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消'
}

export const CUTOUT_STATUS_LABEL: Record<PsdCutoutStatus, string> = {
  queued: '排队中',
  running: '处理中',
  ready: '待确认',
  failed: '失败',
  confirmed: '已加入素材',
  cancelled: '已取消'
}

export function fileName(path: string): string {
  const parts = path.split(/[/\\]/)
  return parts[parts.length - 1] || path
}

/** 路径中间省略：保留开头和文件名 */
export function middleEllipsis(text: string, max = 48): string {
  if (text.length <= max) return text
  const tail = Math.ceil(max * 0.6)
  return `${text.slice(0, max - tail - 1)}…${text.slice(-tail)}`
}

/** 2026-10-20T08:03:00Z → 10-20 16:03 */
export function shortTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

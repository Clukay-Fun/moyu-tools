export { formatCents, parseCents } from '@shared/erp/money'

export function formatQty(n: number): string {
  return n.toLocaleString('zh-CN')
}

export function todayString(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** "2026-09-21T10:32:05" → "09-21 10:32" */
export function formatOccurred(local: string): string {
  return `${local.slice(5, 10)} ${local.slice(11, 16)}`
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() + days)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function signedQty(n: number): string {
  return n > 0 ? `+${n.toLocaleString('zh-CN')}` : n.toLocaleString('zh-CN')
}

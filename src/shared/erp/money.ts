// 金额规则：对外金额用整数分（cents），内部平均成本用 1/10000 元（e4）定点整数。
// 1 元 = 100 分 = 10000 e4；1 分 = 100 e4。

export const E4_PER_CENT = 100n

export function centsToE4(cents: number): bigint {
  return BigInt(cents) * E4_PER_CENT
}

/** e4 → 分，四舍五入 */
export function e4ToCents(e4: bigint): number {
  const q = e4 / E4_PER_CENT
  const r = e4 % E4_PER_CENT
  return Number(r * 2n >= E4_PER_CENT ? q + 1n : q)
}

/** 整数分 → "1,234.56" */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const yuan = Math.floor(abs / 100)
  const fen = abs % 100
  return `${sign}${yuan.toLocaleString('zh-CN')}.${String(fen).padStart(2, '0')}`
}

/** "12.3" / "12" / "12.34" → 整数分；非法或超过两位小数返回 null */
export function parseCents(input: string): number | null {
  const s = input.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const [a, b = ''] = s.split('.')
  return Number(a) * 100 + Number(b.padEnd(2, '0'))
}

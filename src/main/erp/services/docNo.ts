import type { Db } from '../db/connection'
import type { DocumentType } from '@shared/erp/types'

const PREFIX: Record<DocumentType, string> = { inbound: 'RK', outbound: 'CK', opening: 'QC', adjustment: 'TZ' }

/** 生成 RK20260921-001 形式的单号。必须在事务内调用以保证同日序号连续。 */
export function nextDocNo(db: Db, type: DocumentType, docDate: string): string {
  const day = docDate.replaceAll('-', '')
  const prefix = `${PREFIX[type]}${day}-`
  // 序号按数字取最大：按字符串比较时 "1000" < "999"，过了 999 会一直生成重复单号
  const row = db
    .prepare(`SELECT MAX(CAST(substr(doc_no, ?) AS INTEGER)) AS m FROM documents WHERE doc_no LIKE ?`)
    .get(prefix.length + 1, `${prefix}%`) as { m: number | null }
  const last = row.m ?? 0
  return `${prefix}${String(last + 1).padStart(3, '0')}`
}

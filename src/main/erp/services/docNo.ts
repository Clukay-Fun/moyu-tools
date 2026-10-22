import type { Db } from '../db/connection'
import type { DocumentType } from '@shared/erp/types'

const PREFIX: Record<DocumentType, string> = { inbound: 'RK', outbound: 'CK', opening: 'QC', adjustment: 'TZ' }

/** 生成 RK20260921-001 形式的单号。必须在事务内调用以保证同日序号连续。 */
export function nextDocNo(db: Db, type: DocumentType, docDate: string): string {
  const day = docDate.replaceAll('-', '')
  const prefix = `${PREFIX[type]}${day}-`
  const row = db.prepare(`SELECT MAX(doc_no) AS m FROM documents WHERE doc_no LIKE ?`).get(`${prefix}%`) as {
    m: string | null
  }
  const last = row.m ? Number(row.m.slice(prefix.length)) : 0
  return `${prefix}${String(last + 1).padStart(3, '0')}`
}

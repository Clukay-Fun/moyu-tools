import type { ReactElement } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusTrap } from '@erp/lib/useFocusTrap'
import { usePresence } from '@erp/lib/usePresence'
import { X, FileUp, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react'
import type { CsvImportPreview, CsvImportResult } from '@shared/erp/types'
import { Button } from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { unwrap, errorMessage } from '@erp/lib/api'
import { formatCents, formatQty } from '@erp/lib/format'
import table from '@erp/components/Table.module.css'
import styles from './ImportDialog.module.css'

interface Props {
  open: boolean
  onClose: () => void
  /** 在抽屉中渲染流程内容，不创建第二层模态框 */
  embedded?: boolean
  /** 成功写入后回调，页面据此刷新 */
  onImported?: (result: CsvImportResult) => void
}

type Phase =
  | { step: 'pick' }
  | { step: 'loading'; path: string }
  | { step: 'preview'; path: string; preview: CsvImportPreview }
  | { step: 'committing'; path: string; preview: CsvImportPreview }
  | { step: 'done'; result: CsvImportResult }

export function ImportDialog({ open, onClose, embedded = false, onImported }: Props): ReactElement | null {
  const toast = useToast()
  const [phase, setPhase] = useState<Phase>({ step: 'pick' })
  const [ack, setAck] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const { mounted, closing } = usePresence(embedded ? true : open)
  useFocusTrap(ref, open && !embedded)

  useEffect(() => {
    if (open) {
      setPhase({ step: 'pick' })
      setAck(false)
      setError(null)
    }
  }, [open])

  const busy = phase.step === 'loading' || phase.step === 'committing'
  const close = useCallback(() => {
    if (!busy) onClose()
  }, [busy, onClose])

  useEffect(() => {
    if (!open || embedded) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, embedded, close])

  async function loadPreview(path: string): Promise<void> {
    setPhase({ step: 'loading', path })
    setError(null)
    setAck(false)
    try {
      const preview = await unwrap(window.api.erp.csv.preview(path))
      setPhase({ step: 'preview', path, preview })
    } catch (err) {
      setError(errorMessage(err))
      setPhase({ step: 'pick' })
    }
  }

  async function pick(): Promise<void> {
    try {
      const path = await unwrap(window.api.erp.csv.pickImportFile())
      if (path) await loadPreview(path)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  async function commit(): Promise<void> {
    if (phase.step !== 'preview') return
    setPhase({ step: 'committing', path: phase.path, preview: phase.preview })
    try {
      const result = await unwrap(window.api.erp.csv.commit(phase.path, ack))
      setPhase({ step: 'done', result })
      onImported?.(result)
    } catch (err) {
      toast(errorMessage(err), 'error')
      // 文件可能在预览后被修改，重新预览让用户看到最新校验结果
      await loadPreview(phase.path)
    }
  }

  async function saveTemplate(): Promise<void> {
    try {
      const p = await unwrap(window.api.erp.csv.saveTemplate())
      if (p) toast(`模板已保存到 ${p}`, 'success')
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  if (!mounted) return null

  const preview = phase.step === 'preview' || phase.step === 'committing' ? phase.preview : null

  const dialog = (
    <div
      ref={ref}
      className={`${styles.dialog} ${embedded ? styles.embeddedDialog : ''}`}
      data-closing={closing || undefined}
      role={embedded ? undefined : 'dialog'}
      aria-modal={embedded ? undefined : true}
      aria-label={embedded ? undefined : '导入 CSV'}
      onClick={embedded ? undefined : (e) => e.stopPropagation()}
    >
      {!embedded && (
        <header className={styles.header}>
          <div className={styles.title}>导入 CSV</div>
          <button type="button" className={styles.close} onClick={close} aria-label="关闭" disabled={busy}>
            <X size={18} />
          </button>
        </header>
      )}

      <div className={styles.body}>
        {error && <div className={`${styles.notice} ${styles.noticeErr}`}>{error}</div>}

        {(phase.step === 'pick' || phase.step === 'loading') && (
          <div className={styles.pick}>
            <FileUp size={36} strokeWidth={1.5} />
            <div>
              <strong>选择标准模板格式的 CSV 文件</strong>
            </div>
            <div className={styles.steps}>
              列顺序：商品编码、类型（期初 / 入库 / 出库）、日期（YYYY-MM-DD）、数量、单价、渠道、外部订单号、备注
              <br />
              尚未录入期初时可带一行「期初」作为起点，日期须最早。
              <br />
              每行生成一张已生效单据；按日期顺序写入；任一行有错误则整批不写入。
              <br />
              支持 UTF-8 与 GBK（Excel 另存为 CSV）编码。
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="primary" onClick={pick} disabled={busy}>
                {phase.step === 'loading' ? '解析中…' : '选择文件'}
              </Button>
              <Button onClick={saveTemplate} disabled={busy}>
                下载模板
              </Button>
            </div>
          </div>
        )}

        {preview && (
          <>
            <div className={styles.stats}>
              <span className={styles.file}>{preview.fileName}</span>
              <span className={styles.muted}>{preview.encoding.toUpperCase()}</span>
              <span>
                共 <strong>{preview.total}</strong> 行
              </span>
              <span className={styles.ok}>
                通过 <strong>{preview.okCount}</strong>
              </span>
              {preview.warningCount > 0 && (
                <span className={styles.warn}>
                  警告 <strong>{preview.warningCount}</strong>
                </span>
              )}
              {preview.errorCount > 0 && (
                <span className={styles.err}>
                  错误 <strong>{preview.errorCount}</strong>
                </span>
              )}
            </div>

            <div className={styles.impact}>
              <div className={styles.impactItem}>
                <div className={styles.impactLabel}>入库</div>
                <div className={styles.impactValue}>+{formatQty(preview.inQty)}</div>
                <div className={styles.muted}>¥{formatCents(preview.inAmountCents)}</div>
              </div>
              <div className={styles.impactItem}>
                <div className={styles.impactLabel}>出库</div>
                <div className={styles.impactValue}>−{formatQty(preview.outQty)}</div>
                <div className={styles.muted}>¥{formatCents(preview.outAmountCents)}</div>
              </div>
              <div className={styles.impactItem}>
                <div className={styles.impactLabel}>当前库存</div>
                <div className={styles.impactValue}>{formatQty(preview.stockBefore)}</div>
              </div>
              <div className={styles.impactItem}>
                <div className={styles.impactLabel}>导入后库存</div>
                <div className={styles.impactValue}>
                  {preview.stockAfter === null ? '—' : formatQty(preview.stockAfter)}
                </div>
              </div>
            </div>

            {preview.errorCount > 0 && (
              <div className={`${styles.notice} ${styles.noticeErr}`}>
                存在错误，当前不会写入任何数据。请修正文件后重新选择。
              </div>
            )}
            {preview.errorCount === 0 && preview.warningCount > 0 && (
              <label className={`${styles.notice} ${styles.noticeWarn}`}>
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                已核对警告行的外部订单号，确认不是重复录入，仍然导入
              </label>
            )}
            {preview.errorCount === 0 && preview.warningCount === 0 && (
              <div className={`${styles.notice} ${styles.noticeOk}`}>全部通过校验，可以导入。</div>
            )}

            <div className={table.wrap}>
              <table className={table.table}>
                <thead>
                  <tr>
                    <th>行号</th>
                    <th>商品</th>
                    <th>类型</th>
                    <th>日期</th>
                    <th className={table.num}>数量</th>
                    <th className={table.num}>单价</th>
                    <th>渠道</th>
                    <th>外部订单号</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr
                      key={r.line}
                      className={r.status === 'error' ? styles.rowErr : r.status === 'warning' ? styles.rowWarn : ''}
                    >
                      <td className={table.muted}>{r.line}</td>
                      <td className={table.mono}>{r.productCode || <span className={table.muted}>—</span>}</td>
                      <td>{r.typeText}</td>
                      <td className={table.mono}>{r.docDate}</td>
                      <td className={table.num}>{r.quantity}</td>
                      <td className={table.num}>{r.unitPrice}</td>
                      <td>{r.channel || <span className={table.muted}>—</span>}</td>
                      <td className={table.mono}>{r.externalOrderNo || <span className={table.muted}>—</span>}</td>
                      <td>
                        {r.status === 'ok' && (
                          <span className={styles.ok}>
                            <CheckCircle2 size={14} style={{ verticalAlign: -2 }} /> 通过
                          </span>
                        )}
                        {r.status !== 'ok' && (
                          <div className={`${styles.msg} ${r.status === 'error' ? styles.err : styles.warn}`}>
                            {r.status === 'error' ? (
                              <XCircle size={14} style={{ verticalAlign: -2 }} />
                            ) : (
                              <AlertTriangle size={14} style={{ verticalAlign: -2 }} />
                            )}{' '}
                            {r.messages.join('；')}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {phase.step === 'done' && (
          <div className={styles.result}>
            <CheckCircle2 size={40} className={styles.ok} />
            <strong>已导入 {phase.result.documentCount} 张单据</strong>
            <div className={styles.muted}>当前库存 {formatQty(phase.result.stockAfter)}</div>
            <div className={`${styles.muted} ${styles.file}`}>
              {phase.result.docNos.slice(0, 5).join('、')}
              {phase.result.docNos.length > 5 ? ` 等` : ''}
            </div>
          </div>
        )}
      </div>

      <footer className={styles.footer}>
        {preview && (
          <button type="button" className={styles.link} onClick={pick} disabled={busy}>
            重新选择文件
          </button>
        )}
        <span className={styles.spacer} />
        <Button onClick={close} disabled={busy}>
          {phase.step === 'done' ? '关闭' : '取消'}
        </Button>
        {preview && (
          <Button
            variant="primary"
            onClick={commit}
            disabled={busy || !preview.canCommit || (preview.warningCount > 0 && !ack)}
          >
            {phase.step === 'committing' ? '写入中…' : `确认导入 ${preview.total} 行`}
          </Button>
        )}
      </footer>
    </div>
  )

  if (embedded) return <div className={styles.embedded}>{dialog}</div>

  return (
    <div className={styles.backdrop} data-closing={closing || undefined} onClick={close}>
      {dialog}
    </div>
  )
}

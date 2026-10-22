import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { TrashEntry } from '@shared/erp/types'
import { Button, ConfirmDialog } from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { unwrap, errorMessage } from '@erp/lib/api'
import styles from './SettingsCard.module.css'

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

/** 恢复备份时被替换掉的旧数据，保留在回收目录里直到用户清空。 */
export function TrashSettings(): ReactElement | null {
  const toast = useToast()
  const [items, setItems] = useState<TrashEntry[]>([])
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    try {
      setItems(await unwrap(window.api.erp.backup.listTrash()))
    } catch {
      setItems([])
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  if (items.length === 0) return null
  const total = items.reduce((a, i) => a + i.sizeBytes, 0)
  return (
    <div className={styles.row}>
      <div>
        <div className={styles.label}>
          恢复前的旧数据（{items.length} 份 · {fmtSize(total)}）
        </div>
        <div className={styles.desc}>
          每次恢复备份时，被替换的数据会先放进回收目录。确认新数据没问题后可以清空。最近一份：
          {new Date(items[0].createdAt).toLocaleString('zh-CN')}
        </div>
      </div>
      <Button onClick={() => setConfirm(true)} disabled={busy}>
        <Trash2 size={16} /> 清空
      </Button>
      <ConfirmDialog
        open={confirm}
        danger
        title="清空回收目录？"
        confirmText="永久删除"
        loading={busy}
        onOpenChange={(o) => !o && setConfirm(false)}
        description={`${items.length} 份旧数据（${fmtSize(total)}）将被永久删除，无法找回。`}
        onCancel={() => setConfirm(false)}
        onConfirm={async () => {
          setBusy(true)
          try {
            await unwrap(window.api.erp.backup.clearTrash())
            toast('回收目录已清空', 'success')
            setConfirm(false)
            await load()
          } catch (err) {
            toast(errorMessage(err), 'error')
          } finally {
            setBusy(false)
          }
        }}
      />
    </div>
  )
}

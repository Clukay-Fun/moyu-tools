import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { TrashEntry } from '@shared/erp/types'
import { Button, ConfirmDialog } from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { unwrap, errorMessage } from '@erp/lib/api'
import { useDataChanged } from '@erp/lib/dataEvents'
import { SettingRow } from './SettingsLayout'

function fmtSize(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

/** 恢复备份时被替换掉的旧数据，保留在回收目录里直到用户清空。 */
export function TrashSettings(): ReactElement {
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
  // 恢复备份后会多出一份旧数据（主进程广播 erp:data:replaced → emitDataChanged）
  useDataChanged(() => void load())
  const total = items.reduce((a, i) => a + i.sizeBytes, 0)
  return (
    <SettingRow
      label={items.length ? `恢复前的旧数据（${items.length} 份 · ${fmtSize(total)}）` : '恢复前的旧数据'}
      desc={
        items.length
          ? `恢复备份时被替换的数据会先放进回收目录，确认新数据没问题后可以清空。最近一份：${new Date(items[0].createdAt).toLocaleString('zh-CN')}`
          : '恢复备份时被替换的数据会先放进回收目录。目前没有。'
      }
    >
      <Button
        icon={<Trash2 size={16} />}
        onClick={() => setConfirm(true)}
        disabled={busy || items.length === 0}
        disabledReason={items.length === 0 ? '回收目录是空的' : undefined}
      >
        清空
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
    </SettingRow>
  )
}

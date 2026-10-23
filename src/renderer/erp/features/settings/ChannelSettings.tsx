/**
 * 描述: 设置 › 销售渠道 (ChannelSettings)
 * 主要功能:
 *   - 顶部添加：输入为空时按钮禁用并说明原因
 *   - 点击名称就地改名（Enter 保存、Esc 取消、失焦保存）
 *   - 行尾按钮停用 / 启用；已停用的排在最后并置灰
 */

import type { FormEvent, ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import type { SalesChannel } from '@shared/erp/types'
import { Button, Input } from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { unwrap, errorMessage } from '@erp/lib/api'
import { SettingRow, SettingsGroup } from './SettingsLayout'
import styles from './ChannelSettings.module.css'

export function ChannelSettings(): ReactElement {
  const toast = useToast()
  const [channels, setChannels] = useState<SalesChannel[]>([])
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setChannels(await unwrap(window.api.erp.channels.list()))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }, [toast])
  useEffect(() => {
    void load()
  }, [load])

  async function act(fn: () => Promise<unknown>, ok: string): Promise<void> {
    setBusy(true)
    try {
      await fn()
      toast(ok, 'success')
      await load()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  function handleAdd(e: FormEvent): void {
    e.preventDefault()
    if (!newName.trim()) return
    void act(async () => {
      await unwrap(window.api.erp.channels.create({ name: newName }))
      setNewName('')
    }, '渠道已添加')
  }

  function saveEdit(c: SalesChannel): void {
    const name = editName.trim()
    setEditingId(null)
    if (!name || name === c.name) return
    void act(() => unwrap(window.api.erp.channels.update(c.id, { name, isActive: c.isActive })), '渠道已改名')
  }

  // 启用的在前，已停用的排最后；同组内保持原顺序
  const sorted = [...channels].sort((a, b) => Number(b.isActive) - Number(a.isActive))

  return (
    <SettingsGroup title="销售渠道">
      <SettingRow label="添加渠道" desc="出库单可选择的渠道。停用后不再出现在新单据中，历史单据不受影响。点名称可以改名。">
        <form className={styles.add} onSubmit={handleAdd}>
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="新渠道名称" maxLength={32} />
          <Button
            variant="primary"
            type="submit"
            icon={<Plus size={16} />}
            disabled={busy || !newName.trim()}
            disabledReason={!newName.trim() ? '先输入渠道名称' : undefined}
          >
            添加
          </Button>
        </form>
      </SettingRow>
      {sorted.map((c) => (
        <div key={c.id} className={`setting-row ${styles.row}`} data-inactive={!c.isActive || undefined}>
          <span className={styles.nameCell}>
            {editingId === c.id ? (
              <Input
                className={styles.editInput}
                value={editName}
                maxLength={32}
                autoFocus
                aria-label="渠道名称"
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => saveEdit(c)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveEdit(c)
                  if (e.key === 'Escape') setEditingId(null)
                }}
              />
            ) : (
              <button
                type="button"
                className={styles.name}
                title="点击改名"
                disabled={busy}
                onClick={() => {
                  setEditingId(c.id)
                  setEditName(c.name)
                }}
              >
                {c.name}
              </button>
            )}
            {!c.isActive && <span className={styles.inactiveTag}>已停用</span>}
          </span>
          <div className="setting-row-control">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                act(
                  () => unwrap(window.api.erp.channels.update(c.id, { name: c.name, isActive: !c.isActive })),
                  c.isActive ? '渠道已停用' : '渠道已启用'
                )
              }
            >
              {c.isActive ? '停用' : '启用'}
            </Button>
          </div>
        </div>
      ))}
    </SettingsGroup>
  )
}

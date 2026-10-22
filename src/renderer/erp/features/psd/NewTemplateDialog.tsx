/**
 * 描述: 新建模板一步弹窗 (NewTemplateDialog)
 * 主要功能:
 *   - 只需模板名称 + 选择 .psd 文件，确认即创建
 *   - 创建后提示去生产页添加位置；不修改源 PSD
 */

import { useState, type FormEvent, type ReactElement } from 'react'
import { FileImage } from 'lucide-react'
import type { PsdBoard } from '@shared/erp/psd'
import { Button, Input, useDrawer } from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { unwrap, errorMessage } from '@erp/lib/api'
import { fileName, middleEllipsis } from './psdLabels'
import styles from './NewTemplateDialog.module.css'

export interface NewTemplateDialogProps {
  onCreated: (board: PsdBoard, templateId: number) => void
}

export function NewTemplateDialog({ onCreated }: NewTemplateDialogProps): ReactElement {
  const toast = useToast()
  const { closeDrawer, setDirty } = useDrawer()
  const [name, setName] = useState('')
  const [sourcePath, setSourcePath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function pickFile(): Promise<void> {
    try {
      const path = await unwrap(window.api.erp.psd.pickTemplate())
      if (!path) return
      setSourcePath(path)
      if (!name.trim()) setName(fileName(path).replace(/\.psd$/i, ''))
      setDirty(true)
      setError(null)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    if (!name.trim()) {
      setError('请填写模板名称')
      return
    }
    if (!sourcePath) {
      setError('请选择 PSD 文件')
      return
    }
    setBusy(true)
    try {
      const board = await unwrap(window.api.erp.psd.createTemplate({ name: name.trim(), sourcePath }))
      const templateId = Math.max(...board.templates.map((t) => t.id))
      setDirty(false)
      toast('模板已创建，去生产页添加位置', 'success')
      onCreated(board, templateId)
      closeDrawer(true)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className={styles.root} onSubmit={submit}>
      <label className={styles.field}>
        <span className={styles.label}>模板名称</span>
        <Input
          value={name}
          maxLength={64}
          autoFocus
          placeholder="例如：六宫格"
          onChange={(e) => {
            setName(e.target.value)
            setDirty(true)
            setError(null)
          }}
        />
      </label>

      <div className={styles.field}>
        <span className={styles.label}>PSD 文件</span>
        <div className={styles.fileRow}>
          <FileImage size={16} className={styles.fileIcon} />
          <span className={styles.filePath} title={sourcePath}>
            {sourcePath ? middleEllipsis(sourcePath, 64) : '还没有选择'}
          </span>
          <Button variant="secondary" size="sm" type="button" onClick={() => void pickFile()}>
            {sourcePath ? '重新选择' : '选择 PSD'}
          </Button>
        </div>
      </div>

      <p className={styles.note}>创建后记得去生产页添加替换位置。生成时只复制模板，不会修改源 PSD。</p>
      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.footer}>
        <Button variant="ghost" type="button" onClick={() => closeDrawer()}>
          取消
        </Button>
        <Button variant="primary" type="submit" loading={busy} disabled={!name.trim() || !sourcePath}>
          创建模板
        </Button>
      </div>
    </form>
  )
}

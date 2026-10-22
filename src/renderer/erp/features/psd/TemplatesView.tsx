/**
 * 描述: 定制 › 模板视图 (TemplatesView)
 * 主要功能:
 *   - 模板卡片：名称、PSD 路径（中间省略）、文件状态、位置数
 *   - 「使用模板」切到生产页并选中；支持重命名（只改配置名称）与删除（不删 PSD）
 *   - 新建模板是一步弹窗，由页面统一打开
 */

import { useState, type ReactElement } from 'react'
import { FileImage, MoreHorizontal, Plus, Trash2 } from 'lucide-react'
import type { PsdBoard, PsdTemplate } from '@shared/erp/psd'
import { Button, ConfirmDialog, EmptyState, IconButton, Input, Menu } from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { unwrap, errorMessage } from '@erp/lib/api'
import { middleEllipsis } from './psdLabels'
import styles from './TemplatesView.module.css'

interface Props {
  board: PsdBoard | null
  busy: boolean
  onAct: (fn: () => Promise<PsdBoard | null>, ok?: string) => Promise<void>
  onBoard: (board: PsdBoard) => void
  onNew: () => void
  onUse: (template: PsdTemplate) => void
}

export function TemplatesView({ board, busy, onAct, onBoard, onNew, onUse }: Props): ReactElement {
  const toast = useToast()
  const [deleting, setDeleting] = useState<PsdTemplate | null>(null)
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [savingName, setSavingName] = useState(false)
  const templates = board?.templates ?? []

  async function saveRename(template: PsdTemplate): Promise<void> {
    const name = renameDraft.trim()
    if (!name) {
      toast('模板名称不能为空', 'error')
      return
    }
    if (name === template.name) {
      setRenamingId(null)
      return
    }
    setSavingName(true)
    try {
      const next = await unwrap(window.api.erp.psd.renameTemplate({ id: template.id, name }))
      onBoard(next)
      toast('模板已重命名', 'success')
      setRenamingId(null)
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setSavingName(false)
    }
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <span className={styles.count}>{templates.length} 个模板</span>
        <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={onNew}>
          新建模板
        </Button>
      </div>

      {board && !templates.length ? (
        <EmptyState
          icon={<FileImage size={24} />}
          title="还没有模板"
          description="选一个 PSD 创建模板，然后在生产页添加替换位置并选择素材。"
          actions={[{ label: '新建模板', onClick: onNew, variant: 'primary' }]}
        />
      ) : (
        <ul className={styles.grid}>
          {templates.map((template) => (
            <li key={template.id} className={styles.card}>
              <div className={styles.cardHead}>
                {renamingId === template.id ? (
                  <div className={styles.renameRow}>
                    <Input
                      value={renameDraft}
                      autoFocus
                      maxLength={64}
                      aria-label="模板名称"
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void saveRename(template)
                        }
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                    />
                    <Button size="sm" variant="primary" loading={savingName} onClick={() => void saveRename(template)}>
                      保存
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRenamingId(null)}>
                      取消
                    </Button>
                  </div>
                ) : (
                  <>
                    <span className={styles.name} title={template.name}>
                      {template.name}
                    </span>
                    <Menu
                      align="end"
                      trigger={<IconButton label="更多" icon={<MoreHorizontal size={16} />} size="sm" />}
                      items={[
                        {
                          key: 'rename',
                          label: '重命名',
                          onClick: () => {
                            setRenameDraft(template.name)
                            setRenamingId(template.id)
                          }
                        },
                        'separator',
                        {
                          key: 'delete',
                          label: '删除模板',
                          icon: <Trash2 size={14} />,
                          danger: true,
                          onClick: () => setDeleting(template)
                        }
                      ]}
                    />
                  </>
                )}
              </div>

              <span className={styles.path} title={template.sourcePath}>
                {middleEllipsis(template.sourcePath, 52)}
              </span>

              <div className={styles.meta}>
                <span className={template.sourceExists ? styles.fileOk : styles.fileMissing}>
                  {template.sourceExists ? '文件可用' : '文件缺失'}
                </span>
                <span>{template.slots.length} 个位置</span>
              </div>

              <div className={styles.cardFooter}>
                <Button size="sm" variant="secondary" onClick={() => onUse(template)}>
                  使用模板
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        danger
        title="删除模板？"
        description={deleting ? `「${deleting.name}」会从列表里去掉。不会删除 PSD 源文件，已经生成的文件也还在。` : ''}
        confirmText="删除模板"
        loading={busy}
        onConfirm={async () => {
          const target = deleting
          if (!target) return
          await onAct(() => unwrap(window.api.erp.psd.deleteTemplate(target.id)), '模板已删除')
          setDeleting(null)
        }}
      />
    </div>
  )
}

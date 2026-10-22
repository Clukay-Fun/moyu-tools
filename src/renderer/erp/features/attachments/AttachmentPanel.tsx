import type { DragEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ImagePlus, X } from 'lucide-react'
import type { Attachment } from '@shared/erp/types'
import { ConfirmDialog } from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { unwrap, errorMessage } from '@erp/lib/api'
import styles from './AttachmentPanel.module.css'

interface Props {
  documentId: number
  /** 只读时不显示上传与删除 */
  readOnly?: boolean
  pendingFiles?: File[]
  onPendingFilesChange?: (files: File[]) => void
}

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'
const MAX = 9

export function attachmentUrl(a: Attachment): string {
  return `moyu-file://attachments/${a.relPath}`
}

export function AttachmentPanel({
  documentId,
  readOnly,
  pendingFiles = [],
  onPendingFilesChange
}: Props): ReactElement {
  const toast = useToast()
  const [items, setItems] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [preview, setPreview] = useState<Attachment | null>(null)
  const [pendingRemove, setPendingRemove] = useState<Attachment | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const pendingUrls = useMemo(() => pendingFiles.map((f) => URL.createObjectURL(f)), [pendingFiles])
  useEffect(() => () => pendingUrls.forEach((url) => URL.revokeObjectURL(url)), [pendingUrls])

  const load = useCallback(async () => {
    try {
      setItems(await unwrap(window.api.erp.attachments.list(documentId)))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }, [documentId, toast])
  useEffect(() => {
    void load()
  }, [load])

  async function addFiles(files: FileList | File[]): Promise<void> {
    const list = [...files].filter((f) => f.type.startsWith('image/'))
    if (list.length === 0) {
      toast('只支持 PNG / JPG / WebP / GIF 图片', 'error')
      return
    }
    if (items.length + pendingFiles.length + list.length > MAX) {
      toast(`每张单据最多 ${MAX} 张图片`, 'error')
      return
    }
    if (!documentId && onPendingFilesChange) {
      onPendingFilesChange([...pendingFiles, ...list])
      return
    }
    setBusy(true)
    try {
      for (const f of list) {
        const data = await f.arrayBuffer()
        await unwrap(window.api.erp.attachments.add(documentId, { fileName: f.name, mime: f.type, data }))
      }
      toast(`已添加 ${list.length} 张图片`, 'success')
      await load()
    } catch (err) {
      toast(errorMessage(err), 'error')
      await load()
    } finally {
      setBusy(false)
    }
  }

  function onDrop(e: DragEvent): void {
    e.preventDefault()
    setDragging(false)
    if (readOnly || busy) return
    void addFiles(e.dataTransfer.files)
  }

  async function remove(a: Attachment): Promise<void> {
    setBusy(true)
    try {
      await unwrap(window.api.erp.attachments.remove(a.id))
      setPendingRemove(null)
      await load()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={styles.wrap}
      onDragOver={(e) => {
        e.preventDefault()
        if (!readOnly) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className={styles.grid}>
        {items.map((a) => (
          <div key={a.id} className={styles.thumb} onClick={() => setPreview(a)} title={a.fileName}>
            <img src={attachmentUrl(a)} alt={a.fileName} loading="lazy" />
            <div className={styles.name}>{a.fileName}</div>
            {!readOnly && (
              <button
                type="button"
                className={styles.remove}
                aria-label="删除图片"
                onClick={(e) => {
                  e.stopPropagation()
                  setPendingRemove(a)
                }}
                disabled={busy}
              >
                <X size={14} />
              </button>
            )}
          </div>
        ))}
        {pendingFiles.map((f, i) => (
          <div key={`${f.name}-${f.lastModified}-${i}`} className={styles.thumb} title={f.name}>
            <img src={pendingUrls[i]} alt={f.name} />
            <div className={styles.name}>{f.name}</div>
            <button
              type="button"
              className={styles.remove}
              aria-label="删除图片"
              onClick={() => onPendingFilesChange?.(pendingFiles.filter((_, n) => n !== i))}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        {!readOnly && items.length + pendingFiles.length < MAX && (
          <button
            type="button"
            className={`${styles.drop} ${dragging ? styles.dropActive : ''}`}
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            <ImagePlus size={22} strokeWidth={1.5} />
            {busy ? '上传中…' : '拖入图片或点击选择'}
          </button>
        )}
        {readOnly && items.length === 0 && <span className={styles.hint}>没有图片附件</span>}
      </div>
      {!readOnly && <span className={styles.hint}>PNG / JPG / WebP / GIF，单张 10MB 以内，最多 {MAX} 张。</span>}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files)
          e.target.value = ''
        }}
      />

      {preview && (
        <div className={styles.lightbox} onClick={() => setPreview(null)}>
          <img src={attachmentUrl(preview)} alt={preview.fileName} />
        </div>
      )}
      <ConfirmDialog
        open={pendingRemove !== null}
        danger
        title="删除这张图片？"
        confirmText="删除"
        loading={busy}
        onOpenChange={(o) => !o && setPendingRemove(null)}
        description={pendingRemove ? `${pendingRemove.fileName} 将从单据中移除并删除文件。` : ''}
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => (pendingRemove ? remove(pendingRemove) : undefined)}
      />
    </div>
  )
}

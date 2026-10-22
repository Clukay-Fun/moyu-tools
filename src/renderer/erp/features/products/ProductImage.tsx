import type { ReactElement } from 'react'
import { useRef, useState } from 'react'
import { ImageIcon, ImagePlus, Trash2 } from 'lucide-react'
import type { Product } from '@shared/erp/types'
import { useToast } from '@erp/components/Toast'
import { unwrap, errorMessage } from '@erp/lib/api'
import styles from './ProductImage.module.css'

interface Props {
  product: Product
  onChanged: (p: Product) => void
  size?: number
}

export function productImageUrl(p: Product): string | null {
  return p.imagePath ? `moyu-file://attachments/${p.imagePath}` : null
}

/** 商品主图：点击或拖入更换，悬停可移除。 */
export function ProductImage({ product, onChanged, size = 160 }: Props): ReactElement {
  const toast = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const url = productImageUrl(product)

  async function upload(file: File): Promise<void> {
    if (!file.type.startsWith('image/')) {
      toast('只支持 PNG / JPG / WebP / GIF 图片', 'error')
      return
    }
    setBusy(true)
    try {
      onChanged(
        await unwrap(
          window.api.erp.products.setImage(product.id, {
            fileName: file.name,
            mime: file.type,
            data: await file.arrayBuffer()
          })
        )
      )
      toast('商品图片已更新', 'success')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  async function clear(): Promise<void> {
    setBusy(true)
    try {
      onChanged(await unwrap(window.api.erp.products.clearImage(product.id)))
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={`${styles.box} ${size <= 72 ? styles.compact : ''} ${dragging ? styles.dragging : ''}`}
      style={{ width: size, height: size }}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        const f = e.dataTransfer.files[0]
        if (f) void upload(f)
      }}
    >
      {url ? (
        <img src={url} alt={product.name} draggable={false} />
      ) : (
        <ImageIcon size={size <= 72 ? 20 : 32} strokeWidth={1.5} className={styles.placeholder} />
      )}
      <div className={styles.overlay}>
        <button
          type="button"
          className={styles.action}
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          aria-label={url ? '更换图片' : '添加图片'}
          title={url ? '更换图片' : '添加图片'}
        >
          {size <= 72 ? (
            <ImagePlus size={14} />
          ) : (
            <>
              <ImagePlus size={16} /> {url ? '更换' : '添加图片'}
            </>
          )}
        </button>
        {url && (
          <button
            type="button"
            className={`${styles.action} ${styles.danger}`}
            onClick={clear}
            disabled={busy}
            aria-label="移除图片"
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void upload(f)
          e.target.value = ''
        }}
      />
    </div>
  )
}

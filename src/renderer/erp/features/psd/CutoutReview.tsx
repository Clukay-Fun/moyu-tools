/**
 * 描述: 抠白底结果预览 (CutoutReview)
 * 主要功能:
 *   - 原图与透明结果左右对照，可切换深浅棋盘背景
 *   - 确认后才新增素材（原图保留）；取消会删掉临时结果；关闭预览不删，可稍后再看
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { PsdAsset, PsdCutoutJob } from '@shared/erp/psd'
import { Button } from '@erp/components/ui'
import { useFocusTrap } from '@erp/lib/useFocusTrap'
import { usePresence } from '@erp/lib/usePresence'
import styles from './CutoutReview.module.css'

interface Props {
  open: boolean
  job: PsdCutoutJob | null
  original: PsdAsset | null
  busy: boolean
  onDismiss: () => void
  onConfirm: () => void
  onCancel: () => void
}

export function CutoutReview({
  open,
  job,
  original,
  busy,
  onDismiss,
  onConfirm,
  onCancel
}: Props): ReactElement | null {
  const ref = useRef<HTMLElement>(null)
  const { mounted, closing } = usePresence(open)
  useFocusTrap(ref, open)
  const [dark, setDark] = useState(false)
  const [held, setHeld] = useState<PsdCutoutJob | null>(null)
  useEffect(() => {
    if (job) setHeld(job)
  }, [job])
  const shown = job ?? held

  useEffect(() => {
    if (!open || busy) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onDismiss])

  if (!mounted || !shown) return null
  const stage = `${styles.stage} ${dark ? styles.dark : styles.light}`
  return (
    <div
      className={styles.backdrop}
      data-closing={closing || undefined}
      role="presentation"
      onClick={() => {
        if (!busy) onDismiss()
      }}
    >
      <section
        ref={ref}
        className={styles.dialog}
        data-closing={closing || undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cutout-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <div>
            <h2 id="cutout-title" className={styles.title}>
              检查抠图结果
            </h2>
            <p className={styles.hint}>
              {shown.kind === 'dog'
                ? '请检查毛发、脚边和玩具轮廓；自动蒙版可能需要在 Photoshop 手动修边。'
                : '白底已按颜色移除；请确认字母细线、灰色爪印和上下排版完整。'}
            </p>
            <p className={styles.hint}>关闭预览不会删除结果，可稍后在素材库里再打开。</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setDark((v) => !v)}>
            {dark ? '换浅色背景' : '换深色背景'}
          </Button>
        </header>
        <div className={styles.images}>
          <figure className={styles.figure}>
            <figcaption>原图 · {shown.assetLabel}</figcaption>
            <div className={stage}>{original && <img src={original.fileUrl} alt="原始素材" />}</div>
          </figure>
          <figure className={styles.figure}>
            <figcaption>透明结果 · 待确认</figcaption>
            <div className={stage}>{shown.resultUrl && <img src={shown.resultUrl} alt="抠图结果" />}</div>
          </figure>
        </div>
        <footer className={styles.footer}>
          <Button variant="ghost" disabled={busy} onClick={onDismiss}>
            稍后再看
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onCancel}>
            不要这个结果
          </Button>
          <Button variant="primary" disabled={busy || !shown.resultUrl || !original} onClick={onConfirm}>
            确认并新增素材
          </Button>
        </footer>
      </section>
    </div>
  )
}

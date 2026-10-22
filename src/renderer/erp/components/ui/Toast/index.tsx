/**
 * 描述: 全局即时消息提示组件 (Toast / ToastViewport / toast)
 * 主要功能:
 *   - 自动在视口右下角堆叠弹出
 *   - 默认 3 秒后自动淡出消失
 *   - 支持附带快捷动作按钮（如「查看」）
 *   - 导出 toast.success / toast.error / toast.info 命令式触发器
 */

import React, { useState, useEffect, type ReactNode } from 'react'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'
import styles from './Toast.module.css'

export type ToastType = 'success' | 'error' | 'info'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastItem {
  id: string
  type: ToastType
  message: ReactNode
  action?: ToastAction
  duration?: number
}

type ToastListener = (toasts: ToastItem[]) => void

let activeToasts: ToastItem[] = []
const listeners: Set<ToastListener> = new Set()

function emitChange(): void {
  listeners.forEach((listener) => listener([...activeToasts]))
}

function removeToast(id: string): void {
  activeToasts = activeToasts.filter((t) => t.id !== id)
  emitChange()
}

function addToast(type: ToastType, message: ReactNode, options?: { action?: ToastAction; duration?: number }): string {
  const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const duration = options?.duration ?? 3000

  const item: ToastItem = {
    id,
    type,
    message,
    action: options?.action,
    duration
  }

  activeToasts = [...activeToasts, item]
  emitChange()

  if (duration > 0) {
    setTimeout(() => {
      removeToast(id)
    }, duration)
  }

  return id
}

// #region 命令式 API 导出

export const toast = {
  success: (message: ReactNode, options?: { action?: ToastAction; duration?: number }): string =>
    addToast('success', message, options),
  error: (message: ReactNode, options?: { action?: ToastAction; duration?: number }): string =>
    addToast('error', message, options),
  info: (message: ReactNode, options?: { action?: ToastAction; duration?: number }): string =>
    addToast('info', message, options),
  dismiss: (id: string): void => removeToast(id)
}

// #endregion

// #region Toast 视口渲染容器

/**
 * 用处: 渲染位于应用右下角的 Toast 浮层队列
 * 功能:
 *   - 监听全局 toast 触发事件并展示
 *   - 支持关闭与快捷操作点击
 */
export function ToastViewport(): React.JSX.Element | null {
  const [toasts, setToasts] = useState<ToastItem[]>(activeToasts)

  useEffect(() => {
    listeners.add(setToasts)
    return () => {
      listeners.delete(setToasts)
    }
  }, [])

  if (toasts.length === 0) return null

  return (
    <div className={styles.viewport} role="region" aria-label="通知提示">
      {toasts.map((t) => {
        const icon =
          t.type === 'success' ? (
            <span className={`${styles.icon} ${styles.success}`}>
              <CheckCircle2 size={16} />
            </span>
          ) : t.type === 'error' ? (
            <span className={`${styles.icon} ${styles.error}`}>
              <AlertCircle size={16} />
            </span>
          ) : (
            <span className={`${styles.icon} ${styles.info}`}>
              <Info size={16} />
            </span>
          )

        return (
          <div key={t.id} className={styles.toast} role="status">
            <div className={styles.content}>
              {icon}
              <span className={styles.message}>{t.message}</span>
            </div>

            <div className={styles.actions}>
              {t.action && (
                <button
                  type="button"
                  className={styles.actionButton}
                  onClick={() => {
                    t.action?.onClick()
                    removeToast(t.id)
                  }}
                >
                  {t.action.label}
                </button>
              )}
              <button
                type="button"
                className={styles.closeButton}
                aria-label="关闭提示"
                onClick={() => removeToast(t.id)}
              >
                <X size={12} />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// #endregion

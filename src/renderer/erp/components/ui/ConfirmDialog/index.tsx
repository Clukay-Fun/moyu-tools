/**
 * 描述: 系统模态确认对话框 (ConfirmDialog)
 * 主要功能:
 *   - 作为系统内唯一允许出现的居中模态对话框
 *   - 用于拦截不可逆或高危业务操作（单据作废、冲回、清空、删除）
 *   - 强制指明具体动作文案（如「作废并冲回」而非模糊的「确定」）
 *   - 基于 Base UI AlertDialog 保证焦点锁定与 Esc 取消逻辑
 */

import React, { type ReactNode } from 'react'
import { AlertDialog } from '@base-ui/react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '../Button'
import styles from './ConfirmDialog.module.css'

export interface ConfirmDialogProps {
  /** 是否打开 */
  open: boolean
  /** 开闭状态变更 */
  onOpenChange: (open: boolean) => void
  /** 对话框标题 */
  title: string
  /** 后果说明或确认描述 */
  description: ReactNode
  /** 明确的执行动作文案（例如「作废并冲回」、「清空数据」） */
  confirmText: string
  /** 取消按钮文案，默认为「取消」 */
  cancelText?: string
  /** 是否为破坏性危险操作，为 true 时确认按钮呈红色实心 */
  danger?: boolean
  /** 是否处于执行中状态 */
  loading?: boolean
  /** 确认执行回调 */
  onConfirm: () => void | Promise<void>
  /** 取消回调（纯点击取消或按 Esc 时触发，不触发 onConfirm） */
  onCancel?: () => void
  /** 说明下方的附加内容，例如作废原因输入框 */
  children?: ReactNode
}

// #region ConfirmDialog 核心组件

/**
 * 用处: 渲染不可逆操作的二次拦截窗口
 * 参数:
 *   - title: 简短警示标题
 *   - description: 详细后果阐述
 *   - confirmText: 具体行为动词
 *   - danger: 警示高亮开关
 * 功能:
 *   - 点取消关闭并触发 onCancel，绝不触发 onConfirm
 *   - 点确认后若返回 Promise 自动等待或由上层 loading 控制
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText,
  cancelText = '取消',
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
  children
}: ConfirmDialogProps): React.JSX.Element {
  const handleCancel = (): void => {
    onCancel?.()
    onOpenChange(false)
  }

  const handleConfirm = async (): Promise<void> => {
    await onConfirm()
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className={styles.backdrop} />
        <AlertDialog.Popup className={styles.popup}>
          <div className={styles.header}>
            {danger && (
              <span className={styles.dangerIcon} aria-hidden="true">
                <AlertTriangle size={18} />
              </span>
            )}
            <AlertDialog.Title className={styles.title}>{title}</AlertDialog.Title>
          </div>

          <AlertDialog.Description className={styles.description}>{description}</AlertDialog.Description>
          {children}

          <div className={styles.actions}>
            <Button variant="secondary" size="md" disabled={loading} onClick={handleCancel}>
              {cancelText}
            </Button>
            <Button variant={danger ? 'danger-solid' : 'primary'} size="md" loading={loading} onClick={handleConfirm}>
              {confirmText}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}

// #endregion

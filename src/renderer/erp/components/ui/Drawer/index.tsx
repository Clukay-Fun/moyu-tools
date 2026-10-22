/**
 * 描述: 系统单例抽屉宿主与滑出抽屉套件 (Drawer / DrawerHost / useDrawer)
 * 主要功能:
 *   - 从右侧滑出，支持 sm (420px)、md (600px)、lg (760px) 三种规格
 *   - 全局单例管理 (DrawerHost)：打开新抽屉自动替换旧抽屉，保留最多 5 级返回历史
 *   - 头部自动呈现「← 返回 <上一个抽屉标题>」
 *   - 按 Esc 或关闭时，自动归还焦点给触发元素
 *   - 表单未保存拦截 (isDirty)：关闭前弹出确认对话框保护数据
 */

import React, {
  createContext,
  useContext,
  useState,
  useRef,
  useCallback,
  useMemo,
  useEffect,
  type ReactNode,
  type ReactElement
} from 'react'
import { ArrowLeft, X } from 'lucide-react'
import { Dialog } from '@base-ui/react'
import { IconButton } from '../IconButton'
import { ConfirmDialog } from '../ConfirmDialog'
import styles from './Drawer.module.css'

export type DrawerSize = 'sm' | 'md' | 'lg'

export interface DrawerOptions {
  id?: string
  title: string
  size?: DrawerSize
  content: ReactNode | ((helpers: DrawerHelpers) => ReactNode)
  footer?: ReactNode | ((helpers: DrawerHelpers) => ReactNode)
  headerActions?: ReactNode
  isDirty?: boolean
  onClose?: () => void
}

export interface DrawerHelpers {
  close: (force?: boolean) => void
  goBack: () => void
  setDirty: (dirty: boolean) => void
  /** 内容改名后同步抽屉标题（例如商品改名、新建后） */
  setTitle: (title: string) => void
}

interface DrawerContextValue {
  openDrawer: (options: DrawerOptions) => void
  closeDrawer: (force?: boolean) => void
  goBack: () => void
  setDirty: (dirty: boolean) => void
  setTitle: (title: string) => void
  currentDrawer: DrawerOptions | null
  history: DrawerOptions[]
}

const DrawerContext = createContext<DrawerContextValue | null>(null)

// #region DrawerContext 与 Hook

/**
 * 用处: 在任意子组件中调用以控制右侧抽屉
 * 功能:
 *   - 打开、关闭、返回上一级抽屉
 *   - 标记当前表单脏状态 (dirtyGuard)
 */
export function useDrawer(): DrawerContextValue {
  const ctx = useContext(DrawerContext)
  if (!ctx) {
    throw new Error('useDrawer 必须在 DrawerProvider / DrawerHost 内部使用')
  }
  return ctx
}

// #endregion

// #region DrawerHost 全局抽屉宿主

export interface DrawerHostProps {
  children?: ReactNode
}

/**
 * 用处: 全局唯一抽屉宿主组件，挂载于应用外壳根节点
 * 参数:
 *   - children: 应用主内容树
 * 功能:
 *   - 统一管理全局唯一可见抽屉与多级历史回退栈
 *   - 处理 Esc 退出、焦点自动恢复与未保存拦截
 */
export function DrawerHost({ children }: DrawerHostProps): React.JSX.Element {
  const [currentDrawer, setCurrentDrawer] = useState<DrawerOptions | null>(null)
  const [history, setHistory] = useState<DrawerOptions[]>([])
  const [pendingAction, setPendingAction] = useState<'close' | 'back' | null>(null)
  const triggerElementRef = useRef<HTMLElement | null>(null)

  // 抽屉关闭时归还焦点给触发元素
  useEffect(() => {
    if (!currentDrawer && triggerElementRef.current) {
      const el = triggerElementRef.current
      triggerElementRef.current = null
      setTimeout(() => {
        el.focus()
      }, 50)
    }
  }, [currentDrawer])

  const openDrawer = useCallback(
    (options: DrawerOptions) => {
      // 只记最外层的触发元素；弹窗内再打开下一层时不覆盖
      if (!currentDrawer && document.activeElement instanceof HTMLElement) {
        triggerElementRef.current = document.activeElement
      }
      if (currentDrawer) {
        setHistory((prev) => [...prev.slice(-4), currentDrawer])
      }
      setCurrentDrawer(options)
    },
    [currentDrawer]
  )

  const performClose = useCallback(() => {
    if (currentDrawer?.onClose) {
      currentDrawer.onClose()
    }
    setCurrentDrawer(null)
    setHistory([])
  }, [currentDrawer])

  const performBack = useCallback(() => {
    if (history.length > 0) {
      const prev = history[history.length - 1]
      setHistory((old) => old.slice(0, old.length - 1))
      setCurrentDrawer(prev)
    } else {
      performClose()
    }
  }, [history, performClose])

  const closeDrawer = useCallback(
    (force = false) => {
      if (!currentDrawer) return
      if (!force && currentDrawer.isDirty) {
        setPendingAction('close')
        return
      }
      performClose()
    },
    [currentDrawer, performClose]
  )

  const goBack = useCallback(() => {
    if (!currentDrawer) return
    if (currentDrawer.isDirty) {
      setPendingAction('back')
      return
    }
    performBack()
  }, [currentDrawer, performBack])

  const setDirty = useCallback((dirty: boolean) => {
    setCurrentDrawer((prev) => (prev ? { ...prev, isDirty: dirty } : null))
  }, [])

  const setTitle = useCallback((title: string) => {
    setCurrentDrawer((prev) => (prev ? { ...prev, title } : null))
  }, [])

  const handleDiscardConfirm = (): void => {
    const action = pendingAction
    setPendingAction(null)
    if (action === 'back') {
      performBack()
    } else {
      performClose()
    }
  }

  const helpers = useMemo<DrawerHelpers>(
    () => ({
      close: closeDrawer,
      goBack,
      setDirty,
      setTitle
    }),
    [closeDrawer, goBack, setDirty, setTitle]
  )

  const contextValue = useMemo<DrawerContextValue>(
    () => ({
      openDrawer,
      closeDrawer,
      goBack,
      setDirty,
      setTitle,
      currentDrawer,
      history
    }),
    [openDrawer, closeDrawer, goBack, setDirty, setTitle, currentDrawer, history]
  )

  const prevDrawer = history.length > 0 ? history[history.length - 1] : null

  return (
    <DrawerContext.Provider value={contextValue}>
      {children}

      {currentDrawer && (
        <Dialog.Root
          open={Boolean(currentDrawer)}
          onOpenChange={(isOpen) => {
            if (!isOpen) {
              closeDrawer(false)
            }
          }}
        >
          <Dialog.Portal>
            <Dialog.Backdrop className={styles.backdrop} />
            {/* 焦点归还由上面的 effect 负责；不让 Base UI 再把焦点移走 */}
            <Dialog.Popup
              finalFocus={false}
              className={`${styles.popup} ${
                currentDrawer.size === 'sm' ? styles.sm : currentDrawer.size === 'lg' ? styles.lg : styles.md
              }`}
            >
              <div className={styles.header}>
                <div className={styles.headerLeft}>
                  {prevDrawer && (
                    <button
                      type="button"
                      className={styles.backButton}
                      onClick={goBack}
                      title={`返回 ${prevDrawer.title}`}
                    >
                      <ArrowLeft size={14} />
                      <span>{prevDrawer.title}</span>
                    </button>
                  )}
                  <Dialog.Title className={styles.title}>{currentDrawer.title}</Dialog.Title>
                </div>

                <div className={styles.headerActions}>
                  {currentDrawer.headerActions}
                  <IconButton
                    label="关闭抽屉 (Esc)"
                    icon={<X size={16} />}
                    variant="ghost"
                    size="sm"
                    onClick={() => closeDrawer(false)}
                  />
                </div>
              </div>

              <div className={styles.body}>
                {typeof currentDrawer.content === 'function' ? currentDrawer.content(helpers) : currentDrawer.content}
              </div>

              {currentDrawer.footer && (
                <div className={styles.footer}>
                  {typeof currentDrawer.footer === 'function' ? currentDrawer.footer(helpers) : currentDrawer.footer}
                </div>
              )}
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}

      <ConfirmDialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!open) setPendingAction(null)
        }}
        title="放弃所做的修改？"
        description="当前表单有未保存的内容，退出后输入的数据将全部丢失。"
        confirmText="放弃并退出"
        cancelText="继续编辑"
        danger
        onConfirm={handleDiscardConfirm}
        onCancel={() => {
          setPendingAction(null)
        }}
      />
    </DrawerContext.Provider>
  )
}

// #endregion

// #region 独立可控 Drawer 组件 (用于单体场景或轻量容器)

export interface StandaloneDrawerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  size?: DrawerSize
  children: ReactNode
  footer?: ReactNode
  headerActions?: ReactNode
}

export function StandaloneDrawer({
  open,
  onOpenChange,
  title,
  size = 'md',
  children,
  footer,
  headerActions
}: StandaloneDrawerProps): ReactElement | null {
  const sizeClass = size === 'sm' ? styles.sm : size === 'lg' ? styles.lg : styles.md

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={styles.backdrop} />
        <Dialog.Popup className={`${styles.popup} ${sizeClass}`}>
          <div className={styles.header}>
            <Dialog.Title className={styles.title}>{title}</Dialog.Title>
            <div className={styles.headerActions}>
              {headerActions}
              <IconButton
                label="关闭 (Esc)"
                icon={<X size={16} />}
                variant="ghost"
                size="sm"
                onClick={() => onOpenChange(false)}
              />
            </div>
          </div>
          <div className={styles.body}>{children}</div>
          {footer && <div className={styles.footer}>{footer}</div>}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

// #endregion

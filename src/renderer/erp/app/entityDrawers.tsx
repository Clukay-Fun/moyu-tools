/**
 * 描述: 全局实体抽屉入口 (useEntityDrawers)
 * 主要功能:
 *   - 任何地方（页面、命令面板、侧栏、其他抽屉）都能按 id 打开商品、单据等抽屉
 *   - 抽屉内写入成功后统一 emitDataChanged()，底下的页面自行刷新
 */

import { useCallback, useMemo } from 'react'
import type { DocumentType } from '@shared/erp/types'
import { useDrawer } from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { unwrap, errorMessage } from '@erp/lib/api'
import { emitDataChanged } from '@erp/lib/dataEvents'
import { ProductDrawerContent } from '@erp/features/products/ProductDrawerContent'
import { DocumentDrawerContent } from '@erp/features/documents/DocumentDrawerContent'
import { DocumentEditor } from '@erp/features/documents/DocumentEditor'
import { AdjustmentDrawerContent } from '@erp/features/adjustments/AdjustmentDrawerContent'
import { ImportDialog } from '@erp/features/csv/ImportDialog'

export interface NewDocumentOptions {
  /** 预先带出的商品（命令面板 ⌘Enter、商品抽屉） */
  productId?: number
}

export interface EntityDrawers {
  openProduct: (productId: number) => Promise<void>
  newProduct: () => void
  openDocument: (documentId: number) => void
  newDocument: (type: Extract<DocumentType, 'inbound' | 'outbound'>, options?: NewDocumentOptions) => void
  editDocument: (documentId: number) => void
  openAdjustment: (productId?: number) => void
  openImport: () => void
}

export function useEntityDrawers(): EntityDrawers {
  const { openDrawer } = useDrawer()
  const toast = useToast()

  const openProduct = useCallback(
    async (productId: number) => {
      try {
        const product = await unwrap(window.api.erp.products.getById(productId))
        openDrawer({
          id: `product-${productId}`,
          title: product.name,
          size: 'md',
          content: <ProductDrawerContent initialMode="view" product={product} onDataChanged={emitDataChanged} />
        })
      } catch (err) {
        toast(errorMessage(err), 'error')
      }
    },
    [openDrawer, toast]
  )

  const newProduct = useCallback(() => {
    openDrawer({
      id: 'product-new',
      title: '新建商品',
      size: 'md',
      content: <ProductDrawerContent initialMode="create" product={null} onDataChanged={emitDataChanged} />
    })
  }, [openDrawer])

  const openDocument = useCallback(
    (documentId: number) => {
      openDrawer({
        id: `document-${documentId}`,
        title: '单据',
        size: 'lg',
        content: <DocumentDrawerContent id={documentId} />
      })
    },
    [openDrawer]
  )

  const newDocument = useCallback(
    (type: Extract<DocumentType, 'inbound' | 'outbound'>, options: NewDocumentOptions = {}) => {
      openDrawer({
        id: `document-new-${type}`,
        title: type === 'outbound' ? '新建出库单' : '新建入库单',
        size: 'lg',
        content: <DocumentEditor mode={{ kind: 'new', type, productId: options.productId }} />
      })
    },
    [openDrawer]
  )

  const editDocument = useCallback(
    (documentId: number) => {
      openDrawer({
        id: `document-edit-${documentId}`,
        title: '编辑单据',
        size: 'lg',
        content: <DocumentEditor mode={{ kind: 'edit', id: documentId }} />
      })
    },
    [openDrawer]
  )

  const openAdjustment = useCallback(
    (productId?: number) => {
      openDrawer({
        id: 'adjustment-new',
        title: '库存调整',
        size: 'sm',
        content: <AdjustmentDrawerContent initialProductId={productId} />
      })
    },
    [openDrawer]
  )

  const openImport = useCallback(() => {
    openDrawer({
      id: 'csv-import',
      title: '导入 CSV',
      size: 'md',
      content: ({ close }) => <ImportDialog open embedded onClose={() => close()} onImported={emitDataChanged} />
    })
  }, [openDrawer])

  return useMemo(
    () => ({ openProduct, newProduct, openDocument, newDocument, editDocument, openAdjustment, openImport }),
    [openProduct, newProduct, openDocument, newDocument, editDocument, openAdjustment, openImport]
  )
}

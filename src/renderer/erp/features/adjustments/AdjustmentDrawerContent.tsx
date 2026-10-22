/**
 * 描述: 独立库存调整抽屉内容 (AdjustmentDrawerContent)
 * 主要功能:
 *   - 从「开单」菜单或命令面板进入：先选商品，再复用商品抽屉里的同一个 AdjustmentForm
 */

import React, { useEffect, useMemo, useState } from 'react'
import type { StockRow } from '@shared/erp/types'
import { Combobox, useDrawer, type ComboboxItem } from '@erp/components/ui'
import { unwrap } from '@erp/lib/api'
import { formatQty } from '@erp/lib/format'
import { emitDataChanged } from '@erp/lib/dataEvents'
import { productImageUrl } from '@erp/features/products/ProductImage'
import { AdjustmentForm } from './AdjustmentForm'
import styles from './AdjustmentForm.module.css'

export function AdjustmentDrawerContent({ initialProductId }: { initialProductId?: number }): React.JSX.Element {
  const { closeDrawer } = useDrawer()
  const [rows, setRows] = useState<StockRow[] | null>(null)
  const [productId, setProductId] = useState<number | null>(initialProductId ?? null)

  useEffect(() => {
    void unwrap(window.api.erp.inventory.listStock()).then((list) => {
      const active = list.filter((r) => r.product.isActive)
      setRows(active)
      // 只有一个商品时直接带出
      if (initialProductId === undefined && active.length === 1) setProductId(active[0].product.id)
    })
  }, [initialProductId])

  const items = useMemo<ComboboxItem<StockRow>[]>(
    () =>
      (rows ?? []).map((r) => ({
        id: r.product.id,
        label: r.product.name,
        sublabel: `${r.product.code} · 库存 ${formatQty(r.stock.quantity)} ${r.product.unit}`,
        thumbnail: productImageUrl(r.product),
        keywords: [r.product.code, r.product.defaultSku.code],
        raw: r
      })),
    [rows]
  )
  const selected = items.find((i) => i.id === productId) ?? null
  const row = selected?.raw ?? null

  return (
    <div className={styles.drawerBody}>
      <div className={styles.field}>
        <label className={styles.label}>商品</label>
        <Combobox
          items={items}
          value={selected}
          onSelect={(item) => setProductId(item ? Number(item.id) : null)}
          placeholder="搜索名称 / 编码 / SKU"
          autoFocus={productId === null}
        />
      </div>
      {row && (
        <AdjustmentForm
          key={row.product.id}
          product={row.product}
          stock={row.stock}
          onSuccess={() => {
            emitDataChanged()
            closeDrawer(true)
          }}
          onCancel={() => closeDrawer()}
        />
      )}
    </div>
  )
}

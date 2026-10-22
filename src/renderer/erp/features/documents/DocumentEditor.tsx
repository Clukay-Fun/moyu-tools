/**
 * 描述: 开单弹窗内容 (DocumentEditor)
 * 主要功能:
 *   - 新建 / 编辑入库单、出库单草稿；表头一行（日期、渠道、外部订单号、备注）
 *   - 明细：商品搜索框、库存、数量（默认 1）、单价（默认上次价格）、小计；出库超库存即时提示
 *   - 键盘：Tab 依次经过商品 → 数量 → 单价；最后一行单价按 Enter 新增一行；⌘⌫ 删行；⌘Enter 确认；⌘S 存草稿
 *   - 吸底栏：合计件数、金额、出库预估毛利；取消 / 保存草稿 / 确认
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Trash2, Paperclip, ChevronDown, ChevronRight } from 'lucide-react'
import type { DocumentDetail, DocumentSummary, DocumentType, Product, SalesChannel, StockLevel } from '@shared/erp/types'
import type { DocumentDraftInput, ProductLastPrices } from '@shared/erp/schemas'
import { Button, Combobox, Input, Select, useDrawer, TYPE_LABEL, type ComboboxItem } from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { useEntityDrawers } from '@erp/app/entityDrawers'
import { unwrap, errorMessage } from '@erp/lib/api'
import { emitDataChanged } from '@erp/lib/dataEvents'
import { formatCents, formatQty, parseCents, todayString } from '@erp/lib/format'
import { productImageUrl } from '@erp/features/products/ProductImage'
import { AttachmentPanel } from '@erp/features/attachments/AttachmentPanel'
import styles from './DocumentEditor.module.css'

export type EditorMode =
  | { kind: 'new'; type: Extract<DocumentType, 'inbound' | 'outbound'>; productId?: number }
  | { kind: 'edit'; id: number }

interface Line {
  key: number
  skuId: number | null
  quantity: string
  unitPrice: string
  /** 单价来源说明，例如「上次售价」；用户改过后清空 */
  priceSource: string
}

const LAST_CHANNEL_KEY = 'moyu.erp.lastChannelId'
const isMac = navigator.platform.toUpperCase().includes('MAC')

let lineSeq = 0

/** 单价默认值：入库取上次进价，出库取上次售价；没有则取商品默认价 */
function priceFor(p: Product, t: 'inbound' | 'outbound', prices: ProductLastPrices): { cents: number; source: string } {
  const last = prices[String(p.id)]
  if (t === 'inbound') {
    return last?.lastInboundPriceCents != null
      ? { cents: last.lastInboundPriceCents, source: '上次进价' }
      : { cents: p.defaultCostCents, source: '默认进价' }
  }
  return last?.lastOutboundPriceCents != null
    ? { cents: last.lastOutboundPriceCents, source: '上次售价' }
    : { cents: p.defaultPriceCents, source: '默认售价' }
}

function readLastChannel(): number | null {
  try {
    const v = Number(localStorage.getItem(LAST_CHANNEL_KEY))
    return Number.isInteger(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

function writeLastChannel(id: number | null): void {
  try {
    if (id === null) localStorage.removeItem(LAST_CHANNEL_KEY)
    else localStorage.setItem(LAST_CHANNEL_KEY, String(id))
  } catch {
    // 偏好写入失败不影响开单
  }
}

export function DocumentEditor({ mode }: { mode: EditorMode }): React.JSX.Element {
  const toast = useToast()
  const { closeDrawer, setDirty, setTitle } = useDrawer()
  const { openDocument } = useEntityDrawers()

  const [products, setProducts] = useState<Product[] | null>(null)
  const [stocks, setStocks] = useState<Map<number, StockLevel>>(new Map())
  const [lastPrices, setLastPrices] = useState<ProductLastPrices>({})
  const [channels, setChannels] = useState<SalesChannel[]>([])
  const [existing, setExisting] = useState<DocumentDetail | null>(null)
  const [type, setType] = useState<'inbound' | 'outbound'>(mode.kind === 'new' ? mode.type : 'outbound')
  const [docDate, setDocDate] = useState(todayString)
  const [channelId, setChannelId] = useState<number | null>(null)
  const [externalOrderNo, setExternalOrderNo] = useState('')
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [attachOpen, setAttachOpen] = useState(false)
  const [duplicate, setDuplicate] = useState<DocumentSummary | null>(null)
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState<'save' | 'confirm' | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const loadedRef = useRef(false)

  const productBySku = useCallback(
    (skuId: number | null): Product | undefined => products?.find((p) => p.defaultSku.id === skuId),
    [products]
  )

  const makeLine = (p: Product | undefined, t: 'inbound' | 'outbound', prices = lastPrices): Line => {
    if (!p) return { key: ++lineSeq, skuId: null, quantity: '1', unitPrice: '', priceSource: '' }
    const price = priceFor(p, t, prices)
    return {
      key: ++lineSeq,
      skuId: p.defaultSku.id,
      quantity: '1',
      unitPrice: (price.cents / 100).toFixed(2),
      priceSource: price.source
    }
  }

  // #region 载入

  useEffect(() => {
    ;(async () => {
      try {
        const [rows, cs] = await Promise.all([
          unwrap(window.api.erp.inventory.listStock()),
          unwrap(window.api.erp.channels.list())
        ])
        const active = rows.filter((r) => r.product.isActive).map((r) => r.product)
        if (active.length === 0) throw new Error('还没有启用的商品，先去商品页新建一个')
        const prices = await unwrap(window.api.erp.products.getLastPrices({ productIds: active.map((p) => p.id) }))
        setProducts(active)
        setStocks(new Map(rows.map((r) => [r.product.defaultSku.id, r.stock])))
        setChannels(cs)
        setLastPrices(prices)
        if (mode.kind === 'edit') {
          const d = await unwrap(window.api.erp.documents.get(mode.id))
          setExisting(d)
          setType(d.type as 'inbound' | 'outbound')
          setTitle(`编辑${TYPE_LABEL[d.type]}单 ${d.docNo}`)
          setDocDate(d.docDate)
          setChannelId(d.channelId)
          setExternalOrderNo(d.externalOrderNo)
          setNote(d.note)
          setLines(
            d.items.map((it) => ({
              key: ++lineSeq,
              skuId: it.skuId,
              quantity: String(it.quantity),
              unitPrice: (it.unitPriceCents / 100).toFixed(2),
              priceSource: ''
            }))
          )
        } else {
          if (mode.type === 'outbound') {
            const last = readLastChannel()
            if (last !== null && cs.some((c) => c.id === last && c.isActive)) setChannelId(last)
          }
          // 指定了商品，或者只有一个商品时，自动带出
          const preset = active.find((p) => p.id === mode.productId) ?? (active.length === 1 ? active[0] : undefined)
          setLines([makeLine(preset, mode.type, prices)])
        }
      } catch (err) {
        setLoadError(errorMessage(err))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // 首次载入后聚焦：已带出商品时落在数量框，否则落在商品框
  useEffect(() => {
    if (!products || lines.length === 0 || loadedRef.current) return
    loadedRef.current = true
    requestAnimationFrame(() => {
      const first = lines[0]
      const sel = first.skuId === null ? '[data-cell="product"] input' : '[data-cell="qty"]'
      rootRef.current?.querySelector<HTMLInputElement>(sel)?.focus()
      rootRef.current?.querySelector<HTMLInputElement>(sel)?.select?.()
    })
  }, [products, lines])

  // #endregion

  // 任何改动都标记为未保存（关闭弹窗前确认）
  const markDirty = (): void => {
    if (loadedRef.current) setDirty(true)
  }

  // 重复外部订单号提示（防抖）
  useEffect(() => {
    if (type !== 'outbound' || channelId === null || !externalOrderNo.trim()) {
      setDuplicate(null)
      return
    }
    const t = window.setTimeout(async () => {
      try {
        setDuplicate(
          await unwrap(window.api.erp.documents.findDuplicate(channelId, externalOrderNo, existing?.id ?? null))
        )
      } catch {
        setDuplicate(null)
      }
    }, 300)
    return () => window.clearTimeout(t)
  }, [type, channelId, externalOrderNo, existing])

  // #region 计算

  const parsed = useMemo(() => {
    const items = lines.map((l) => {
      const qty = /^\d+$/.test(l.quantity.trim()) ? Number(l.quantity) : null
      const price = parseCents(l.unitPrice)
      return { line: l, qty, price, valid: l.skuId !== null && qty !== null && qty >= 1 && price !== null }
    })
    const totalQty = items.reduce((a, i) => a + (i.qty ?? 0), 0)
    const totalAmount = items.reduce((a, i) => a + (i.qty !== null && i.price !== null ? i.qty * i.price : 0), 0)
    const need = new Map<number, number>()
    for (const i of items)
      if (i.line.skuId !== null) need.set(i.line.skuId, (need.get(i.line.skuId) ?? 0) + (i.qty ?? 0))
    // 出库预估成本按当前平均成本
    const estCost = items.reduce(
      (a, i) => a + (i.qty ?? 0) * (i.line.skuId !== null ? (stocks.get(i.line.skuId)?.avgCostCents ?? 0) : 0),
      0
    )
    return { items, totalQty, totalAmount, need, estCost, allValid: items.length > 0 && items.every((i) => i.valid) }
  }, [lines, stocks])

  const shortOf = (skuId: number | null): number => {
    if (type !== 'outbound' || skuId === null) return 0
    return Math.max(0, (parsed.need.get(skuId) ?? 0) - (stocks.get(skuId)?.quantity ?? 0))
  }
  const insufficient = type === 'outbound' && [...parsed.need.keys()].some((skuId) => shortOf(skuId) > 0)

  const comboItems = useMemo<ComboboxItem<Product>[]>(
    () =>
      (products ?? []).map((p) => ({
        id: p.defaultSku.id,
        label: p.name,
        sublabel: `${p.code} · 库存 ${formatQty(stocks.get(p.defaultSku.id)?.quantity ?? 0)} ${p.unit}`,
        thumbnail: productImageUrl(p),
        keywords: [p.code, p.defaultSku.code],
        raw: p
      })),
    [products, stocks]
  )

  // #endregion

  // #region 行操作

  const updateLine = (key: number, patch: Partial<Line>): void => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
    markDirty()
  }

  const addLine = (): void => {
    setLines((ls) => [...ls, makeLine(undefined, type)])
    markDirty()
    requestAnimationFrame(() => {
      const all = rootRef.current?.querySelectorAll<HTMLInputElement>('[data-cell="product"] input')
      all?.[all.length - 1]?.focus()
    })
  }

  const removeLine = (key: number): void => {
    if (lines.length <= 1) return
    setLines((ls) => ls.filter((l) => l.key !== key))
    markDirty()
  }

  // #endregion

  // #region 保存

  const buildInput = (): DocumentDraftInput | null => {
    setTouched(true)
    if (!parsed.allValid) {
      toast('请检查明细：每行都要选商品，数量为正整数，单价为非负金额', 'error')
      return null
    }
    return {
      type,
      docDate,
      channelId: type === 'outbound' ? channelId : null,
      externalOrderNo: type === 'outbound' ? externalOrderNo.trim() : '',
      note: note.trim(),
      items: parsed.items.map((i) => ({ skuId: i.line.skuId!, quantity: i.qty!, unitPriceCents: i.price! }))
    }
  }

  async function saveDraft(): Promise<DocumentDetail | null> {
    const input = buildInput()
    if (!input) return null
    const d = existing
      ? await unwrap(window.api.erp.documents.updateDraft(existing.id, input))
      : await unwrap(window.api.erp.documents.createDraft(input))
    setExisting(d)
    for (const f of pendingFiles) {
      await unwrap(window.api.erp.attachments.add(d.id, { fileName: f.name, mime: f.type, data: await f.arrayBuffer() }))
    }
    setPendingFiles([])
    if (type === 'outbound') writeLastChannel(channelId)
    return d
  }

  const finish = (d: DocumentDetail, verb: string): void => {
    setDirty(false)
    emitDataChanged()
    closeDrawer(true)
    toast(`${verb} ${d.docNo}`, 'success', { label: '查看', onClick: () => openDocument(d.id) })
  }

  async function handleSave(): Promise<void> {
    if (busy) return
    setBusy('save')
    try {
      const d = await saveDraft()
      if (d) finish(d, '草稿已保存')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  async function handleConfirm(): Promise<void> {
    if (busy) return
    if (insufficient) {
      toast('库存不足，不能确认出库；可以先保存草稿', 'error')
      return
    }
    setBusy('confirm')
    try {
      const d = await saveDraft()
      if (!d) return
      const c = await unwrap(window.api.erp.documents.confirm(d.id))
      finish(c, '已确认')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  // #endregion

  // 弹窗内快捷键：⌘Enter 确认、⌘S 存草稿、⌘⌫ 删除当前行
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const mod = isMac ? e.metaKey : e.ctrlKey
    if (!mod) return
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleConfirm()
    } else if (e.key.toLowerCase() === 's') {
      e.preventDefault()
      void handleSave()
    } else if (e.key === 'Backspace') {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[data-line]')
      if (row) {
        e.preventDefault()
        removeLine(Number(row.dataset.line))
      }
    }
  }

  if (loadError) return <p className={styles.error}>{loadError}</p>
  if (!products) return <p className={styles.loading}>正在准备开单…</p>

  const label = TYPE_LABEL[type]
  const profit = parsed.totalAmount - parsed.estCost
  const profitRate = parsed.totalAmount > 0 ? (profit / parsed.totalAmount) * 100 : 0
  const attachCount = pendingFiles.length

  return (
    <div
      ref={rootRef}
      className={styles.editor}
      onKeyDown={onKeyDown}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setAttachOpen(true)
        }
      }}
    >
      <div className={styles.scroll}>
        <p className={styles.docNo}>{existing ? `单号 ${existing.docNo}` : '单号保存后自动生成'}</p>

        <div className={`${styles.fields} ${type === 'outbound' ? styles.fields4 : ''}`}>
          <label className={styles.field}>
            <span>日期</span>
            <Input
              type="date"
              value={docDate}
              onChange={(e) => {
                setDocDate(e.target.value)
                markDirty()
              }}
            />
          </label>
          {type === 'outbound' && (
            <>
              <div className={styles.field}>
                <span>渠道</span>
                <Select
                  value={String(channelId ?? 0)}
                  onChange={(v) => {
                    setChannelId(v === '0' ? null : Number(v))
                    markDirty()
                  }}
                  options={[
                    { value: '0', label: '未指定' },
                    ...channels
                      .filter((c) => c.isActive || c.id === channelId)
                      .map((c) => ({ value: String(c.id), label: c.name }))
                  ]}
                />
              </div>
              <label className={styles.field}>
                <span>外部订单号</span>
                <Input
                  value={externalOrderNo}
                  onChange={(e) => {
                    setExternalOrderNo(e.target.value)
                    markDirty()
                  }}
                  placeholder="选填"
                  maxLength={64}
                />
              </label>
            </>
          )}
          <label className={styles.field}>
            <span>备注</span>
            <Input
              value={note}
              onChange={(e) => {
                setNote(e.target.value)
                markDirty()
              }}
              placeholder="选填"
              maxLength={200}
            />
          </label>
        </div>
        {duplicate && (
          <p className={styles.dup}>
            该渠道下已有相同订单号的单据 <strong>{duplicate.docNo}</strong>，请确认不是重复录入。
          </p>
        )}

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>商品</th>
                <th className={styles.num}>{type === 'outbound' ? '可用库存' : '当前库存'}</th>
                <th className={styles.num}>数量</th>
                <th className={styles.num}>{type === 'inbound' ? '进价' : '售价'}</th>
                <th className={styles.num}>小计</th>
                <th aria-label="删除" />
              </tr>
            </thead>
            <tbody>
              {parsed.items.map(({ line, qty, price }, index) => {
                const short = shortOf(line.skuId)
                const p = productBySku(line.skuId)
                const isLast = index === parsed.items.length - 1
                return (
                  <tr key={line.key} data-line={line.key}>
                    <td data-cell="product" className={styles.productCell}>
                      <Combobox
                        items={comboItems}
                        value={comboItems.find((i) => i.id === line.skuId) ?? null}
                        placeholder="搜索名称 / 编码 / SKU"
                        error={touched && line.skuId === null ? '请选择商品' : undefined}
                        onSelect={(item) => {
                          const prod = item?.raw
                          if (!prod) return updateLine(line.key, { skuId: null })
                          const d = priceFor(prod, type, lastPrices)
                          updateLine(line.key, {
                            skuId: prod.defaultSku.id,
                            unitPrice: (d.cents / 100).toFixed(2),
                            priceSource: d.source
                          })
                          requestAnimationFrame(() =>
                            rootRef.current
                              ?.querySelector<HTMLInputElement>(`[data-line="${line.key}"] [data-cell="qty"]`)
                              ?.select()
                          )
                        }}
                      />
                    </td>
                    <td className={styles.num}>
                      {line.skuId === null ? '—' : formatQty(stocks.get(line.skuId)?.quantity ?? 0)}
                    </td>
                    <td className={styles.num}>
                      <input
                        data-cell="qty"
                        aria-label="数量"
                        className={`${styles.cellInput} ${(touched && (qty === null || qty < 1)) || short > 0 ? styles.cellInvalid : ''}`}
                        inputMode="numeric"
                        value={line.quantity}
                        onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                        placeholder="0"
                      />
                      {short > 0 && <span className={styles.short}>超出可用库存 {formatQty(short)} 件</span>}
                    </td>
                    <td className={styles.num}>
                      <input
                        data-cell="price"
                        aria-label={type === 'inbound' ? '进价' : '售价'}
                        className={`${styles.cellInput} ${touched && price === null ? styles.cellInvalid : ''}`}
                        inputMode="decimal"
                        value={line.unitPrice}
                        onChange={(e) => updateLine(line.key, { unitPrice: e.target.value, priceSource: '' })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && isLast) {
                            e.preventDefault()
                            addLine()
                          }
                        }}
                        placeholder="0.00"
                      />
                      {line.priceSource && p && <span className={styles.priceSource}>{line.priceSource}</span>}
                    </td>
                    <td className={`${styles.num} ${styles.subtotal}`}>
                      {qty !== null && price !== null ? `¥${formatCents(qty * price)}` : '—'}
                    </td>
                    <td className={styles.removeCell}>
                      <button
                        type="button"
                        className={styles.remove}
                        onClick={() => removeLine(line.key)}
                        disabled={lines.length <= 1}
                        aria-label="删除此行"
                        title={`删除此行（${isMac ? '⌘⌫' : 'Ctrl+Backspace'}）`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <button type="button" className={styles.addLine} onClick={addLine}>
            <Plus size={14} /> 添加一行
          </button>
        </div>

        <section className={styles.attach}>
          <button type="button" className={styles.attachToggle} onClick={() => setAttachOpen((v) => !v)}>
            {attachOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Paperclip size={14} /> 附件{existing ? '' : `（${attachCount}）`}
            {!attachOpen && <span className={styles.attachHint}>＋ 添加图片，或把图片拖进来</span>}
          </button>
          {attachOpen &&
            (existing ? (
              <AttachmentPanel documentId={existing.id} />
            ) : (
              <AttachmentPanel
                documentId={0}
                pendingFiles={pendingFiles}
                onPendingFilesChange={(files) => {
                  setPendingFiles(files)
                  markDirty()
                }}
              />
            ))}
        </section>
      </div>

      <footer className={styles.footer}>
        <div className={styles.totals}>
          <span>
            合计 <strong>{formatQty(parsed.totalQty)}</strong> 件
          </span>
          <span>
            金额 <strong>¥{formatCents(parsed.totalAmount)}</strong>
          </span>
          {type === 'outbound' && parsed.totalAmount > 0 && (
            <span>
              预估毛利{' '}
              <strong className={profit < 0 ? styles.negative : undefined}>
                ¥{formatCents(profit)}（{profitRate.toFixed(1)}%）
              </strong>
            </span>
          )}
        </div>
        <div className={styles.buttons}>
          <Button variant="ghost" onClick={() => closeDrawer()} disabled={busy !== null}>
            取消
          </Button>
          <Button variant="secondary" onClick={handleSave} disabled={busy !== null} loading={busy === 'save'}>
            保存草稿
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={busy !== null || insufficient}
            disabledReason={insufficient ? '库存不足，不能确认出库' : undefined}
            loading={busy === 'confirm'}
          >
            确认{label}
          </Button>
        </div>
      </footer>
    </div>
  )
}

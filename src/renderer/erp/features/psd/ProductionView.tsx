/**
 * 描述: 定制 › 生产视图 (ProductionView)
 * 主要功能:
 *   - 当前模板栏 → 替换位置卡片 → 底部操作区（导出目录与格式 / 定制标题与生成）
 *   - 位置卡片默认三列，按可用宽度降到两列 / 一列；超过 9 个时区域限高内部滚动
 *   - 新建模板只在当前模板栏出现一次，空状态只给说明
 *   - 点狗图 / 名字图分别打开对应类别的选图弹窗；生产页不再有素材库面板
 *   - 位置增删与图层映射都写入模板配置，不修改 PSD 文件
 *   - Photoshop 未就绪、缺图、图层名不合法时禁用生成并逐条说明
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { Check, FolderOpen, ImagePlus, Info, Plus } from 'lucide-react'
import { isSafeLayerName, type PsdAssetKind, type PsdBoard, type PsdExportFormat, type PsdSlot } from '@shared/erp/psd'
import { Button, Input, Select, Tooltip } from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { unwrap, errorMessage } from '@erp/lib/api'
import { middleEllipsis, slotKeyOf, slotLabel } from './psdLabels'
import { SlotCard } from './SlotCard'
import { AssetPickerDialog } from './AssetPickerDialog'
import styles from './ProductionView.module.css'

interface Pick {
  dogId: number
  nameId: number
}
const EMPTY_PICK: Pick = { dogId: 0, nameId: 0 }
const EMPTY_SLOTS: PsdSlot[] = []
const EMPTY_ASSETS: PsdBoard['assets'] = []

export interface ProductionViewProps {
  board: PsdBoard | null
  busy: boolean
  psReady: boolean
  templateId: number | null
  onChooseTemplate: (id: number) => void
  onAct: (fn: () => Promise<PsdBoard | null>, ok?: string) => Promise<void>
  onBoard: (board: PsdBoard) => void
  onNewTemplate: () => void
  onGoTemplates: () => void
  onImport: (kind: PsdAssetKind) => Promise<void>
  /** 生产页当前选中的素材集合，供素材库删除时做引用检查 */
  onSelectionChange: (ids: Set<number>, clear: () => void) => void
}

export function ProductionView({
  board,
  busy,
  psReady,
  templateId,
  onChooseTemplate,
  onAct,
  onBoard,
  onNewTemplate,
  onGoTemplates,
  onImport,
  onSelectionChange
}: ProductionViewProps): ReactElement {
  const toast = useToast()
  const [picks, setPicks] = useState<Record<number, Pick>>({})
  const [title, setTitle] = useState('')
  const [format, setFormat] = useState<PsdExportFormat>('psd')
  const [picker, setPicker] = useState<{ slotId: number; kind: PsdAssetKind } | null>(null)
  const [adding, setAdding] = useState(false)

  const templates = board?.templates ?? []
  const template = templates.find((t) => t.id === templateId) ?? templates[0] ?? null
  const slots = template?.slots ?? EMPTY_SLOTS
  const assets = board?.assets ?? EMPTY_ASSETS
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets])

  useEffect(() => {
    setPicks({})
  }, [template?.id])

  const pickOf = (slot: PsdSlot): Pick => picks[slot.id] ?? EMPTY_PICK
  const setPick = (slot: PsdSlot, patch: Partial<Pick>): void =>
    setPicks((cur) => ({ ...cur, [slot.id]: { ...(cur[slot.id] ?? EMPTY_PICK), ...patch } }))

  const clearPicks = useCallback(() => setPicks({}), [])
  useEffect(() => {
    const ids = new Set<number>()
    for (const slot of slots) {
      const pick = picks[slot.id]
      if (!pick) continue
      if (pick.dogId) ids.add(pick.dogId)
      if (pick.nameId) ids.add(pick.nameId)
    }
    onSelectionChange(ids, clearPicks)
  }, [picks, slots, onSelectionChange, clearPicks])

  // 逐条列出不能生成的原因
  const blockers = useMemo(() => {
    const list: string[] = []
    if (!template) return ['先选择一个模板']
    if (!template.sourceExists) list.push('模板 PSD 文件不在原位置，请到模板页检查')
    if (!slots.length) list.push('模板还没有替换位置，先添加位置')
    if (!title.trim()) list.push('请填写定制标题（会用作导出文件名）')

    const missing: string[] = []
    for (const slot of slots) {
      const pick = pickOf(slot)
      if (!pick.dogId) missing.push(`${slotLabel(slot.slotKey)}狗图`)
      if (!pick.nameId) missing.push(`${slotLabel(slot.slotKey)}名字图`)
    }
    if (missing.length) list.push(`缺素材：${missing.join('、')}`)

    const seen = new Set<string>()
    let layerError = false
    for (const slot of slots) {
      if (!isSafeLayerName(slot.dogLayer) || !isSafeLayerName(slot.nameLayer)) layerError = true
      for (const layer of [slot.dogLayer, slot.nameLayer]) {
        if (seen.has(layer)) layerError = true
        else seen.add(layer)
      }
    }
    if (layerError) list.push('图层映射不合法：名称不能为空或含特殊字符，且模板内不能重复')

    if (!psReady) list.push('Photoshop 未就绪，生成按钮已禁用；点顶部的 Photoshop 状态检查连接')
    return list
    // pickOf 依赖 picks，这里显式列出以便缺图提示实时更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, slots, title, psReady, picks])

  async function addSlot(): Promise<void> {
    if (!template) return
    const used = new Set(slots.map((s) => s.slotKey))
    let key = ''
    for (let n = 1; n <= 99; n++) {
      const candidate = slotKeyOf(n)
      if (!used.has(candidate)) {
        key = candidate
        break
      }
    }
    if (!key) {
      toast('位置数量已达到上限（99 个）', 'error')
      return
    }
    setAdding(true)
    try {
      const next = await unwrap(
        window.api.erp.psd.addSlot({
          templateId: template.id,
          slotKey: key,
          dogLayer: `${key}_dog`,
          nameLayer: `${key}_name`
        })
      )
      onBoard(next)
      toast(`${slotLabel(key)}已添加`, 'success')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setAdding(false)
    }
  }

  async function saveMapping(slot: PsdSlot, dogLayer: string, nameLayer: string): Promise<string | null> {
    try {
      const next = await unwrap(window.api.erp.psd.updateSlot({ id: slot.id, dogLayer, nameLayer }))
      onBoard(next)
      toast(`${slotLabel(slot.slotKey)}图层映射已保存`, 'success')
      return null
    } catch (err) {
      const message = errorMessage(err)
      toast(message, 'error')
      return message
    }
  }

  async function deleteSlot(slot: PsdSlot): Promise<void> {
    try {
      const next = await unwrap(window.api.erp.psd.deleteSlot(slot.id))
      onBoard(next)
      setPicks((cur) => {
        const copy = { ...cur }
        delete copy[slot.id]
        return copy
      })
      toast(`${slotLabel(slot.slotKey)}已删除`, 'success')
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  function submit(): void {
    if (!template || blockers.length) return
    const items = slots.map((slot) => {
      const pick = pickOf(slot)
      return { slotId: slot.id, dogAssetId: pick.dogId, nameAssetId: pick.nameId }
    })
    void onAct(async () => {
      const next = await unwrap(
        window.api.erp.psd.createJob({
          templateId: template.id,
          title: title.trim(),
          format,
          items
        })
      )
      setTitle('')
      setPicks({})
      return next
    }, '已加入生成队列')
  }

  const pickerSlot = picker ? slots.find((s) => s.id === picker.slotId) : undefined
  const pickerSelected =
    pickerSlot && picker ? (picker.kind === 'dog' ? pickOf(pickerSlot).dogId : pickOf(pickerSlot).nameId) : 0

  return (
    <div className={styles.root}>
      {/* 当前模板：左边模板，右边管理 / 新建 */}
      <section className={styles.templateRow} aria-label="当前模板">
        <span className={styles.rowLabel}>当前模板</span>
        {templates.length ? (
          <div className={styles.templateSelect}>
            <Select
              value={String(template?.id ?? '')}
              options={templates.map((t) => ({
                value: String(t.id),
                label: `${t.name} · ${t.slots.length} 个位置`
              }))}
              onChange={(v) => onChooseTemplate(Number(v))}
            />
          </div>
        ) : (
          <span className={styles.muted}>尚未选择模板</span>
        )}
        {template && (
          <span className={template.sourceExists ? styles.fileOk : styles.danger}>
            {template.sourceExists ? 'PSD 文件可用' : 'PSD 文件丢失'}
          </span>
        )}
        <div className={styles.templateActions}>
          <Button variant="ghost" onClick={onGoTemplates}>
            管理模板
          </Button>
          <Button variant="primary" icon={<Plus size={14} />} onClick={onNewTemplate}>
            新建模板
          </Button>
        </div>
      </section>

      {/* 替换位置 */}
      <section className={styles.slotSection} aria-label="替换位置">
        <header className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>
            替换位置<span className={styles.count}> · {slots.length} 个</span>
          </h2>
          <Button
            variant="secondary"
            icon={<Plus size={14} />}
            disabled={busy || adding || !template}
            onClick={() => void addSlot()}
          >
            添加位置
          </Button>
        </header>

        {!template ? (
          <div className={styles.empty}>
            <ImagePlus size={24} />
            <p>请先创建并选择模板，替换位置将在这里显示。</p>
          </div>
        ) : slots.length === 0 ? (
          <div className={styles.empty}>
            <ImagePlus size={24} />
            <p>这个模板还没有替换位置，点右上角「添加位置」开始。</p>
          </div>
        ) : (
          <div className={styles.slotGrid}>
            {slots.map((slot) => (
              <SlotCard
                key={slot.id}
                slot={slot}
                dog={assetById.get(pickOf(slot).dogId)}
                name={assetById.get(pickOf(slot).nameId)}
                busy={busy}
                onPick={(kind) => setPicker({ slotId: slot.id, kind })}
                onSaveMapping={(dogLayer, nameLayer) => saveMapping(slot, dogLayer, nameLayer)}
                onDelete={() => deleteSlot(slot)}
              />
            ))}
          </div>
        )}
      </section>

      {/* 底部操作区：导出设置与生成合成一块 */}
      <section className={styles.actionBar} aria-label="导出与生成">
        <div className={styles.exportLine}>
          <span className={styles.rowLabel}>导出目录</span>
          <span className={styles.path} title={board?.outputDir}>
            {board?.outputDir ? middleEllipsis(board.outputDir, 64) : '读取中…'}
          </span>
          <Button
            variant="ghost"
            icon={<FolderOpen size={14} />}
            disabled={busy}
            onClick={() => void onAct(() => unwrap(window.api.erp.psd.pickOutputDir()), '导出目录已更新')}
          >
            更改
          </Button>
          <span className={`${styles.rowLabel} ${styles.formatLabel}`}>导出格式</span>
          <div className={styles.formatSelect}>
            <Select
              value={format}
              options={[
                { value: 'psd', label: 'PSD' },
                { value: 'tiff', label: 'TIFF' }
              ]}
              onChange={(v) => setFormat(v as PsdExportFormat)}
            />
          </div>
          <Tooltip
            content={
              <span className={styles.tip}>
                PSD 和 TIFF 都会写入 W1 红色专色通道（密度 100%）。素材按圆内矩形区域等比例缩放，完整显示、不拉伸。
              </span>
            }
          >
            <span className={styles.info} tabIndex={0} aria-label="导出规则">
              <Info size={15} />
            </span>
          </Tooltip>
        </div>
        <div className={styles.generateLine}>
          <div className={styles.titleInput}>
            <Input
              value={title}
              maxLength={60}
              placeholder="定制标题，用作导出文件名"
              aria-label="定制标题"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit()
              }}
            />
          </div>
          <Button
            variant="primary"
            icon={<Check size={14} />}
            disabled={busy || blockers.length > 0}
            disabledReason={blockers[0]}
            onClick={submit}
          >
            生成任务{slots.length ? `（${slots.length} 个位置）` : ''}
          </Button>
        </div>
        {blockers.length > 0 ? (
          <ul className={styles.blockers}>
            {blockers.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : (
          <p className={styles.ready}>可以生成：{slots.length} 个位置都会写进同一个文件。</p>
        )}
      </section>

      <AssetPickerDialog
        open={picker !== null}
        kind={picker?.kind ?? 'dog'}
        assets={assets}
        selectedId={pickerSelected}
        busy={busy}
        onClose={() => setPicker(null)}
        onConfirm={(asset) => {
          if (!pickerSlot || !picker) return
          setPick(pickerSlot, {
            [picker.kind === 'dog' ? 'dogId' : 'nameId']: asset.id
          } as Partial<Pick>)
          setPicker(null)
        }}
        onImport={() => (picker ? onImport(picker.kind) : Promise.resolve())}
      />
    </div>
  )
}

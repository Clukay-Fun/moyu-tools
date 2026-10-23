/**
 * 描述: 设置 › 数据管理 (DataSettings)
 * 主要功能:
 *   - 备份与恢复：创建备份；选择备份文件 → 校验报告 → 确认后恢复（当前数据先移入回收目录）
 *   - 销售渠道（ChannelSettings）
 *   - 示例数据与模板：示例数据只在没有业务数据时可载入，载入前确认；下载 CSV 模板
 *   - 危险操作：清空业务数据，确认框列出删除 / 保留的内容，附「先创建备份」
 * 回收目录（恢复前的旧数据）在「存储」分类里。
 */

import type { ReactElement } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, DatabaseBackup, Eraser, FileDown, FolderOpen, Sparkles } from 'lucide-react'
import type { BackupInspection } from '@shared/erp/types'
import { Button, ConfirmDialog } from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { useNav } from '@erp/app/navigation'
import { unwrap, errorMessage } from '@erp/lib/api'
import { emitDataChanged, useDataChanged } from '@erp/lib/dataEvents'
import { ChannelSettings } from './ChannelSettings'
import { SettingRow, SettingsGroup } from './SettingsLayout'
import styles from './DataSettings.module.css'

export function DataSettings(): ReactElement {
  const toast = useToast()
  const { navigate } = useNav()
  const [hasData, setHasData] = useState<boolean | null>(null)
  const [busy, setBusy] = useState<null | 'backup' | 'inspect' | 'restore' | 'seed' | 'reset' | 'csv'>(null)
  const [inspection, setInspection] = useState<BackupInspection | null>(null)
  const [confirm, setConfirm] = useState<null | 'restore' | 'seed' | 'reset'>(null)

  const loadHasData = useCallback(async () => {
    try {
      setHasData(await unwrap(window.api.erp.demo.hasData()))
    } catch {
      setHasData(null)
    }
  }, [])
  useEffect(() => {
    void loadHasData()
  }, [loadHasData])
  // 设置分节常驻在摸鱼设置页里：单据增删、恢复备份之后都要重新判断是否空库
  useDataChanged(() => void loadHasData())

  async function run(kind: NonNullable<typeof busy>, fn: () => Promise<void>): Promise<void> {
    setBusy(kind)
    try {
      await fn()
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  const createBackup = (): Promise<void> =>
    run('backup', async () => {
      const p = await unwrap(window.api.erp.backup.create())
      if (p) toast(`备份已保存到 ${p}`, 'success')
    })

  const pickBackup = (): Promise<void> =>
    run('inspect', async () => {
      setInspection(null)
      const p = await unwrap(window.api.erp.backup.pick())
      if (p) setInspection(await unwrap(window.api.erp.backup.inspect(p)))
    })

  async function restore(): Promise<void> {
    if (!inspection) return
    setBusy('restore')
    try {
      await unwrap(window.api.erp.backup.restore(inspection.path))
      // 主进程随后广播 erp:data:replaced，各页面重新读取
      toast('恢复完成，数据已更新', 'success')
      setBusy(null)
      setConfirm(null)
      setInspection(null)
    } catch (err) {
      toast(errorMessage(err), 'error')
      setBusy(null)
      setConfirm(null)
    }
  }

  const seed = (): Promise<void> =>
    run('seed', async () => {
      const r = await unwrap(window.api.erp.demo.seed())
      setConfirm(null)
      toast(`已载入 ${r.documents} 张示例单据`, 'success')
      emitDataChanged()
      navigate('overview')
    })

  const reset = (): Promise<void> =>
    run('reset', async () => {
      await unwrap(window.api.erp.demo.reset())
      setConfirm(null)
      toast('业务数据已清空', 'success')
      emitDataChanged()
      await loadHasData()
    })

  const saveCsvTemplate = (): Promise<void> =>
    run('csv', async () => {
      const p = await unwrap(window.api.erp.csv.saveTemplate())
      if (p) toast('CSV 模板已保存', 'success')
    })

  const m = inspection?.manifest
  const inspectionOk = inspection !== null && inspection.problems.length === 0

  return (
    <>
      <SettingsGroup title="备份与恢复">
        <SettingRow label="创建备份" desc="把库存数据库和全部图片附件打包成一个 zip，建议定期备份到其他磁盘或网盘。">
          <Button
            variant="primary"
            icon={<DatabaseBackup size={16} />}
            loading={busy === 'backup'}
            onClick={createBackup}
          >
            创建备份
          </Button>
        </SettingRow>
        <SettingRow label="从备份恢复" desc="用备份替换当前全部数据。恢复前会先校验；当前数据先移入回收目录，不会直接删除。">
          <Button
            variant="secondary"
            icon={<FolderOpen size={16} />}
            loading={busy === 'inspect'}
            disabled={busy === 'restore'}
            onClick={pickBackup}
          >
            选择备份文件
          </Button>
        </SettingRow>
        {inspection && m && (
          <div className={`${styles.report} ${inspectionOk ? styles.reportOk : styles.reportBad}`}>
            <div className={styles.reportHead}>
              {inspectionOk ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
              <span className={styles.file}>{inspection.path}</span>
            </div>
            <dl className={styles.meta}>
              <dt>备份时间</dt>
              <dd>{new Date(m.createdAt).toLocaleString('zh-CN')}</dd>
              <dt>应用版本</dt>
              <dd>
                {m.appVersion} · 数据库 v{m.schemaVersion}
              </dd>
              <dt>内容</dt>
              <dd>
                {m.counts.documents} 张单据 · {m.counts.movements} 条流水 · {m.counts.attachments} 个附件
              </dd>
            </dl>
            {inspection.problems.length > 0 ? (
              <ul className={styles.problems}>
                {inspection.problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            ) : (
              <div className={styles.actions}>
                <Button variant="ghost" size="sm" onClick={() => setInspection(null)} disabled={busy === 'restore'}>
                  取消
                </Button>
                <Button variant="danger" size="sm" onClick={() => setConfirm('restore')} disabled={busy === 'restore'}>
                  恢复此备份
                </Button>
              </div>
            )}
          </div>
        )}
      </SettingsGroup>

      <ChannelSettings />

      <SettingsGroup title="示例数据与模板">
        <SettingRow
          label="载入示例数据"
          desc="期初 300 件、两周内 12 张出入库单、1 张作废、1 张草稿、1 张盘点调整，备注都带「示例：」前缀。"
        >
          <Button
            variant="secondary"
            icon={<Sparkles size={16} />}
            disabled={busy !== null || hasData !== false}
            disabledReason={hasData ? '已有业务数据，只能在空库时载入' : undefined}
            onClick={() => setConfirm('seed')}
          >
            载入
          </Button>
        </SettingRow>
        <SettingRow label="下载 CSV 模板" desc="批量导入单据时按这个格式填写，在「单据 › 更多 › 导入 CSV」里导入。">
          <Button variant="secondary" icon={<FileDown size={16} />} loading={busy === 'csv'} onClick={saveCsvTemplate}>
            下载模板
          </Button>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="危险操作" danger>
        <SettingRow
          label="清空全部单据、流水和附件"
          desc="商品资料、渠道和 Photoshop 设置会保留。不可撤销，建议先备份。"
        >
          <Button
            variant="danger"
            icon={<Eraser size={16} />}
            disabled={busy !== null || hasData !== true}
            disabledReason={hasData === false ? '目前没有业务数据' : undefined}
            onClick={() => setConfirm('reset')}
          >
            清空
          </Button>
        </SettingRow>
      </SettingsGroup>

      <ConfirmDialog
        open={confirm === 'restore'}
        onOpenChange={(o) => !o && setConfirm(null)}
        danger
        title="恢复备份？"
        description="将用备份替换全部库存 / 定制数据。当前数据会先移入回收目录，恢复后各页面会重新读取。"
        confirmText="恢复备份"
        loading={busy === 'restore'}
        onConfirm={restore}
      />
      <ConfirmDialog
        open={confirm === 'seed'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="载入示例数据？"
        description="会写入一套示例商品期初和两周的单据，备注都带「示例：」。不想要时可以用「清空业务数据」删掉。"
        confirmText="载入"
        loading={busy === 'seed'}
        onConfirm={seed}
      />
      <ConfirmDialog
        open={confirm === 'reset'}
        onOpenChange={(o) => !o && setConfirm(null)}
        danger
        title="清空全部业务数据？"
        description="此操作不可撤销。"
        confirmText="清空"
        loading={busy === 'reset'}
        onConfirm={reset}
      >
        <div className={styles.resetList}>
          <div>
            <strong>会删除</strong>
            <ul>
              <li>全部单据（含草稿、已作废）</li>
              <li>全部库存流水，库存归零</li>
              <li>单据附件图片</li>
            </ul>
          </div>
          <div>
            <strong>会保留</strong>
            <ul>
              <li>商品资料与图片</li>
              <li>销售渠道</li>
              <li>Photoshop 设置</li>
            </ul>
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          icon={<DatabaseBackup size={14} />}
          loading={busy === 'backup'}
          onClick={createBackup}
        >
          先创建备份
        </Button>
      </ConfirmDialog>
    </>
  )
}

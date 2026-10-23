/**
 * 描述: 设置 › Photoshop 连接 (PhotoshopSettings)
 * 主要功能:
 *   - 连接状态：Photoshop 检测结果、插件状态（软件找到 ≠ 插件连通），重新检测
 *   - 插件安装（默认收起）：本机 / Mac / Windows 页签，可准备或安装插件
 *   - 目录与授权：桥接目录与导出目录，打开 / 修改
 *   - 高级工具（默认收起）：插件目录、UXP Developer Tools、放回中断任务
 * 原「定制 › 设置」抽屉的全部内容搬到这里，底层调用不变。
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { PHOTOSHOP_MIN_VERSION, type PhotoshopStatus } from '@shared/photoshop'
import type { PsdBoard } from '@shared/erp/psd'
import type { AppInfo } from '@shared/erp/ipc'
import { Button, SegmentedControl } from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { unwrap, errorMessage } from '@erp/lib/api'
import { SettingRow, SettingsDisclosure, SettingsGroup } from '@erp/features/settings/SettingsLayout'
import { fileName } from './psdLabels'
import styles from './PhotoshopSettings.module.css'

type PlatformTab = 'actual' | 'darwin' | 'win32'

function psLabel(status: PhotoshopStatus): string {
  if (status.version) return `Photoshop ${status.version}`
  return status.path ? fileName(status.path).replace(/\.(app|exe)$/i, '') : 'Photoshop'
}

export function PhotoshopSettings(): ReactElement {
  const toast = useToast()
  const [board, setBoard] = useState<PsdBoard | null>(null)
  const [platform, setPlatform] = useState<AppInfo['platform'] | null>(null)
  const [tab, setTab] = useState<PlatformTab>('actual')
  const [busy, setBusy] = useState(false)
  const [ps, setPs] = useState<PhotoshopStatus | null>(null)
  const [detecting, setDetecting] = useState(false)

  // 公共 Photoshop 服务的检测结果（启动时检测一次；这里可以手动重新检测）
  useEffect(() => {
    void window.api.photoshop.getStatus().then(setPs)
    return window.api.photoshop.onStatus(setPs)
  }, [])

  async function redetect(): Promise<void> {
    setDetecting(true)
    try {
      const next = await window.api.photoshop.redetect()
      setPs(next)
      await load()
      toast(next.installed ? `已检测到 ${psLabel(next)}` : '没有检测到 Photoshop', next.installed ? 'success' : 'info')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setDetecting(false)
    }
  }

  const load = useCallback(async () => {
    setBoard(await unwrap(window.api.erp.psd.getBoard()))
  }, [])

  useEffect(() => {
    load().catch((err: unknown) => toast(errorMessage(err), 'error'))
    unwrap(window.api.erp.app.getInfo())
      .then((info) => setPlatform(info.platform))
      .catch(() => {})
  }, [load, toast])

  async function act(fn: () => Promise<PsdBoard | null>, ok?: string): Promise<void> {
    setBusy(true)
    try {
      const next = await fn()
      if (next) setBoard(next)
      if (ok && next) toast(ok, 'success')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const previewOnly = tab !== 'actual' && tab !== platform
  const shown = tab === 'actual' ? platform : tab
  const isMac = shown === 'darwin'
  const disabled = busy || previewOnly
  const pluginDir = previewOnly
    ? isMac
      ? '…/photoshop-plugin/moyu-psd/uxp'
      : '%APPDATA%\\Adobe\\CEP\\extensions\\com.clukay.moyu.psd'
    : board?.pluginDir
  const activeJobs = board?.jobs.filter((job) => job.status === 'queued' || job.status === 'running') ?? []
  const hasRunningExport = activeJobs.some((job) => job.status === 'running')
  const psName = ps?.installed ? psLabel(ps) : null
  const checking = !ps || ps.state === 'checking'

  const psStatus = checking ? '检测中…' : (psName ?? '没找到')
  const psNote = checking
    ? '应用启动时会在后台检测一次。'
    : psName
      ? ps?.supported === false
        ? `版本低于 ${PHOTOSHOP_MIN_VERSION}，插件可能无法加载。`
        : '已在本机找到，生成时会按需打开。'
      : '没有在常见位置找到 Photoshop，生成任务会一直排队。'

  return (
    <>
      <SettingsGroup title="连接状态">
        <SettingRow label="Photoshop" desc={psNote}>
          <strong className={`${styles.status} ${psName ? styles.ok : checking ? '' : styles.warn}`}>{psStatus}</strong>
          <Button disabled={detecting} onClick={() => void redetect()}>
            {detecting ? '检测中…' : '重新检测'}
          </Button>
        </SettingRow>
        <SettingRow label="插件" desc="装好不等于连通：插件收到任务才会处理。如果任务一直排队，按下面的说明重新安装。">
          <strong className={`${styles.status} ${ps?.pluginInstalled ? styles.ok : ''}`}>
            {activeJobs.length ? '正在处理任务' : ps?.pluginInstalled ? '已安装' : '未安装'}
          </strong>
        </SettingRow>
      </SettingsGroup>

      <SettingsDisclosure
        title="插件安装"
        label="安装说明"
        desc={platform === 'win32' ? 'Windows 使用 CEP 扩展面板' : 'Mac 使用 UXP 插件'}
      >
        <SegmentedControl
          options={[
            { value: 'actual', label: '本机' },
            { value: 'darwin', label: 'Mac · UXP' },
            { value: 'win32', label: 'Windows · CEP' }
          ]}
          value={tab}
          onChange={setTab}
        />
        {previewOnly && <p className={styles.note}>只是查看另一个系统的步骤，按钮已停用。</p>}
        <p className={styles.hint}>
          {isMac
            ? 'Mac 使用 UXP 插件。安装后在 UXP Developer Tools 中加载；摸鱼工具箱会按需打开 Photoshop，任务完成后保持打开。'
            : 'Windows 使用 CEP 扩展面板。安装后可从 Photoshop「窗口 → 扩展（旧版）→ 摸鱼 PSD」打开；后台扩展自动处理任务。'}
        </p>
        <ol className={styles.steps}>
          {isMac ? (
            <>
              <li>点「准备 UXP 插件」；若列表没有摸鱼 PSD，用 Add Plugin 选择下方 manifest.json，然后点 Load。</li>
              <li>在 Photoshop「插件 → 摸鱼 PSD」打开面板，首次使用时授权桥接目录及导出目录。</li>
              <li>
                生成任务前会检查插件状态；若未加载，摸鱼工具箱会打开 UXP Developer Tools，点 Load 后插件会自动处理队列。
              </li>
            </>
          ) : (
            <>
              <li>点「安装 CEP 面板」后重启 Photoshop，再从「窗口 → 扩展（旧版）→ 摸鱼 PSD」打开。</li>
              <li>桥接目录和导出目录由摸鱼工具箱自动同步给扩展，无需在 Photoshop 中重复授权。</li>
              <li>后台扩展会随 Photoshop 启动并处理队列；面板显示日志和手动检查按钮。</li>
            </>
          )}
        </ol>
        <div className={styles.actions}>
          <Button
            variant="primary"
            disabled={disabled}
            onClick={() =>
              void act(
                () => unwrap(window.api.erp.psd.installPlugin()),
                isMac
                  ? 'UXP 插件文件已准备好；请在 UXP Developer Tools 中选择 manifest.json 并点 Load'
                  : 'CEP 面板已安装；请重启 Photoshop 后从「窗口 → 扩展（旧版）」打开「摸鱼 PSD」'
              )
            }
          >
            {isMac ? '准备 UXP 插件' : '安装 CEP 面板'}
          </Button>
          {!isMac && (
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() =>
                void act(
                  () => unwrap(window.api.erp.psd.installPlugin()),
                  '旧 CEP 面板已删除并重新安装；请从 Photoshop「窗口 → 扩展（旧版）」打开「摸鱼 PSD」'
                )
              }
            >
              重新安装 CEP 面板
            </Button>
          )}
        </div>
      </SettingsDisclosure>

      <SettingsGroup title="目录与授权">
        <DirRow
          label="桥接目录"
          note="摸鱼工具箱和 Photoshop 插件在这里交换任务"
          path={board?.bridgeDir}
          disabled={busy}
          onOpen={() => void act(() => unwrap(window.api.erp.psd.openBridge()).then(() => null))}
          onPick={() => void act(() => unwrap(window.api.erp.psd.pickBridgeDir()), '桥接目录已更新')}
        />
        <DirRow
          label="导出目录"
          note="生成的 PSD / TIFF 和透明 PNG 存在这里"
          path={board?.outputDir}
          disabled={busy}
          onOpen={() => void act(() => unwrap(window.api.erp.psd.openOutputDir()).then(() => null))}
          onPick={() => void act(() => unwrap(window.api.erp.psd.pickOutputDir()), '导出目录已更新')}
        />
        <p className="settings-group-note">
          {platform === 'darwin'
            ? '修改目录后，请在 Photoshop 插件面板中重新授权。'
            : '修改目录后，摸鱼工具箱会自动同步给 Photoshop 后台扩展。'}
        </p>
      </SettingsGroup>

      <SettingsDisclosure title="高级工具" label="插件目录与调试工具" desc="排查插件加载问题时使用">
        <div className={styles.actions}>
          <Button
            variant="secondary"
            disabled={disabled}
            onClick={() => void act(() => unwrap(window.api.erp.psd.openPlugin()).then(() => null))}
          >
            {isMac ? '打开 UXP 插件目录' : '打开 CEP 面板目录'}
          </Button>
          {isMac && (
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => void act(() => unwrap(window.api.erp.psd.openUxpDeveloperTool()).then(() => null))}
            >
              打开 UXP Developer Tools
            </Button>
          )}
          {hasRunningExport && (
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() =>
                void act(async () => (await unwrap(window.api.erp.psd.requeueStuck())).board, '已检查中断任务')
              }
            >
              放回中断任务
            </Button>
          )}
        </div>
        <p className={styles.note}>
          {isMac ? 'UXP 插件文件：' : 'CEP 面板安装目录：'}
          {previewOnly ? '（目标系统示例）' : ''}
        </p>
        <p className={styles.mono}>
          {pluginDir ?? '加载中…'}/{isMac ? 'manifest.json' : 'CSXS/manifest.xml'}
        </p>
        <p className={styles.note}>Photoshop 路径：</p>
        <p className={styles.mono}>{board?.photoshopPath ?? '未找到'}</p>
      </SettingsDisclosure>
    </>
  )
}

function DirRow({
  label,
  note,
  path,
  disabled,
  onOpen,
  onPick
}: {
  label: string
  note: string
  path: string | undefined
  disabled: boolean
  onOpen: () => void
  onPick: () => void
}): ReactElement {
  return (
    <SettingRow label={label} desc={note} path={path ?? null}>
      <Button variant="secondary" disabled={disabled} onClick={onOpen}>
        打开
      </Button>
      <Button variant="secondary" disabled={disabled} onClick={onPick}>
        修改
      </Button>
    </SettingRow>
  )
}

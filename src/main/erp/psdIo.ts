import { app, dialog, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PsdAssetKind, PsdBoard } from '@shared/erp/psd'
import type {
  PsdJobCreateInput,
  PsdSlotCreateInput,
  PsdSlotUpdateInput,
  PsdTemplateCreateInput,
  PsdTemplateRenameInput
} from '@shared/erp/schemas'
import { state } from './appState'
import { getPhotoshopStatus, photoshopPath, refreshPhotoshopStatus } from '../photoshop'
import { bundledPluginDirectory, installedPluginDirectory } from './psdPlugin'
import { createLaunchGate, darwinPhotoshopPids, windowsPhotoshopPids } from './photoshopProcess'
import { ServiceError } from './services/errors'
import {
  addPsdSlot,
  updatePsdSlot,
  renamePsdTemplate,
  cancelPsdJob,
  cancelPsdCutoutJob,
  confirmPsdCutoutJob,
  createPsdCutoutJob,
  createPsdJob,
  createPsdTemplate,
  deletePsdAsset,
  deletePsdSlot,
  deletePsdTemplate,
  getPsdBoard,
  importPsdAsset,
  requeueStuckPsdJobs,
  retryPsdJob,
  type PsdPaths
} from './services/psdExport'
import { owner } from './window'

const execFileAsync = promisify(execFile)
const photoshopLaunch = createLaunchGate<void>()
const UXP_PLUGIN_HEARTBEAT_FILE = 'uxp-plugin-heartbeat.json'
const UXP_PLUGIN_HEARTBEAT_TTL_MS = 10_000

async function photoshopPids(): Promise<number[]> {
  try {
    if (process.platform === 'darwin') {
      const result = await execFileAsync('ps', ['-axo', 'pid=,command='])
      return darwinPhotoshopPids(result.stdout)
    }
    if (process.platform === 'win32') {
      const result = await execFileAsync('tasklist', ['/FO', 'CSV', '/FI', 'IMAGENAME eq Photoshop.exe'])
      return windowsPhotoshopPids(result.stdout)
    }
  } catch {
    return []
  }
  return []
}

async function waitForPhotoshopPid(): Promise<number | null> {
  // Photoshop 2026 can take longer than 20 seconds on a cold start, especially
  // when the plugin is also being loaded for the first time.
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const ids = await photoshopPids()
    if (ids.length > 0) return ids[0]
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return null
}

function dirs(): PsdPaths {
  return { assetsDir: state.psdAssetsDir, bridgeDir: state.psdBridgeDir, outputDir: state.psdOutputDir }
}

function cepSystemCopies(): string[] {
  if (process.platform !== 'win32') return []
  const roots = [process.env.CommonProgramFiles, process.env['CommonProgramFiles(x86)']].filter(
    (value): value is string => Boolean(value)
  )
  const copies: string[] = []
  for (const root of roots) {
    const directory = join(root, 'Adobe', 'CEP', 'extensions')
    if (!existsSync(directory)) continue
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(directory, entry.name, 'CSXS', 'manifest.xml')
      if (!existsSync(candidate)) continue
      const manifest = readFileSync(candidate, 'utf8')
      if (/ExtensionBundleId="com\.clukay\.moyu\.psd"/i.test(manifest) && !copies.includes(candidate)) {
        copies.push(candidate)
      }
    }
  }
  return copies
}

function sameFileContents(left: string, right: string): boolean {
  const digest = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
  return digest(left) === digest(right)
}

function assertCurrentCepInstalled(): void {
  if (process.platform !== 'win32') return
  const source = bundledPluginDirectory()
  const target = installedPluginDirectory()
  for (const file of [join('CSXS', 'manifest.xml'), 'worker.js', 'host.jsx']) {
    if (!existsSync(join(target, file)) || !sameFileContents(join(source, file), join(target, file))) {
      throw new ServiceError(
        'VALIDATION',
        'Windows CEP 面板版本与当前摸鱼工具箱不一致。请完全退出 Photoshop，再到“设置 › 定制”安装 CEP 面板'
      )
    }
  }
}

function pluginDirectory(): string {
  const installed = installedPluginDirectory()
  const manifest = process.platform === 'darwin' ? 'manifest.json' : join('CSXS', 'manifest.xml')
  if (existsSync(join(installed, manifest))) return installed
  return process.platform === 'darwin' ? join(bundledPluginDirectory(), 'uxp') : bundledPluginDirectory()
}

function writePluginSettings(directory = installedPluginDirectory()): void {
  if (process.platform === 'darwin') return
  if (!existsSync(join(directory, 'CSXS', 'manifest.xml'))) return
  writeFileSync(
    join(directory, 'moyu-settings.json'),
    JSON.stringify({ bridgeDir: state.psdBridgeDir, outputDir: state.psdOutputDir }, null, 2),
    'utf8'
  )
}

function board(): PsdBoard {
  return getPsdBoard(state.db, dirs(), {
    photoshopPath: photoshopPath(),
    pluginDir: pluginDirectory()
  })
}

async function openFolder(path: string): Promise<void> {
  const error = await shell.openPath(path)
  if (error) throw new ServiceError('INTERNAL', `无法打开：${error}`)
}

export function getPsdBoardInteractive(): PsdBoard {
  return board()
}

export async function pickPsdTemplate(): Promise<string | null> {
  const result = await dialog.showOpenDialog(owner()!, {
    title: '选择 PSD 模板',
    filters: [{ name: 'Photoshop', extensions: ['psd'] }],
    properties: ['openFile']
  })
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
}

export function createPsdTemplateInteractive(input: PsdTemplateCreateInput): PsdBoard {
  createPsdTemplate(state.db, input)
  return board()
}

export function deletePsdTemplateInteractive(templateId: number): PsdBoard {
  deletePsdTemplate(state.db, templateId)
  return board()
}

export function addPsdSlotInteractive(input: PsdSlotCreateInput): PsdBoard {
  addPsdSlot(state.db, input)
  return board()
}

export function updatePsdSlotInteractive(input: PsdSlotUpdateInput): PsdBoard {
  updatePsdSlot(state.db, input)
  return board()
}

export function renamePsdTemplateInteractive(input: PsdTemplateRenameInput): PsdBoard {
  renamePsdTemplate(state.db, input)
  return board()
}

export function deletePsdSlotInteractive(slotId: number): PsdBoard {
  deletePsdSlot(state.db, slotId)
  return board()
}

export async function importPsdAssetInteractive(kind: PsdAssetKind): Promise<PsdBoard | null> {
  const title = kind === 'dog' ? '选择狗图' : '选择名字图'
  const result = await dialog.showOpenDialog(owner()!, {
    title,
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }],
    properties: ['openFile']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  importPsdAsset(state.db, dirs(), kind, result.filePaths[0])
  return board()
}

export function deletePsdAssetInteractive(assetId: number): PsdBoard {
  deletePsdAsset(state.db, dirs(), assetId)
  return board()
}

export async function createPsdCutoutInteractive(assetId: number): Promise<PsdBoard> {
  assertCurrentCepInstalled()
  createPsdCutoutJob(state.db, dirs(), assetId)
  try {
    await startPhotoshopForJob()
  } catch (err) {
    console.error('[psd] 自动启动 Photoshop 失败（抠图任务仍在队列）:', err)
  }
  return board()
}

export function confirmPsdCutoutInteractive(jobId: number): PsdBoard {
  confirmPsdCutoutJob(state.db, dirs(), jobId)
  return board()
}

export function cancelPsdCutoutInteractive(jobId: number): PsdBoard {
  cancelPsdCutoutJob(state.db, dirs(), jobId)
  return board()
}

async function launchPhotoshop(appPath: string): Promise<void> {
  let command: string
  let args: string[]
  if (process.platform === 'darwin') {
    command = '/usr/bin/open'
    args = ['-a', appPath]
  } else if (process.platform === 'win32') {
    command = 'powershell.exe'
    const quoted = `'${appPath.replace(/'/g, "''")}'`
    args = ['-NoProfile', '-Command', `Start-Process -FilePath ${quoted}`]
  } else {
    const error = await shell.openPath(appPath)
    if (error) throw new ServiceError('INTERNAL', `无法启动 Photoshop：${error}`)
    return
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** 首次检测还没跑完时等它一下，避免启动后立刻点击被误报“没有找到” */
async function detectedPhotoshopPath(): Promise<string | null> {
  if (getPhotoshopStatus().state === 'checking') await refreshPhotoshopStatus()
  return photoshopPath()
}

async function startPhotoshopForJob(): Promise<void> {
  const found = await detectedPhotoshopPath()
  if (!found) throw new ServiceError('NOT_FOUND', '没有找到 Photoshop。请先安装 Photoshop 2024 或更新版本。')
  if ((await photoshopPids()).length > 0) return
  await photoshopLaunch.run(async () => {
    const again = await photoshopPids()
    if (again.length > 0) return
    await launchPhotoshop(found)
    // 保持启动门闩直到宿主进程出现，避免连续创建任务时重复打开 Photoshop。
    const pid = await waitForPhotoshopPid()
    if (!pid) throw new ServiceError('INTERNAL', '启动 Photoshop 超时，请检查安装目录后重试')
  })
}

function isUxpPluginActive(): boolean {
  if (process.platform !== 'darwin') return true
  try {
    const status = JSON.parse(readFileSync(join(state.psdBridgeDir, UXP_PLUGIN_HEARTBEAT_FILE), 'utf8')) as {
      updatedAt?: unknown
    }
    const now = Date.now()
    return (
      typeof status.updatedAt === 'number' &&
      status.updatedAt <= now &&
      now - status.updatedAt <= UXP_PLUGIN_HEARTBEAT_TTL_MS
    )
  } catch {
    return false
  }
}

async function waitForUxpPlugin(timeoutMs = 2500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isUxpPluginActive()) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return isUxpPluginActive()
}

export async function createPsdJobInteractive(input: PsdJobCreateInput): Promise<PsdBoard> {
  assertCurrentCepInstalled()
  createPsdJob(state.db, dirs(), input)
  try {
    // 只在有导出任务时启动。任务完成后保留 Photoshop，让已加载的开发插件继续可用。
    await startPhotoshopForJob()
    if (process.platform === 'darwin' && !(await waitForUxpPlugin())) {
      await openUxpDeveloperTool()
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[psd] 任务已排队，但 Photoshop 插件未准备好:', err)
    throw new ServiceError('INTERNAL', `任务已加入队列，但 Photoshop 插件未能自动就绪：${message}`)
  }
  return board()
}

export function cancelPsdJobInteractive(jobId: number): PsdBoard {
  cancelPsdJob(state.db, dirs(), jobId)
  return board()
}

export async function retryPsdJobInteractive(jobId: number): Promise<PsdBoard> {
  assertCurrentCepInstalled()
  retryPsdJob(state.db, dirs(), jobId)
  try {
    await startPhotoshopForJob()
  } catch (err) {
    console.error('[psd] 自动启动 Photoshop 失败:', err)
  }
  return board()
}

export function syncPsdInteractive(): PsdBoard {
  return board()
}

export function requeuePsdInteractive(): { board: PsdBoard; count: number } {
  const count = requeueStuckPsdJobs(state.db, dirs())
  return { board: board(), count }
}

export async function openPsdBridge(): Promise<void> {
  mkdirSync(dirs().bridgeDir, { recursive: true })
  await openFolder(dirs().bridgeDir)
}

export async function openPsdOutputDir(): Promise<void> {
  mkdirSync(dirs().outputDir!, { recursive: true })
  await openFolder(dirs().outputDir!)
}

function assertNoActivePsdTasks(): void {
  const jobs = state.db
    .prepare(
      `SELECT
      (SELECT COUNT(*) FROM psd_jobs WHERE status IN ('queued', 'running')) +
      (SELECT COUNT(*) FROM psd_cutout_jobs WHERE status IN ('queued', 'running')) AS count`
    )
    .get() as { count: number }
  if (jobs.count > 0) throw new ServiceError('VALIDATION', '先等待 Photoshop 队列完成，再修改目录')
}

async function pickPsdDirectory(kind: 'bridgeDir' | 'outputDir'): Promise<PsdBoard | null> {
  const result = await dialog.showOpenDialog(owner()!, {
    title: kind === 'bridgeDir' ? '选择 Photoshop 桥接目录' : '选择 PSD 导出目录',
    defaultPath: kind === 'bridgeDir' ? state.psdBridgeDir : state.psdOutputDir,
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || result.filePaths.length === 0) return null
  assertNoActivePsdTasks()
  state.setPsdDirectory(kind, result.filePaths[0])
  writePluginSettings()
  return board()
}

export function pickPsdBridgeDirectory(): Promise<PsdBoard | null> {
  return pickPsdDirectory('bridgeDir')
}

export function pickPsdOutputDirectory(): Promise<PsdBoard | null> {
  return pickPsdDirectory('outputDir')
}

export async function installPsdPlugin(): Promise<PsdBoard> {
  const source = process.platform === 'darwin' ? join(bundledPluginDirectory(), 'uxp') : bundledPluginDirectory()
  const target = installedPluginDirectory()
  const manifest = process.platform === 'darwin' ? 'manifest.json' : join('CSXS', 'manifest.xml')
  if (!existsSync(join(source, manifest))) throw new ServiceError('NOT_FOUND', '应用内没有找到 Photoshop 插件文件')
  if (process.platform === 'win32') {
    if ((await photoshopPids()).length > 0) {
      throw new ServiceError('VALIDATION', '请先完全退出 Photoshop，再点击“安装 CEP 面板”；运行中的旧面板不会自动更新')
    }
    const copies = cepSystemCopies()
    if (copies.length > 0) {
      throw new ServiceError(
        'VALIDATION',
        `发现系统目录中的同名 CEP 扩展，可能覆盖用户目录版本。请先移除旧扩展：${copies.join('；')}`
      )
    }
  }
  mkdirSync(join(target, '..'), { recursive: true })
  rmSync(target, { recursive: true, force: true })
  cpSync(source, target, { recursive: true, force: true })
  writePluginSettings(target)
  if (process.platform === 'win32') {
    for (const file of [manifest, 'worker.js', 'host.jsx', 'index.html']) {
      if (!sameFileContents(join(source, file), join(target, file))) {
        throw new ServiceError('INTERNAL', `CEP 插件安装校验失败：${file}`)
      }
    }
  }
  if (process.platform === 'win32') {
    await execFileAsync('reg.exe', [
      'add',
      'HKCU\\Software\\Adobe\\CSXS.12',
      '/v',
      'PlayerDebugMode',
      '/t',
      'REG_SZ',
      '/d',
      '1',
      '/f'
    ])
  } else if (process.platform !== 'darwin') {
    throw new ServiceError('VALIDATION', 'Photoshop 面板安装目前只支持 macOS 和 Windows')
  }
  if (process.platform === 'darwin') {
    if ((await photoshopPids()).length === 0) await startPhotoshopForJob()
    await openUxpDeveloperTool()
  } else if ((await photoshopPids()).length === 0) {
    await openPhotoshopApp()
  }
  void refreshPhotoshopStatus()
  return board()
}

async function openUxpDeveloperTool(): Promise<void> {
  const candidates = [
    '/Applications/Adobe UXP Developer Tools/Adobe UXP Developer Tools.app',
    '/Applications/Adobe UXP Developer Tool.app'
  ]
  const found = candidates.find(existsSync)
  if (!found) throw new ServiceError('NOT_FOUND', '没有找到 UXP Developer Tools，请检查它是否安装在“应用程序”目录')
  // Do not use `open -g`: the user needs to interact with the tool and load the plugin.
  await execFileAsync('/usr/bin/open', ['-a', found])
}

export async function openPsdUxpDeveloperTool(): Promise<void> {
  if (process.platform !== 'darwin') throw new ServiceError('VALIDATION', 'UXP Developer Tools 入口仅适用于 macOS')
  await openUxpDeveloperTool()
}

/** 启动时只同步插件目录设置，不主动拉起 Photoshop / UXP 开发工具（检测由公共 Photoshop 服务负责） */
export function syncPsdPluginSettings(): void {
  writePluginSettings()
}

export async function openPsdPlugin(): Promise<void> {
  const dir = pluginDirectory()
  if (!existsSync(dir)) throw new ServiceError('NOT_FOUND', '插件目录不存在')
  await openFolder(dir)
}

export async function openPhotoshopApp(): Promise<void> {
  const found = await detectedPhotoshopPath()
  if (!found) throw new ServiceError('NOT_FOUND', '没有找到 Photoshop。请先安装 Photoshop 2024 或更新版本。')
  if ((await photoshopPids()).length > 0) {
    const error = await shell.openPath(found)
    if (error) throw new ServiceError('INTERNAL', `无法切换到 Photoshop：${error}`)
    return
  }
  if (process.platform === 'win32') {
    await openFolder(found)
    return
  }
  await launchPhotoshop(found)
}

export function revealPsdJob(jobId: number): void {
  const current = board()
  const job = current.jobs.find((item) => item.id === jobId)
  if (!job?.outputPath || !existsSync(job.outputPath)) throw new ServiceError('NOT_FOUND', '输出文件不在了')
  shell.showItemInFolder(job.outputPath)
}

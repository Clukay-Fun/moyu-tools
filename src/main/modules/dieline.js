import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '../lib/atomicWrite.js'
import { assertOutputFile, sanitizeFileBaseName } from '../lib/outputPath.js'
import { registerComResult, runComCommand } from './comWorker.js'

// 刀模 AI 导出：渲染层用与 2D / PDF 同源的路径生成 SVG，主进程只做数据校验，
// 再交给受控 Illustrator COM worker 另存为 .ai（与条码 EPS 导出同一条链路）。
// ⚠ 仅 Windows + 已安装 Illustrator 可用。

const MAX_SVG_BYTES = 20 * 1024 * 1024

function normalizeSvg(payload) {
  const data = payload?.data
  if (typeof data !== 'string' || !data.trim().startsWith('<?xml') && !data.trim().startsWith('<svg')) {
    throw new Error('不支持的刀模 SVG 数据')
  }
  if (Buffer.byteLength(data, 'utf8') > MAX_SVG_BYTES) throw new Error('刀模 SVG 超过 20 MB')
  if (!/<svg[\s>]/.test(data) || !/<\/svg>\s*$/.test(data)) throw new Error('刀模 SVG 结构不完整')
  if (/<script[\s>]|<foreignObject[\s>]|xlink:href\s*=\s*"(?!#)/i.test(data)) throw new Error('刀模 SVG 含不允许的内容')
  return data
}

export function registerDielineHandlers({ ipcMain, dialog, BrowserWindow, assertMainWindowSender, app, utilityProcess }) {
  ipcMain.handle('dieline:export-ai', async (event, payload) => {
    assertMainWindowSender(event)
    const svg = normalizeSvg(payload)
    const ownerWindow = BrowserWindow.fromWebContents(event.sender)
    const selection = await dialog.showSaveDialog(ownerWindow, {
      title: '导出 Illustrator 刀模',
      defaultPath: `${sanitizeFileBaseName(payload?.name, 'dieline')}.ai`,
      filters: [{ name: 'Adobe Illustrator', extensions: ['ai'] }]
    })
    if (selection.canceled || !selection.filePath) return { status: 'cancelled' }

    const temporaryDirectory = join(app.getPath('temp'), 'moyu-tools-com')
    await mkdir(temporaryDirectory, { recursive: true })
    const jobId = randomUUID()
    const inputPath = join(temporaryDirectory, `${jobId}.svg`)
    const outputPath = join(temporaryDirectory, `${jobId}.ai`)
    await writeFile(inputPath, svg, 'utf8')
    try {
      // 先落到临时目录再原子写入目标：Illustrator 另存失败时不会留下半截文件
      await runComCommand({ app, utilityProcess }, event, 'dieline-svg-ai', { inputPath, outputPath }, { timeoutMs: 10 * 60 * 1000 })
      await assertOutputFile(outputPath, 'Illustrator 刀模')
      await writeFileAtomic(selection.filePath, await readFile(outputPath))
      await assertOutputFile(selection.filePath, 'Illustrator 刀模')
      return { status: 'saved', result: registerComResult(event.sender.id, selection.filePath) }
    } finally {
      await Promise.all([unlink(inputPath).catch(() => {}), unlink(outputPath).catch(() => {})])
    }
  })
}

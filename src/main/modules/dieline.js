import { randomUUID } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runComCommand } from './comWorker.js'

// 刀模发送到 Illustrator：渲染层用与 2D / PDF 同源的路径生成 SVG，
// 主进程只做数据校验，再交给受控 COM worker 打开（与条码同一条链路）。
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

export function registerDielineHandlers({ ipcMain, assertMainWindowSender, app, utilityProcess }) {
  ipcMain.handle('dieline:send-illustrator', async (event, payload) => {
    assertMainWindowSender(event)
    const svg = normalizeSvg(payload)
    const temporaryDirectory = join(app.getPath('temp'), 'moyu-tools-com')
    await mkdir(temporaryDirectory, { recursive: true })
    const inputPath = join(temporaryDirectory, `${randomUUID()}.svg`)
    await writeFile(inputPath, svg, 'utf8')
    try {
      await runComCommand({ app, utilityProcess }, event, 'illustrator-svg', { inputPath }, { timeoutMs: 10 * 60 * 1000 })
      return { status: 'opened' }
    } finally {
      await unlink(inputPath).catch(() => {})
    }
  })
}

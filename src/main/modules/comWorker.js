import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'

// Office / Adobe（Illustrator、Photoshop）COM 联动的公共基础设施：
// utilityProcess 子进程生命周期、请求-响应/进度转发、结果文件的"在文件夹中显示"会话。
// Illustrator、Office 转 PDF、条码"复制到 Illustrator"等业务模块都通过
// runComCommand / registerComResult 复用同一个 worker 进程与同一份结果会话表。
//
// ⚠ 仅 Windows 支持；worker 子进程本身（resources/com-worker.cjs）依赖
// winax 调用 COM，这条链路本机（macOS）无法运行验证，只能靠代码走查
// 保证从 src/main/index.js 原样搬过来的逻辑没有变化。

const comPendingRequests = new Map()
const comResultSessions = new Map()
let comWorker = null
let comWorkerStderr = ''

function comWorkerPath(app) {
  return app.isPackaged
    ? join(process.resourcesPath, 'workers', 'com-worker.cjs')
    : join(app.getAppPath(), 'resources', 'com-worker.cjs')
}

function winaxModulePath(app) {
  return app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'winax')
    : join(app.getAppPath(), 'node_modules', 'winax')
}

function rejectComRequests(error) {
  for (const pending of comPendingRequests.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  comPendingRequests.clear()
}

function ensureComWorker({ app, utilityProcess }) {
  if (process.platform !== 'win32') {
    throw new Error('Office 与 Adobe 联动仅支持 Windows')
  }
  if (comWorker) return comWorker

  const child = utilityProcess.fork(comWorkerPath(app), [], {
    env: {
      ...process.env,
      MOYU_WINAX_MODULE: winaxModulePath(app)
    },
    stdio: 'pipe',
    serviceName: 'moyu-tools-com'
  })
  comWorker = child
  comWorkerStderr = ''
  child.stderr?.on('data', (chunk) => {
    comWorkerStderr = `${comWorkerStderr}${chunk}`.slice(-4000)
  })
  child.on('message', (message) => {
    const pending = comPendingRequests.get(message?.id)
    if (!pending) return
    if (message.type === 'progress') {
      if (!pending.sender.isDestroyed()) {
        pending.sender.send(pending.progressChannel, {
          completed: message.completed,
          total: message.total,
          name: message.name,
          message: message.message
        })
      }
      return
    }
    if (message.type !== 'result') return
    clearTimeout(pending.timer)
    comPendingRequests.delete(message.id)
    if (message.ok) pending.resolve(message.result)
    else if (message.error === 'TASK_CANCELLED') pending.reject(new Error('TASK_CANCELLED'))
    else pending.reject(new Error(message.error || 'COM 任务执行失败'))
  })
  child.once('exit', (code) => {
    if (comWorker !== child) return
    comWorker = null
    const detail = comWorkerStderr.trim()
    rejectComRequests(new Error(
      `COM 任务进程已退出（${code ?? '未知'}）${detail ? `：${detail}` : ''}`
    ))
  })
  child.once('error', (error) => {
    if (comWorker === child) comWorker = null
    rejectComRequests(error)
  })
  return child
}

export function runComCommand({ app, utilityProcess }, event, command, payload, options = {}) {
  if (comPendingRequests.size) {
    throw new Error('已有 Office 或 Adobe 任务正在执行，请等待当前任务完成')
  }
  const worker = ensureComWorker({ app, utilityProcess })
  const id = options.id || randomUUID()
  const timeoutMs = options.timeoutMs || 3 * 60 * 1000

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!comPendingRequests.delete(id)) return
      reject(new Error('COM 任务执行超时，请关闭软件中的弹窗后重试'))
      if (comWorker === worker) {
        comWorker = null
        worker.kill()
        rejectComRequests(new Error('COM 任务进程已因超时重启，请重试'))
      }
    }, timeoutMs)
    comPendingRequests.set(id, {
      sender: event.sender,
      progressChannel: options.progressChannel || 'com:progress',
      resolve,
      reject,
      timer
    })
    worker.postMessage({
      type: 'request',
      id,
      command,
      payload
    })
  })
}

export function cancelComCommand(id) {
  if (comWorker && comPendingRequests.has(id)) {
    comWorker.postMessage({ type: 'cancel', id })
    return true
  }
  return false
}

/** 应用退出前杀掉残留的 COM worker 子进程，不然会变成孤儿进程。 */
export function terminateComWorker() {
  if (comWorker) {
    comWorker.kill()
    comWorker = null
  }
}

export function registerComResult(ownerId, filePath) {
  const id = randomUUID()
  comResultSessions.set(id, {
    id,
    ownerId,
    path: filePath,
    name: basename(filePath)
  })
  return { id, name: basename(filePath) }
}

export function registerComWorkerHandlers({ ipcMain, shell, app, utilityProcess, assertMainWindowSender }) {
  ipcMain.handle('com:probe', async (event) => {
    assertMainWindowSender(event)
    return runComCommand({ app, utilityProcess }, event, 'probe', {})
  })

  ipcMain.handle('com:show-result', async (event, resultId) => {
    assertMainWindowSender(event)
    const result = comResultSessions.get(resultId)
    if (!result || result.ownerId !== event.sender.id) {
      throw new Error('输出文件会话不存在或无权访问')
    }
    shell.showItemInFolder(result.path)
    return { status: 'shown' }
  })
}

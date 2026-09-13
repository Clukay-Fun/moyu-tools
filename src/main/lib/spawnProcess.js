import { spawn } from 'node:child_process'

/**
 * 通用子进程执行封装：超时兜底、stdout/stderr 环形缓冲、可选取消（task.cancelled）。
 *
 * 不是格式工厂专属——macOS 开发环境下的 ScreenCaptureKit 侧车编译/调用
 * 也复用这同一个封装，属于跟具体业务无关的进程执行基础设施。
 */
export function runFormatProcess(command, args, options = {}) {
  const {
    timeoutMs = 2 * 60 * 60 * 1000,
    task,
    onStderr
  } = options
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    if (task) task.process = child

    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('格式转换任务执行超时'))
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-2 * 1024 * 1024)
    })
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2 * 1024 * 1024)
      onStderr?.(chunk)
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (task) task.process = null
      if (task?.cancelled) {
        reject(new Error('TASK_CANCELLED'))
      } else if (code === 0) {
        resolve({ stdout, stderr })
      } else {
        reject(new Error(stderr.slice(-4000) || `进程退出码 ${code}`))
      }
    })
  })
}

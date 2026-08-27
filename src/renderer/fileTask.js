// 统一文件任务模板（M2）
// 文件列表渲染：PDF / Illustrator / 格式工厂 共用「清空容器 + 切换空态 + 生成行」逻辑。
// 各模块通过 renderRow 回调保留自己的列与状态样式，行为不变。

export function renderFileRows(listBody, emptyEl, items, { renderRow } = {}) {
  listBody.replaceChildren()
  if (emptyEl) {
    // PDF / AI 的空态由 .hidden 类控制，格式工厂由 [hidden] 属性控制，两者都设置以兼容。
    const hasItems = items.length > 0
    emptyEl.classList.toggle('hidden', hasItems)
    emptyEl.hidden = hasItems
  }
  const fragment = document.createDocumentFragment()
  items.forEach((item, index) => {
    const row = renderRow ? renderRow(item, index) : item
    if (row) fragment.append(row)
  })
  listBody.append(fragment)
}

// 统一任务状态机（M2B）
// 各文件任务页（PDF / Illustrator / 格式工厂）共用同一套任务状态语义，
// 不再各自用零散的 Map 记录进度与错误。渲染层从 store 读状态，
// 执行层（含主进程任务）按生命周期回调写入状态。
export const TaskStatus = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
})

export function createTask(id, label = '') {
  return { id, label, status: TaskStatus.PENDING, progress: 0, error: null, result: null }
}

// 统一任务状态机（M2B）：仅负责逐任务状态的存储与流转，
// 不含队列执行 / 并发调度——实际执行在各文件任务页 / 主进程。
export class TaskStore {
  constructor() {
    /** id → task */
    this.tasks = new Map()
    /** 注册顺序，保证渲染顺序稳定 */
    this.order = []
  }

  reset() {
    this.tasks.clear()
    this.order = []
  }

  register(id, label = '') {
    const task = createTask(id, label)
    this.tasks.set(id, task)
    this.order.push(id)
    return task
  }

  get(id) {
    return this.tasks.get(id)
  }

  all() {
    return this.order.map((id) => this.tasks.get(id))
  }

  markRunning(id) {
    const task = this.tasks.get(id)
    if (!task) return
    task.status = TaskStatus.RUNNING
    task.progress = 0
    task.error = null
  }

  markProgress(id, progress) {
    const task = this.tasks.get(id)
    if (!task) return
    task.progress = Math.max(0, Math.min(1, progress))
  }

  markDone(id, result = null) {
    const task = this.tasks.get(id)
    if (!task) return
    task.status = TaskStatus.DONE
    task.progress = 1
    task.result = result
  }

  markFailed(id, error = '') {
    const task = this.tasks.get(id)
    if (!task) return
    task.status = TaskStatus.FAILED
    task.error = error instanceof Error ? error.message : String(error || '')
  }

  markCancelled(id) {
    const task = this.tasks.get(id)
    if (!task) return
    task.status = TaskStatus.CANCELLED
  }
}

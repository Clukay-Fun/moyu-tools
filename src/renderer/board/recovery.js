// @ts-check
// 汇总画布 · 崩溃恢复快照调度（U5 / 规格 7.3）
//
// 纯逻辑：不碰 DOM、不碰 IPC，时钟与写盘都由外部注入，
// 因此可以在 Node 侧用假时钟精确测出 3 秒 / 30 秒的边界行为。
//
// 策略：
//   · 变更停止 3 秒后写一次（debounce）——避免用户每动一下就落盘；
//   · 连续操作最长 30 秒强制写一次（max-wait）——避免长时间拖拽期间
//     debounce 永远不触发，一崩就什么都没留下。
// 两者是「先到者触发」，不是二选一。

export const RECOVERY_DEBOUNCE_MS = 3000
export const RECOVERY_MAX_WAIT_MS = 30000

export class RecoveryScheduler {
  /**
   * @param {object} [deps]
   * @param {() => Promise<unknown>} [deps.write] 实际落盘
   * @param {() => number} [deps.now] 当前毫秒，默认 Date.now
   * @param {(fn: () => void, ms: number) => unknown} [deps.setTimer] 定时器注入，默认 setTimeout
   * @param {(handle: any) => void} [deps.clearTimer] 默认 clearTimeout
   * @param {(error: unknown) => void} [deps.onError] 写盘失败回调；失败不能打断用户操作
   */
  constructor({ write, now, setTimer, clearTimer, onError } = {}) {
    this.write = write || (() => Promise.resolve())
    this.now = now || (() => Date.now())
    this.setTimer = setTimer || ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = clearTimer || ((h) => clearTimeout(h))
    this.onError = onError || (() => {})

    this.timer = null
    /** 本轮连续变更的起点；null 表示当前没有待写的变更 */
    this.firstChangeAt = null
    this.lastChangeAt = null
    /** 是否有一次 write 正在进行 */
    this.writing = false
    /** 在途写盘的 Promise；cancelAndWait() 靠它等待落盘真正结束 */
    this.inFlight = null
    /** 停用：正常保存/关闭后不再排期，避免又生成一份恢复文件 */
    this.stopped = false
    /** 写盘期间又来了变更：写完要再排一次，否则最后那批改动会丢 */
    this.dirtyWhileWriting = false
    this.stats = { scheduled: 0, writes: 0, debounceFires: 0, maxWaitFires: 0, errors: 0 }
  }

  /** 有变更发生。可高频调用。 */
  schedule() {
    if (this.stopped) return
    const at = this.now()
    if (this.firstChangeAt === null) this.firstChangeAt = at
    this.lastChangeAt = at
    this.stats.scheduled += 1
    if (this.writing) {
      this.dirtyWhileWriting = true
      return
    }
    this.#arm()
  }

  /** 按「debounce 与 max-wait 谁先到」重排定时器。 */
  #arm() {
    if (this.timer !== null) this.clearTimer(this.timer)
    const at = this.now()
    // 只在 schedule() 记下变更后才会排期，这两个时间此时都已有值
    const untilDebounce = (this.lastChangeAt ?? at) + RECOVERY_DEBOUNCE_MS - at
    const untilMaxWait = (this.firstChangeAt ?? at) + RECOVERY_MAX_WAIT_MS - at
    const delay = Math.max(0, Math.min(untilDebounce, untilMaxWait))
    this.dueTo = untilMaxWait <= untilDebounce ? 'max-wait' : 'debounce'
    this.timer = this.setTimer(() => this.#fire(), delay)
  }

  async #fire() {
    this.timer = null
    if (this.firstChangeAt === null) return
    if (this.dueTo === 'max-wait') this.stats.maxWaitFires += 1
    else this.stats.debounceFires += 1
    await this.flush()
  }

  /**
   * 立即落盘（保存前、退出前调用）。
   * 无待写变更时是空操作，不会写出多余文件。
   */
  async flush() {
    if (this.firstChangeAt === null) return false
    if (this.writing) { this.dirtyWhileWriting = true; return this.inFlight }

    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null }
    this.firstChangeAt = null
    this.lastChangeAt = null
    this.writing = true
    this.inFlight = (async () => {
      try {
        await this.write()
        this.stats.writes += 1
        return true
      } catch (error) {
        this.stats.errors += 1
        // 恢复快照失败不能打断用户操作，只上报
        this.onError(error)
        return false
      } finally {
        this.writing = false
        this.inFlight = null
        if (this.dirtyWhileWriting) {
          this.dirtyWhileWriting = false
          this.schedule()
        }
      }
    })()
    return this.inFlight
  }

  /** 丢弃待写变更（放弃恢复时用）。不等待在途写盘。 */
  cancel() {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null }
    this.firstChangeAt = null
    this.lastChangeAt = null
    this.dirtyWhileWriting = false
  }

  /**
   * 停止排期并**等待在途写盘结束**。正常保存与关闭走这条。
   *
   * 只 cancel() 是不够的：它只清掉定时器，拦不住已经开始的 write()。
   * 于是「保存 → cancel → 删除恢复文件」之后，那次在途写盘才完成 rename，
   * 又把恢复文件生了出来；下次启动就会提示恢复一个**已经正常保存过**的旧状态。
   *
   * stopped 在等待期间保持为真，确保 finally 里的重新排期也被挡住。
   */
  async cancelAndWait() {
    this.stopped = true
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null }
    this.firstChangeAt = null
    this.lastChangeAt = null
    this.dirtyWhileWriting = false
    // 写盘的 finally 可能又排一次；循环等到真正没有在途任务
    while (this.inFlight) {
      try { await this.inFlight } catch { /* 失败已在内部上报 */ }
    }
    this.firstChangeAt = null
    this.lastChangeAt = null
    this.dirtyWhileWriting = false
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null }
  }

  /** 重新允许排期（保存完成、恢复文件清理干净之后）。 */
  resume() {
    this.stopped = false
  }

  get pending() { return this.firstChangeAt !== null }

  dispose() { this.cancel() }
}

// ── 恢复文件的解析纪律 ───────────────────────────────────────
//
// 与 .moyuboard 同样的原则：任何不自洽都必须抛错，绝不返回半个场景。
// 恢复文件更危险——用户是在崩溃后打开它的，此时最不该再丢一次数据。

export const RECOVERY_MAGIC = 'MOYURECOVER\0'
export const RECOVERY_VERSION = 1

/**
 * 判断一份恢复记录是否可用。
 * @param {any} record IPC 读回的记录，逐项校验
 * @returns {{ ok: boolean, reason?: string }}
 */
export function inspectRecovery(record) {
  if (!record || typeof record !== 'object') return { ok: false, reason: '恢复文件为空' }
  if (record.magic !== RECOVERY_MAGIC) return { ok: false, reason: '不是本程序的恢复文件' }
  if (!Number.isInteger(record.version) || record.version < 1) {
    return { ok: false, reason: '恢复文件版本无法识别' }
  }
  if (record.version > RECOVERY_VERSION) {
    return { ok: false, reason: `恢复文件版本 ${record.version} 高于本程序支持的 ${RECOVERY_VERSION}` }
  }
  if (!(record.board instanceof Uint8Array) || record.board.byteLength === 0) {
    return { ok: false, reason: '恢复文件缺少画布数据' }
  }
  if (record.byteLength !== undefined && record.byteLength !== record.board.byteLength) {
    return { ok: false, reason: '恢复文件已截断' }
  }
  return { ok: true }
}

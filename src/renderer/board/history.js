// @ts-check
// 汇总画布 · 撤销/重做（F-009 S4）
//
// 设计决策 D-2：场景图快照式。
//
// 可行的关键前提：**图片二进制不在场景图里**（只存 assetId），
// 所以每一步快照只有几十 KB，50 步上限的内存完全可控。
// 若哪天有人把 base64 写进场景图，这个模型立刻失效——
// 因此 harness 会断言快照中不含二进制。

import { snapshotScene, validateScene } from './scene.js'

export const HISTORY_LIMIT = 50

export class BoardHistory {
  /**
   * @param {object} initialScene 初始场景，作为第 0 步基线
   */
  constructor(initialScene) {
    /** 已提交的快照栈，末尾是当前状态 */
    this.stack = [snapshotScene(initialScene)]
    /** 指针：stack 中当前状态的下标 */
    this.index = 0
    /** 最近一次 push 的耗时（毫秒），用于观察是否需要改增量 diff */
    this.lastPushMs = 0
  }

  /**
   * 提交一步。
   * 在指针不在末尾时提交（即撤销后又做了新操作），末尾的 redo 分支会被丢弃。
   * @param {Parameters<typeof snapshotScene>[0]} scene
   */
  push(scene) {
    const started = performance.now()
    // 丢弃 redo 分支
    if (this.index < this.stack.length - 1) {
      this.stack.length = this.index + 1
    }
    this.stack.push(snapshotScene(scene))
    // 超过上限丢弃最旧的一步；基线也会被顶掉，这是预期行为
    while (this.stack.length > HISTORY_LIMIT) {
      this.stack.shift()
    }
    this.index = this.stack.length - 1
    this.lastPushMs = performance.now() - started
    return this.index
  }

  canUndo() {
    return this.index > 0
  }

  canRedo() {
    return this.index < this.stack.length - 1
  }

  /** 返回上一步的场景快照；已在最旧一步时返回 null。 */
  undo() {
    if (!this.canUndo()) return null
    this.index -= 1
    return validateScene(snapshotScene(this.stack[this.index]))
  }

  /** 返回下一步的场景快照；已在最新一步时返回 null。 */
  redo() {
    if (!this.canRedo()) return null
    this.index += 1
    return validateScene(snapshotScene(this.stack[this.index]))
  }

  /** 当前状态快照（不移动指针）。 */
  current() {
    return snapshotScene(this.stack[this.index])
  }

  stats() {
    return {
      undo: this.index,
      redo: this.stack.length - 1 - this.index,
      size: this.stack.length,
      limit: HISTORY_LIMIT,
      lastPushMs: Number(this.lastPushMs.toFixed(3))
    }
  }

  /** @param {Parameters<typeof snapshotScene>[0]} scene */
  reset(scene) {
    this.stack = [snapshotScene(scene)]
    this.index = 0
  }
}

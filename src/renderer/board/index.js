// 汇总画布 · UI 控制器（F-009）
//
// 把 scene.js（真值）与 canvas.js（绘制/交互）接到具体的 DOM 控件上。

function mimeFromCanvasName(name) {
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ''
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  return 'application/octet-stream'
}

import {
  createScene,
  AssetStore,
  registerAsset,
  addImageNode,
  addTextBoxNode,
  setNodeStyle,
  setEdgeStyle,
  removeEdge,
  addEdge,
  edgesOfNode,
  isTextNode,
  missingAssets,
  compactAssetStore,
  validateScene,
  removeNodes,
  bringToFront,
  sendToBack,
  bringForward,
  sendBackward,
  sceneBounds,
  snapshotScene,
  unionBounds,
  setNodeLocked,
  isNodeLocked,
  nodeBounds,
  setSceneBackground,
  setSceneGrid,
  setNodeScale
} from './scene.js'
import { BoardCanvas } from './canvas.js'
import { BoardHistory } from './history.js'
import { packBoard, unpackBoard } from './container.js'
import {
  exportBounds, planExport, describePlan, exportFillColor, exportMime, exportFileName, exportFileType
} from './export.js'
import { defaultImageSize, placeNodes, LAYOUT } from './layout.js'
import { BoardOverlay } from './overlay.js'
import {
  createGuide, moveGuide, removeGuide, shouldDropGuide, validateGuides,
  computeSnap, RULER, GRID
} from './guides.js'
import { commitGeometry, restoreGeometry, minimalPanToReveal } from './editor/session.js'

/** 滚轮单事件最大缩放变化。±10% 实测偏快，触控板尤其容易跳级。 */
const WHEEL_STEP = 0.05
/** 鼠标一个标准滚动档的 deltaY（Chromium）。触控板会小很多，按比例换算。 */
const WHEEL_NOTCH = 100

/** 单张图片上限，与主进程截图上限口径一致。 */
const MAX_IMAGE_BYTES = 100 * 1024 * 1024

export class BoardController {
  static ZOOM_MIN = 0.1
  static ZOOM_MAX = 4

  /** @type {Array<object>} */
  #batchPlaced = []

  constructor({ fabric, onStatus }) {
    this.fabric = fabric
    this.onStatus = onStatus || (() => {})
    this.scene = createScene()
    this.store = new AssetStore()
    this.selection = []
    /** 连接模式：等待用户点第二个节点 */
    this.connectFrom = null
    /** 当前选中的连接线 id */
    this.selectedEdge = null
    this.history = new BoardHistory(this.scene)
    /** 视口：缩放与平移 */
    this.zoom = 1
    /** 当前项目文件路径；null 表示尚未保存过 */
    this.filePath = null
    /** 自上次保存以来是否有改动 */
    this.dirty = false
    /**
     * 加入事务期间冻结的可视世界矩形。
     * 规格 3.1：事务中不得因逐张渲染、滚动或异步解码重新取值，
     * 否则同一批图片在不同时序下会落到不同位置。
     */
    this.layoutViewport = null
    // 参考线、网格、背景的真值都在 scene 上（随工程保存）。
    // 控制器不另存一份——两份状态迟早会漂移，而"保存了什么"必须唯一。
    /** 拖动期间的临时对齐线：只是渲染中间量，不进工程 */
    this.alignLines = []
    /** 本事务已放置的节点，参与后续避让 */
    this.#batchPlaced = []
    this.ready = false
  }

  mount(dom) {
    this.dom = dom
    this.canvas = new BoardCanvas('board-canvas-element', {
      fabric: this.fabric,
      onChange: () => this.#afterChange(),
      onSelection: (ids) => {
        this.selection = ids
        if (this.connectFrom && ids.length === 1 && ids[0] !== this.connectFrom) {
          this.#completeConnection(ids[0])
          return
        }
        // 选中节点时，若该节点有边，默认选中第一条以便调样式
        const related = ids.length === 1 ? edgesOfNode(this.scene, ids[0]) : []
        this.selectedEdge = related.length ? related[0].id : null
        this.#syncControls()
        this.#syncObjectToolbar()
      }
    })
    this.canvas.attach(this.scene, this.store)

    // 辅助层：标尺 / 网格 / 参考线 / 对齐线
    this.overlay = new BoardOverlay({
      overlayCanvas: dom.overlay,
      rulerX: dom.rulerX,
      rulerY: dom.rulerY
    })
    this.#bindRulerDrag()
    // 双击图片 → 全屏编辑器。回调由 main.js 注入，控制器不认识模态。
    this.canvas.onImageDoubleClick = (nodeId) => this.#requestEdit(nodeId, 'adjust')
    // 拖动时实时吸附并显示对齐线
    this.canvas.onObjectMoving = (nodeId, bounds) => this.#applySnap(nodeId, bounds)
    this.canvas.onObjectMoved = () => this.clearAlignLines()
    // 对齐线只是拖动期间的视觉提示，任何"拖动结束"的信号都要清掉它：
    // 抬手、变换提交、取消选择、拖动被中断。漏掉任何一条都会留下红虚线。
    this.canvas.onPointerUp = () => this.clearAlignLines()
    this.canvas.onSelectionCleared = () => {
      this.clearAlignLines()
      this.#syncObjectToolbar()
    }
    // 视口一变，工具栏的屏幕位置就变了。缩放、滚轮平移、中键/Space 平移、
    // 适应内容、重置视口全都走这条回调，所以挂在这里一处就够。
    this.canvas.onViewportChanged = () => {
      this.renderOverlay()
      this.#scheduleToolbarSync()
    }
    // 拖动 / 缩放 / 旋转进行中跟随。按帧合并，不写场景、不进历史。
    this.canvas.onObjectTransforming = () => this.#scheduleToolbarSync()
    this.canvas.onWheelZoom = (deltaY, point) => this.zoomByWheel(deltaY, point)
    this.ready = true

    dom.addFile.addEventListener('click', () => dom.fileInput.click())
    dom.fileInput.addEventListener('change', () => this.#onFilesPicked())
    dom.stage.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
      dom.stage.classList.add('drag-over')
    })
    dom.stage.addEventListener('dragleave', (event) => {
      if (!dom.stage.contains(event.relatedTarget)) dom.stage.classList.remove('drag-over')
    })
    dom.stage.addEventListener('drop', (event) => {
      event.preventDefault()
      dom.stage.classList.remove('drag-over')
      void this.importDroppedFiles(event.dataTransfer?.files)
    })
    dom.deleteButton.addEventListener('click', () => this.deleteSelected())
    dom.front.addEventListener('click', () => this.#applyLayer(bringToFront))
    dom.forward.addEventListener('click', () => this.#applyLayer(bringForward))
    dom.backward.addEventListener('click', () => this.#applyLayer(sendBackward))
    dom.back.addEventListener('click', () => this.#applyLayer(sendToBack))
    dom.addText.addEventListener('click', () => this.addText('text'))
    dom.addTextBox.addEventListener('click', () => this.addText('textbox'))
    dom.connect.addEventListener('click', () => this.toggleConnectMode())
    dom.edgeShape.addEventListener('change', () =>
      this.#applyEdgeStyle({ shape: dom.edgeShape.value }))
    dom.edgeArrow.addEventListener('change', () =>
      this.#applyEdgeStyle({ arrow: dom.edgeArrow.value }))
    dom.edgeWidth.addEventListener('change', () =>
      this.#applyEdgeStyle({ strokeWidth: Number(dom.edgeWidth.value) }))
    dom.edgeColor.addEventListener('change', () =>
      this.#applyEdgeStyle({ stroke: dom.edgeColor.value }))
    dom.edgeDelete.addEventListener('click', () => this.deleteSelectedEdge())
    dom.undo.addEventListener('click', () => this.undo())
    dom.redo.addEventListener('click', () => this.redo())
    dom.zoomIn.addEventListener('click', () => this.zoomBy(1.25))
    dom.zoomOut.addEventListener('click', () => this.zoomBy(1 / 1.25))
    dom.zoomFit.addEventListener('click', () => this.fitToContent())
    dom.zoomReset.addEventListener('click', () => this.resetZoom())
    dom.save.addEventListener('click', () => this.save(false))
    dom.saveAs.addEventListener('click', () => this.save(true))
    dom.open.addEventListener('click', () => this.open())

    // ── S5 · 文本框横向工具栏 ──────────────────────────────
    // ⚠ 三条都必须做，缺一条就会出问题：
    //   · stopPropagation：不加的话点击冒到 document，会被"点空白取消选择"
    //     的兜底逻辑清掉选中，工具栏当场消失；
    //   · mousedown 上 preventDefault：不加的话点击会把焦点从画布抢走，
    //     正在行内编辑的 Textbox 触发 blur，用户以为只是改个颜色，
    //     结果编辑态被中断；
    //   · 改样式前先 #exitTextEditing()：行内编辑中直接重建对象会抛
    //     TypeError: reading 'fire'，这个坑 U4 踩过。
    dom.textToolbar?.addEventListener('mousedown', (event) => {
      if (event.target.closest('select, input')) return // 下拉与取色器需要原生焦点
      event.preventDefault()
    })
    dom.textToolbar?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-text]')
      if (!button) return
      event.stopPropagation()
      this.#onTextAction(button.dataset.text)
    })
    /**
     * 文字颜色（F-12）。
     *
     * ⚠ 原生取色器是**系统窗口**，打开时会把焦点从渲染进程夺走。
     * macOS 上尤其明显——色盘是独立窗口，画布随即失焦、选择被清掉，
     * 等用户选完颜色回来，`#selectedTextNodes()` 已经是空的，颜色落空。
     *
     * 所以在打开前**冻结**当前选中的文本节点 id，之后一律按冻结的那份应用。
     * 同时监听 input 与 change：某些平台拖动色盘只发 input，
     * 只听 change 会让"拖着选色"看不到实时效果。
     */
    const freezeFillTarget = () => {
      this.fillTargets = this.#selectedTextNodes().map((n) => n.id)
    }
    dom.textFill?.addEventListener('mousedown', freezeFillTarget)
    dom.textFill?.addEventListener('focus', freezeFillTarget)
    const applyFill = () => {
      // 没有冻结目标时回退到当前选择——不是所有路径都会先经过 mousedown
      const ids = this.fillTargets?.length
        ? this.fillTargets
        : this.#selectedTextNodes().map((n) => n.id)
      this.#applyTextStyleTo(ids, { fill: dom.textFill.value })
    }
    dom.textFill?.addEventListener('input', applyFill)
    dom.textFill?.addEventListener('change', applyFill)

    // ── 缩放比例输入框（S3）──
    dom.textScale?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        // 回车不直接提交，而是 blur——提交逻辑只留一处，回车与失焦走同一条路
        event.preventDefault()
        dom.textScale.blur()
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation() // 别让 Esc 继续上浮去关别的浮层
        this.#revertTextScaleInput()
        dom.textScale.blur()
      }
    })
    dom.textScale?.addEventListener('blur', () => this.#commitTextScaleInput())

    dom.objectToolbar?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-obj]')
      if (!button) return
      event.stopPropagation()
      this.#onObjectAction(button.dataset.obj)
    })
    dom.exportPng?.addEventListener('click', () =>
      this.exportImage({ range: dom.exportRange.value, format: 'png' }))
    dom.exportJpg?.addEventListener('click', () =>
      this.exportImage({ range: dom.exportRange.value, format: 'jpg' }))

    // Delete / Backspace 删除选中，但在文本编辑态下不拦截
    this.keyHandler = (event) => {
      if (!this.isVisible()) return
      // ⚠ 第二道守卫（F-10）：全屏编辑器打开时，画布一律不响应快捷键。
      //   编辑器自己已经在捕获阶段拦截了，这里再挡一次——两层里任何一层
      //   将来被改坏，都不会让"编辑器开着还能删掉底层对象"重新出现。
      if (this.isModalOpen?.()) return
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        event.shiftKey ? this.redo() : this.undo()
        return
      }
      if (mod && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        this.redo()
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!this.selection.length) return
        event.preventDefault()
        this.deleteSelected()
      }
    }
    document.addEventListener('keydown', this.keyHandler)

    this.resizeObserver = new ResizeObserver(() => this.fit())
    this.resizeObserver.observe(dom.stage)
    this.fit()
    // 首次渲染不记历史：空画布是基线本身，记一步会让启动时"撤销"就可用
    this.#afterChange(false)
  }

  /**
   * 画布当前是否真的在屏幕上。
   *
   * ⚠ 不要再用「某个类名在不在」来判断（F-06）：这里原先查的是 `active`，
   * 而 `activateUnifiedCanvas()` 加的类叫 `active-surface`，两者永不相等，
   * 于是它**恒为 false**——受它守卫的 Delete/Backspace 删除与 Ctrl+Z 撤销
   * 从来没生效过，而且因为按键"没反应"不报错，一直没人发现。
   *
   * 改用 `offsetParent`：元素或其任一祖先 `display:none` 时它为 null，
   * 正好就是"模块没显示"。不依赖任何具体类名，改样式也不会再漂移。
   */
  isVisible() {
    const pane = this.dom?.pane
    if (!pane || pane.hidden) return false
    return pane.offsetParent !== null
  }

  fit() {
    if (!this.ready || !this.dom) return
    const rect = this.dom.stage.getBoundingClientRect()
    // 最小化时 stage 是 0×0。这里必须**跳过**——按 0 尺寸 setDimensions
    // 会把画布内容清掉，恢复窗口后是一片空白。
    if (rect.width < 1 || rect.height < 1) return
    this.canvas.resize(Math.round(rect.width), Math.round(rect.height))
    this.renderOverlay()
  }

  /**
   * 窗口从最小化恢复后重新激活画布（F-15）。
   *
   * 最小化期间 stage 是 0×0，`fit()` 会跳过；而 keyup / mouse:up 这些
   * "结束事件"在窗口不可见时也不会到达，交互标志卡在中间态。
   * 结果就是恢复后中键平移失效，得先滚一次滚轮才"活过来"。
   */
  reviveAfterRestore() {
    if (!this.ready || !this.dom) return
    const rect = this.dom.stage.getBoundingClientRect()
    this.canvas.revive(Math.round(rect.width), Math.round(rect.height))
    this.renderOverlay()
    this.#syncObjectToolbar()
  }

  /**
   * 场景变更统一出口。
   * commit=true 时记录一步历史；撤销/重做自身还原场景时传 false，
   * 否则会把还原动作又压进栈里。
   */
  async #afterChange(commit = true) {
    // 合并事务进行中：本次改动不单独入历史，交给事务结束时统一推一条。
    // ⚠ 不能简单丢弃 commit——脏标记与恢复调度仍然要走。
    if (commit && this.mergingHistory) {
      this.dirty = true
      this.#reportDirty()
      this.recovery?.schedule()
      await this.canvas.render()
      this.#syncControls()
      this.#syncStatus()
      this.#syncObjectToolbar()
      this.renderOverlay()
      return
    }
    if (commit) {
      this.history.push(this.scene)
      this.dirty = true
      this.#reportDirty()
      // ⚠ 内容编辑（新增/移动/缩放/旋转/删除/文本）全部走这条路，
      //   恢复快照必须在这里调度。只在 #markDirty() 里调度是不够的——
      //   那只覆盖背景/网格/参考线，崩溃后恢复出来的会是一份没有内容的画布。
      //   commit=false 是撤销/重做自身的还原重绘与打开工程后的首次渲染，
      //   不代表新的用户改动，不能触发。
      this.recovery?.schedule()
    }
    await this.canvas.render()
    this.#syncControls()
    this.#syncStatus()
    this.#syncObjectToolbar()
    this.renderOverlay()
  }

  undo() {
    const scene = this.history.undo()
    if (!scene) return false
    this.#restore(scene)
    return true
  }

  redo() {
    const scene = this.history.redo()
    if (!scene) return false
    this.#restore(scene)
    return true
  }

  #restore(scene) {
    // 逐字段替换而非换引用：canvas 持有的是同一个 scene 对象
    this.scene.version = scene.version
    this.scene.nodes = scene.nodes
    this.scene.edges = scene.edges
    this.scene.assets = scene.assets
    // 二进制留在仓库里（removeNode 不删字节），撤销删除时图片才能回来
    const missing = missingAssets(this.scene, this.store)
    if (missing.length) {
      this.onStatus({ error: `撤销后有 ${missing.length} 个图片资源缺失` })
    }
    this.selection = []
    this.selectedEdge = null
    // commit=false：撤销/重做不能再往历史里压一步。
    // 但它确实改变了内容——脏状态与恢复快照都要跟上，
    // 否则撤销后画布已与已保存文件不同，界面却还显示"已保存"，
    // 且崩溃后恢复到的是撤销**之前**的状态。
    this.#afterChange(false)
    this.dirty = true
    this.#reportDirty()
    this.#syncStatus()
    this.recovery?.schedule()
  }

  // ── 视口缩放与平移 ──────────────────────────────────────
  setZoom(next, center = null) {
    const clamped = Math.min(BoardController.ZOOM_MAX, Math.max(BoardController.ZOOM_MIN, next))
    this.zoom = clamped
    this.canvas.setZoom(clamped, center)
    this.#syncStatus()
    this.#syncObjectToolbar()
    this.renderOverlay()
    return clamped
  }

  /**
   * 滚轮 / 触控板缩放。
   *
   * 鼠标一个标准档在 Chromium 里通常是 |deltaY| = 100，换算成 ±5%；
   * 触控板给的是小而连续的值，按同一比例线性换算，于是"轻轻滑一下"只缩
   * 一点点。ratio 钳在 1 以内，保证**单个事件**最多改变 5%——否则触控板
   * 一次惯性滚动能跳好几级，画面直接失控。
   *
   * 缩放中心是鼠标位置，最小/最大限制沿用 setZoom。
   */
  zoomByWheel(deltaY, center = null) {
    if (!Number.isFinite(deltaY) || deltaY === 0) return this.zoom
    const ratio = Math.min(1, Math.abs(deltaY) / WHEEL_NOTCH)
    const factor = deltaY > 0 ? 1 - WHEEL_STEP * ratio : 1 + WHEEL_STEP * ratio
    return this.setZoom(this.zoom * factor, center)
  }

  zoomBy(factor, center = null) {
    return this.setZoom(this.zoom * factor, center)
  }

  resetZoom() {
    this.canvas.resetViewport()
    return this.setZoom(1)
  }

  /** 适应窗口：把内容包围盒缩放平移到视口内。 */
  fitToContent() {
    const bounds = sceneBounds(this.scene)
    if (bounds.empty) return this.resetZoom()
    const view = this.canvas.viewSize()
    const padding = 40
    const scale = Math.min(
      (view.width - padding * 2) / bounds.width,
      (view.height - padding * 2) / bounds.height
    )
    const clamped = Math.min(BoardController.ZOOM_MAX, Math.max(BoardController.ZOOM_MIN, scale))
    this.zoom = clamped
    this.canvas.setViewport(clamped, {
      x: (view.width - bounds.width * clamped) / 2 - bounds.x * clamped,
      y: (view.height - bounds.height * clamped) / 2 - bounds.y * clamped
    })
    this.#syncStatus()
    return clamped
  }

  /** 当前选中的文本节点（多选时取全部文本节点）。 */
  #selectedTextNodes() {
    return this.selection
      .map((id) => this.scene.nodes.find((n) => n.id === id))
      .filter((node) => isTextNode(node))
  }

  /**
   * 把若干次 #afterChange 合并成**一条**历史（S5）。
   *
   * 场景：文本框正在行内编辑时点了"改颜色"。必须先 exitEditing()——
   * 直接重建正在编辑的 Textbox 会抛 TypeError: reading 'fire'——
   * 而 exitEditing 会触发 text:editing:exited → 写回文本 → 一条历史，
   * 紧接着改样式又是一条。用户只做了一个动作，撤销却要按两次。
   *
   * 这里把中间的推送压掉，末尾统一推一条。
   */
  async #withMergedHistory(fn) {
    if (this.mergingHistory) return fn()
    this.mergingHistory = true
    try {
      await fn()
    } finally {
      this.mergingHistory = false
    }
    await this.#afterChange()
  }

  /** 供 main.js 的应用菜单调用（字体 / 对齐）。菜单不认识场景，样式仍由这里落。 */
  applyTextStyleFromToolbar(patch) { return this.#applyTextStyle(patch) }

  /** 横向工具栏的按钮动作。层级/复制/锁定/删除复用竖栏那套实现，不另写一份。 */
  #onTextAction(action) {
    const ids = this.selection
    if (!ids.length) return
    switch (action) {
      case 'edit': this.#enterTextEditing(ids[0]); return
      case 'bold': {
        const node = this.scene.nodes.find((n) => n.id === ids[0])
        const on = node?.style?.fontWeight === 'bold'
        this.#applyTextStyle({ fontWeight: on ? 'normal' : 'bold' })
        return
      }
      // 其余与竖栏同义，直接转过去——两套实现迟早会漂移
      default: this.#onObjectAction(action)
    }
  }

  /** 缩放比例的合法区间。低于 10% 看不清，高于 1000% 一屏放不下。 */
  static SCALE_MIN = 0.1
  static SCALE_MAX = 10

  /**
   * 解析用户输入的比例。接受 `150`、`150%`、`150％`（全角）；其余视为非法。
   * @returns {number|null} 归一化后的比例；非法返回 null
   */
  #parseScaleInput(raw) {
    const text = String(raw ?? '').trim().replace(/[%％]\s*$/, '').trim()
    if (!text) return null
    const value = Number(text)
    if (!Number.isFinite(value)) return null
    return value / 100
  }

  /** Esc：放弃本次输入，回显场景真值。 */
  #revertTextScaleInput() {
    const node = this.#selectedTextNodes()[0]
    if (!node || !this.dom.textScale) return
    this.dom.textScale.value = `${Math.round((node.scaleX ?? 1) * 100)}%`
  }

  /**
   * 失焦 / 回车时提交输入的比例。
   *
   * 三种情况都要有确定行为：非法输入 → 提示并回退；越界 → 提示并回退；
   * 与当前值相同 → 直接回显、**不写历史**（否则点一下输入框再点走都会
   * 多出一条撤销记录）。
   */
  #commitTextScaleInput() {
    const input = this.dom.textScale
    const node = this.#selectedTextNodes()[0]
    if (!input || !node) return
    const parsed = this.#parseScaleInput(input.value)
    if (parsed === null) {
      this.onStatus({ warn: '缩放比例要填数字，例如 150 或 150%' })
      this.#revertTextScaleInput()
      return
    }
    const min = BoardController.SCALE_MIN
    const max = BoardController.SCALE_MAX
    if (parsed < min || parsed > max) {
      this.onStatus({ warn: `缩放比例需在 ${min * 100}% ～ ${max * 100}% 之间` })
      this.#revertTextScaleInput()
      return
    }
    if (Math.abs(parsed - (node.scaleX ?? 1)) < 1e-6) { this.#revertTextScaleInput(); return }
    this.#applyTextScale(parsed)
  }

  /**
   * 缩放比例（S5）。
   *
   * ⚠ 改的是**对象比例**，不动底层 fontSize：同一个视觉大小如果既能用
   * 字号表示又能用缩放表示，保存 / 重开 / 导出三处迟早对不上。
   */
  #applyTextScale(scale) {
    if (!Number.isFinite(scale) || scale <= 0) return
    const nodes = this.#selectedTextNodes()
    if (!nodes.length) return
    return this.#withMergedHistory(() => {
      this.#exitTextEditing()
      for (const node of nodes) setNodeScale(this.scene, node.id, scale)
      this.#afterChange()
    })
  }

  /** 双击进入行内编辑，与画布上双击文本框等价。 */
  #enterTextEditing(nodeId) {
    const node = this.scene.nodes.find((n) => n.id === nodeId)
    if (!node || !isTextNode(node)) return
    if (isNodeLocked(node)) {
      this.onStatus({ warn: '该文本框已锁定，请先解锁再编辑' })
      return
    }
    this.canvas.beginTextEditing(nodeId)
  }

  /**
   * 让正在行内编辑的文本框**正常退出**编辑态。
   *
   * 直接改样式会触发 render() 重建对象，而重建正在编辑的 Textbox 会抛
   * `TypeError: reading 'fire'`。exitEditing() 走 fabric 自己的收尾路径，
   * 内容与排版尺寸也会顺带写回，所以整个操作仍然只产生一条历史。
   */
  #exitTextEditing() {
    this.canvas.exitTextEditing()
  }

  /**
   * 按**给定 id** 应用文本样式，而不是"当前选中"。
   * 取色器一类会夺走焦点的控件必须走这条路——等它回来时选择可能已经没了。
   */
  #applyTextStyleTo(ids, patch) {
    const targets = (ids || [])
      .map((id) => this.scene.nodes.find((n) => n.id === id))
      .filter((n) => n && isTextNode(n))
    if (!targets.length) return
    return this.#withMergedHistory(() => {
      this.#exitTextEditing()
      for (const node of targets) setNodeStyle(this.scene, node.id, patch)
      this.#afterChange()
    })
  }

  #applyTextStyle(patch) {
    const nodes = this.#selectedTextNodes()
    if (!nodes.length) return
    // 行内编辑中改样式：先正常退出（否则重建对象会抛 TypeError: reading 'fire'），
    // 退出与改样式合并成一条历史——用户只做了一个动作。
    return this.#withMergedHistory(() => {
      this.#exitTextEditing()
      for (const node of nodes) setNodeStyle(this.scene, node.id, patch)
      this.#afterChange()
    })
  }

  toggleConnectMode() {
    if (this.connectFrom) {
      this.connectFrom = null
    } else {
      if (this.selection.length !== 1) return
      this.connectFrom = this.selection[0]
    }
    this.#syncControls()
  }

  #completeConnection(toNodeId) {
    const fromNodeId = this.connectFrom
    this.connectFrom = null
    try {
      // 锚点按两节点相对位置自动选取，用户可事后改形状/箭头
      const from = this.scene.nodes.find((n) => n.id === fromNodeId)
      const to = this.scene.nodes.find((n) => n.id === toNodeId)
      const horizontal = Math.abs((to.x + to.width / 2) - (from.x + from.width / 2))
      const vertical = Math.abs((to.y + to.height / 2) - (from.y + from.height / 2))
      let fromAnchor = 'right'
      let toAnchor = 'left'
      if (vertical > horizontal) {
        fromAnchor = to.y > from.y ? 'bottom' : 'top'
        toAnchor = to.y > from.y ? 'top' : 'bottom'
      } else {
        fromAnchor = to.x > from.x ? 'right' : 'left'
        toAnchor = to.x > from.x ? 'left' : 'right'
      }
      const edge = addEdge(this.scene, { fromNodeId, toNodeId, fromAnchor, toAnchor })
      this.selectedEdge = edge.id
      this.#afterChange()
    } catch (error) {
      this.onStatus({ error: error.message })
      this.#syncControls()
    }
  }

  #applyEdgeStyle(patch) {
    if (!this.selectedEdge) return
    setEdgeStyle(this.scene, this.selectedEdge, patch)
    this.#afterChange()
  }

  deleteSelectedEdge() {
    if (!this.selectedEdge) return
    removeEdge(this.scene, this.selectedEdge)
    this.selectedEdge = null
    this.#afterChange()
  }

  /**
   * 让工具栏跟随选中对象。
   *
   * 位置用**屏幕坐标**算：对象包围盒经视口变换换算到屏幕，
   * 工具栏本身尺寸固定，不随画布缩放（规格 2.1）。
   * 右侧空间不足时翻到左侧；上下钳制在可视区域内。
   */
  /** 重绘辅助层。视口、缩放、参考线、网格变化时调用。 */
  renderOverlay() {
    if (!this.overlay || !this.dom) return
    const rect = this.dom.stage.getBoundingClientRect()
    this.overlay.render({
      viewport: this.canvas.viewportRect(),
      zoom: this.zoom,
      guides: this.guides,
      alignLines: this.alignLines,
      showGrid: this.showGrid,
      stage: { width: rect.width, height: rect.height }
    })
  }

  /** 拖动中计算吸附并回写位移。 */
  #applySnap(nodeId, bounds) {
    const others = this.scene.nodes.filter((n) => n.id !== nodeId)
    const snap = computeSnap({
      movingBounds: bounds,
      others,
      guides: this.guides,
      zoom: this.zoom,
      snapGrid: this.snapGrid
    })
    this.alignLines = snap.lines
    this.renderOverlay()
    return snap
  }

  /** 从标尺拖出参考线；拖回标尺即删除。 */
  #bindRulerDrag() {
    const start = (axis) => (event) => {
      event.preventDefault()
      const rect = this.dom.stage.getBoundingClientRect()
      const viewport = this.canvas.viewportRect()
      const orientation = axis === 'x' ? 'horizontal' : 'vertical'
      const guide = createGuide(orientation, 0)
      this.guides.push(guide)

      const move = (moveEvent) => {
        const screen = axis === 'x'
          ? moveEvent.clientY - rect.top
          : moveEvent.clientX - rect.left
        const world = axis === 'x'
          ? viewport.y + (screen - RULER.sizeY) / this.zoom
          : viewport.x + (screen - RULER.sizeX) / this.zoom
        moveGuide(this.guides, guide.id, world)
        this.renderOverlay()
      }
      const end = (upEvent) => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', end)
        const screen = axis === 'x'
          ? upEvent.clientY - rect.top
          : upEvent.clientX - rect.left
        // 拖回标尺栏内即删除
        if (shouldDropGuide(orientation, screen)) {
          removeGuide(this.guides, guide.id)
        }
        this.renderOverlay()
        this.#markDirty()
      }
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', end)
    }
    this.dom.rulerX?.addEventListener('pointerdown', start('x'))
    this.dom.rulerY?.addEventListener('pointerdown', start('y'))
  }

  /**
   * 标记有未保存改动。
   *
   * 参考线、网格、背景走这里而不进撤销历史：它们是画布设置而非内容编辑，
   * 用户不会指望 Ctrl+Z 把网格关掉。但必须计入脏状态并触发恢复快照。
   */
  #markDirty() {
    this.dirty = true
    this.#reportDirty()
    this.#syncStatus()
    this.recovery?.schedule()
  }

  get guides() { return this.scene.guides }
  get showGrid() { return this.scene.grid.show }
  get snapGrid() { return this.scene.grid.snap }
  get background() { return this.scene.background }

  setShowGrid(value) {
    setSceneGrid(this.scene, { show: Boolean(value) })
    this.renderOverlay()
    this.#markDirty()
  }

  setSnapGrid(value) {
    setSceneGrid(this.scene, { snap: Boolean(value) })
    this.#markDirty()
  }

  /** 背景改变要重画（棋盘格 / 纯色）并计入脏状态。 */
  setBackground(background) {
    setSceneBackground(this.scene, background)
    this.canvas.setBackground(this.scene.background)
    this.#markDirty()
  }

  /**
   * 执行走 IPC 的对象命令（复制 / OCR / 钉住）。
   *
   * 三件事由这里统一保证，避免每个命令各写一遍：
   *   · 在途时忽略重复点击——OCR 要跑好几秒，连点会叠出多份任务；
   *   · 无论成功、失败还是取消，**选择都不变**；
   *   · 期间侧栏按钮置灰，结束后恢复。
   */
  async #runNodeCommand(action, ids) {
    if (!this.onNodeCommand) {
      this.onStatus({ error: `暂不支持的操作：${action}` })
      return false
    }
    if (this.nodeCommandBusy) {
      this.onStatus({ warn: '上一个操作还在进行中' })
      return false
    }
    this.nodeCommandBusy = true
    this.#setNodeCommandBusy(true)
    try {
      await this.onNodeCommand(action, ids)
      return true
    } catch (error) {
      // 失败只提示，不动选择、不动对象——用户应能立刻重试或改用别的操作
      this.onStatus({ error: error instanceof Error ? error.message : String(error) })
      return false
    } finally {
      this.nodeCommandBusy = false
      this.#setNodeCommandBusy(false)
      // 选择在整个过程中保持不变；这里只是把工具栏状态重新同步一次
      this.#syncObjectToolbar()
    }
  }

  #setNodeCommandBusy(busy) {
    const toolbar = this.dom?.objectToolbar
    if (!toolbar) return
    toolbar.setAttribute('aria-busy', String(busy))
    for (const button of toolbar.querySelectorAll('[data-obj]')) {
      if (button.dataset.obj === 'collapse') continue
      button.disabled = busy
    }
  }

  /** 清掉拖动期间的对齐线。多个入口共用，避免各写一份漏掉某条路径。 */
  clearAlignLines() {
    if (!this.alignLines.length) return
    this.alignLines = []
    this.renderOverlay()
  }

  /**
   * 合并高频的工具栏跟随更新（S2）。
   *
   * `object:moving` 在一次拖动里能触发上百次。每次都同步布局会让工具栏
   * 抖得比对象还厉害，所以按帧合并：一帧内来多少次都只算最后一次。
   */
  #scheduleToolbarSync() {
    if (this.toolbarFrame) return
    this.toolbarFrame = requestAnimationFrame(() => {
      this.toolbarFrame = null
      this.#syncObjectToolbar()
    })
  }

  /** 取消待执行的跟随更新。隐藏工具栏时必须调用，否则下一帧又把它摆回来。 */
  #cancelToolbarSync() {
    if (!this.toolbarFrame) return
    cancelAnimationFrame(this.toolbarFrame)
    this.toolbarFrame = null
  }

  /**
   * 切走模块时收起浮动工具栏（S2）。
   *
   * 画布不可见时不该有残留的浮动层，更不该留着一个 rAF 在下一帧
   * 把它摆回来——切回来时会先看到工具栏停在旧位置再跳走。
   */
  hideFloatingToolbars() {
    this.#cancelToolbarSync()
    if (this.dom?.objectToolbar) this.dom.objectToolbar.hidden = true
  }

  /**
   * 文本框横向工具栏的定位与状态（S5）。
   *
   * 位置口径与竖栏完全一致：旋转后外接框（`sceneAabb()`，不含描边），
   * 只是贴在**上方**而不是侧面。放不下时翻到下方，两边都不足时钳制。
   */
  #placeTextToolbar(node) {
    const bar = this.dom.textToolbar
    if (!bar) return
    const view = this.canvas.liveSelectionRect()
      ?? this.canvas.toScreenRect(unionBounds([node]))
    const stage = this.dom.stage.getBoundingClientRect()
    const size = bar.getBoundingClientRect()
    const width = size.width || 420
    const height = size.height || 36
    // 固定**屏幕**间距，不随画布缩放变化——间距是给手指/鼠标留的余量，
    // 它跟画布缩放没关系。10px 刚好躲开控制点（半径 11px 的一半）。
    // F-12：10px 在 Windows 上目视偏挤，提到 14px（最终值按实机观感定）
    const GAP = 14

    // 默认在**下方**：文本框上方通常是正文内容，工具栏压上去挡视线；
    // 下方放不下再翻到上方。
    const belowTop = view.y + view.height + GAP
    const fitsBelow = belowTop + height <= stage.height - GAP
    const top = fitsBelow ? belowTop : Math.max(GAP, view.y - height - GAP)
    bar.classList.toggle('above', !fitsBelow)
    // 与外接框左对齐；左右越界时钳制回可视区
    const left = Math.min(
      Math.max(GAP, view.x),
      Math.max(GAP, stage.width - width - GAP)
    )
    bar.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`

    // 控件取值对齐场景真值，避免显示与实际不符
    const locked = isNodeLocked(node)
    const style = node.style || {}
    const dom = this.dom
    if (dom.textFill) dom.textFill.value = style.fill ?? '#000000'
    this.#syncTextScaleInput(node)
    // 菜单里的勾选态
    for (const item of dom.textFontMenu?.querySelectorAll('[data-font]') || []) {
      item.setAttribute('aria-checked', String(item.dataset.font === style.fontFamily))
    }
    for (const item of dom.textAlignMenu?.querySelectorAll('[data-align]') || []) {
      item.setAttribute('aria-checked', String(item.dataset.align === (style.textAlign ?? 'left')))
    }
    const boldBtn = bar.querySelector('[data-text="bold"]')
    if (boldBtn) boldBtn.setAttribute('aria-pressed', String(style.fontWeight === 'bold'))
    const lockBtn = bar.querySelector('[data-text="lock"]')
    if (lockBtn) {
      lockBtn.setAttribute('aria-pressed', String(locked))
      const label = locked ? '点击解锁' : '锁定后不可移动、缩放、旋转与编辑'
      lockBtn.setAttribute('aria-label', locked ? '解锁' : '锁定')
      lockBtn.dataset.tip = label
      lockBtn.querySelector('use')?.setAttribute('href', locked ? '#ic-lock' : '#ic-unlock')
    }
    // 锁定后只留解锁 / 复制 / 删除可用。禁用而不隐藏——隐藏会让工具栏
    // 宽度突变，用户会以为按钮没了。
    bar.classList.toggle('locked', locked)
    const enabled = new Set(['lock', 'copy', 'delete'])
    for (const button of bar.querySelectorAll('[data-text]')) {
      button.disabled = locked && !enabled.has(button.dataset.text)
    }
    for (const control of bar.querySelectorAll('input, .txt-trigger')) {
      control.disabled = locked
    }
  }

  /**
   * 缩放输入框回显（S3）。
   *
   * ⚠ 用户正在输入时**不覆盖**它的内容——拖控制点会连续触发同步，
   * 每次都写回去的话，用户刚敲的两个字符就被冲掉了。
   */
  #syncTextScaleInput(node) {
    const input = this.dom.textScale
    if (!input) return
    if (document.activeElement === input) return
    input.value = `${Math.round((node.scaleX ?? 1) * 100)}%`
  }

  #syncObjectToolbar() {
    const toolbar = this.dom.objectToolbar
    const textBar = this.dom.textToolbar
    if (!toolbar) return
    const hideAll = () => {
      this.#cancelToolbarSync()
      toolbar.hidden = true
      if (textBar) textBar.hidden = true
    }
    // 不可见时一律收起：模块切换没有专门的事件，这里做兜底。
    if (!this.isVisible()) { hideAll(); return }
    const ids = this.selection
    if (!ids.length) { hideAll(); return }

    const nodes = ids
      .map((id) => this.scene.nodes.find((n) => n.id === id))
      .filter(Boolean)
    if (!nodes.length) { hideAll(); return }

    // 两条工具栏**互斥**：单选文本框走横栏，其余（图片、多选、混合选择）
    // 走竖栏。同时出现会互相遮挡，而且"该点哪个"对用户不明确。
    const textOnly = nodes.length === 1 && isTextNode(nodes[0])
    if (textBar) textBar.hidden = !textOnly
    if (textOnly) { toolbar.hidden = true; this.#placeTextToolbar(nodes[0]); return }

    // 位置口径：优先读 fabric 的**实时**形态。拖动 / 缩放 / 旋转期间场景
    // 还没写回（写回只在 object:modified 发生），读场景会让工具栏慢一整个
    // 手势。两条路径的几何算法同源——liveSelectionRect() 用 sceneAabb()，
    // unionBounds() 用 nodeBounds()，都是旋转后外接框且不含描边。
    const view = this.canvas.liveSelectionRect()
      ?? this.canvas.toScreenRect(unionBounds(nodes))
    const stage = this.dom.stage.getBoundingClientRect()
    const size = toolbar.getBoundingClientRect()
    const width = size.width || 252
    const height = size.height || 46
    const gap = 8

    // 横向工具条跟随对象：默认居中放在对象上方；上方空间不足时放到下方。
    // 两边都不足时再钳制进视口，避免工具条把画布内容遮住一整列。
    const left = Math.min(
      Math.max(gap, view.x + (view.width - width) / 2),
      Math.max(gap, stage.width - width - gap)
    )
    const above = view.y - height - gap
    const below = view.y + view.height + gap
    const top = above >= gap
      ? above
      : Math.min(below, Math.max(gap, stage.height - height - gap))

    toolbar.classList.remove('flipped')
    // ⚠ 只改 transform，不改 left/top：后者每帧都会触发布局，拖动时肉眼可见地抖。
    toolbar.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top)}px, 0)`

    const single = nodes.length === 1
    const locked = nodes.some((n) => isNodeLocked(n))
    const type = single ? nodes[0].type : null
    const isImage = type === 'image'
    const isText = type === 'textbox'

    /**
     * 各按钮的可见性。
     * 图片：编辑 复制 锁定 置顶 置底 删除
     * 文本框：编辑文字 复制 锁定 置顶 置底 删除
     * 多选/混合选择：复制 锁定 置顶 置底 删除（紧凑批量工具栏，S3）
     *
     * ⚠ 裁切 / 恢复原图 / OCR / 钉住**不在这里**——它们统一在全屏编辑器里
     *   （S3+S4）。同一能力两个入口是上一版的教训：两边的可用条件、
     *   繁忙态、错误提示迟早会漂移。
     * 锁定后只留「已锁定」与「删除」——层级也一并收起（锁定即不可改动），
     * 但对象仍保持选中。删除按钮保持可见：藏起来会让"怎么去掉它"无从下手，
     * 点了给出「已锁定，无法删除」的提示反而更可发现（见 F-05）。
     */
    const visible = {
      // 锁定的图片仍可打开（只读：提取文字 / 钉住），所以不再要求 !locked
      edit: single && (isImage || !locked),
      copy: !locked,
      lock: true,
      front: !locked,
      back: !locked,
      delete: true
    }
    for (const button of this.dom.objectToolbar.querySelectorAll('[data-obj]')) {
      const key = button.dataset.obj
      if (key === 'collapse') continue
      button.hidden = !visible[key]
    }

    // 编辑按钮的文案随类型变化，避免"编辑"对文本框含义不清
    const editButton = this.dom.objectToolbar.querySelector('[data-obj="edit"] .obj-label')
    if (editButton) {
      const editLabel = isText ? '编辑文字' : '编辑'
      editButton.textContent = editLabel
      editButton.closest('button')?.setAttribute('aria-label', editLabel)
      editButton.closest('button')?.setAttribute('data-tip', editLabel)
    }

    // 锁定按钮：图标 + 文案 + 高亮三者同时表达状态
    const lockButton = this.dom.objectToolbar.querySelector('[data-obj="lock"]')
    if (lockButton) {
      lockButton.setAttribute('aria-pressed', String(locked))
      lockButton.setAttribute('aria-label', locked ? '解锁' : '锁定')
      lockButton.dataset.tip = locked ? '点击解锁' : '锁定后不可移动、缩放、旋转与编辑'
      const icon = lockButton.querySelector('.obj-ic')
      const label = lockButton.querySelector('.obj-label')
      // ⚠ 切 <use href>，不再写 textContent（V2）。
      //   写字符的做法在 Windows 上会渲染成彩色 emoji，与周围线性图标割裂；
      //   而且 svg 元素的 textContent 赋值会把 <use> 直接冲掉，图标消失。
      const useEl = icon?.querySelector('use')
      if (useEl) useEl.setAttribute('href', locked ? '#ic-lock' : '#ic-unlock')
      if (label) label.textContent = locked ? '已锁定' : '锁定'
    }

    toolbar.hidden = false
  }

  #syncControls() {
    if (!this.dom) return
    const has = this.selection.length > 0
    const single = this.selection.length === 1
    this.dom.deleteButton.disabled = !has
    // 文本样式已整体移到横向浮动工具栏（S5），右侧不再保留第二个入口——
    // 同一能力两处入口，两边的可用条件与取值同步迟早会漂移。

    // 连接按钮：选中恰好一个节点时可用；连接中显示按下态
    this.dom.connect.disabled = !single && !this.connectFrom
    this.dom.connect.setAttribute('aria-pressed', String(Boolean(this.connectFrom)))
    this.dom.connect.textContent = this.connectFrom ? '点击目标…' : '连接'
    this.dom.pane.classList.toggle('board-connecting', Boolean(this.connectFrom))

    const edge = this.selectedEdge
      ? this.scene.edges.find((e) => e.id === this.selectedEdge)
      : null
    this.dom.edgeStyle.hidden = !edge
    if (edge) {
      this.dom.edgeShape.value = edge.style.shape
      this.dom.edgeArrow.value = edge.style.arrow
      this.dom.edgeWidth.value = String(edge.style.strokeWidth)
      this.dom.edgeColor.value = edge.style.stroke
    }
    // 层级操作一次只作用于一个节点，多选时不提供（避免相对顺序歧义）
    for (const button of [this.dom.front, this.dom.forward, this.dom.backward, this.dom.back]) {
      button.disabled = !single
    }
  }

  #syncStatus() {
    if (!this.dom) return
    this.dom.undo.disabled = !this.history.canUndo()
    this.dom.redo.disabled = !this.history.canRedo()
    this.dom.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`
    const count = this.scene.nodes.length
    this.dom.empty.hidden = count > 0
    const bounds = sceneBounds(this.scene)
    this.dom.undo.disabled = !this.history.canUndo()
    this.dom.redo.disabled = !this.history.canRedo()
    this.dom.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`
    const edges = this.scene.edges.length
    const fileLabel = this.filePath
      ? `${this.filePath.split(/[\\/]/).pop()}${this.dirty ? ' *' : ''}`
      : this.dirty ? '未保存 *' : ''
    this.dom.statusText.textContent = count
      ? `${count} 个对象${edges ? ` · ${edges} 条连线` : ''} · 内容范围 ${Math.round(bounds.width)} × ${Math.round(bounds.height)} px${fileLabel ? ` · ${fileLabel}` : ''}`
      : `画布为空${fileLabel ? ` · ${fileLabel}` : ''}`
    this.dom.statusDot.className = `result-dot${count ? ' ok' : ''}`
    this.onStatus({ count })
  }

  #applyLayer(operation) {
    if (this.selection.length !== 1) return
    operation(this.scene, this.selection[0])
    this.#afterChange()
  }

  #onObjectAction(action) {
    const ids = [...this.selection]
    if (!ids.length && action !== 'collapse') return
    const nodes = ids.map((id) => this.scene.nodes.find((n) => n.id === id)).filter(Boolean)
    switch (action) {
      case 'collapse':
        this.dom.objectToolbar.classList.toggle('collapsed')
        return
      case 'lock': {
        const nextLocked = !nodes.some((n) => isNodeLocked(n))
        for (const node of nodes) setNodeLocked(this.scene, node.id, nextLocked)
        this.#afterChange()
        return
      }
      case 'front': this.#applyLayer(bringToFront); return
      case 'back': this.#applyLayer(sendToBack); return
      case 'delete': this.deleteSelected(); return
      case 'edit': this.#requestEdit(ids[0], 'adjust'); return
      default:
        // copy 走主进程 IPC，由 main.js 注入处理器（OCR 已并入编辑器）
        this.#runNodeCommand(action, ids)
    }
  }

  // ── 全屏图片编辑器事务（U4 / 规格 5.2、5.3）───────────────

  /** 双击或工具按钮触发编辑。锁定图片不可编辑，且不静默失败。 */
  #requestEdit(nodeId, tool) {
    const node = this.scene.nodes.find((n) => n.id === nodeId)
    if (!node || node.type !== 'image') return
    // 锁定的图片以**只读**方式进编辑器（S4）：提取文字、钉住不改对象，
    // 被锁定挡在门外没道理；改像素的入口由编辑器自己禁用。
    const readOnly = isNodeLocked(node)
    if (!this.onEditImage) {
      this.onStatus({ error: '图片编辑器未就绪' })
      return
    }
    this.onEditImage({ ...this.getNodeImage(nodeId), readOnly }, tool)
  }

  /** 供编辑器读取源像素与原图可用性。 */
  getNodeImage(nodeId) {
    const node = this.scene.nodes.find((n) => n.id === nodeId)
    if (!node || node.type !== 'image') return null
    return {
      nodeId,
      assetId: node.assetId,
      originalAssetId: node.originalAssetId,
      bytes: this.store.get(node.assetId),
      mime: this.scene.assets[node.assetId]?.mime || 'image/png',
      canRestore: Boolean(node.originalAssetId) && node.originalAssetId !== node.assetId
    }
  }

  /**
   * 单独栅格化一个对象的**当前视觉结果**（含旋转与显示尺寸）。
   * 用于「钉住」：不含控制器、参考线、背景与其他对象（规格 6.1）。
   */
  async renderNodeAlone(nodeId) {
    const node = this.scene.nodes.find((n) => n.id === nodeId)
    if (!node) throw new Error('对象不存在')
    const bounds = nodeBounds(node)
    // 借用导出的栅格化路径，但只放这一个对象——口径与导出完全一致
    const only = { ...this.scene, nodes: [node], edges: [] }
    const saved = this.canvas.scene
    this.canvas.scene = only
    try {
      const image = await this.canvas.renderRegion(bounds, 1, { mime: 'image/png' })
      return image.bytes
    } finally {
      this.canvas.scene = saved
    }
  }

  /** 取该对象最初导入/截取的原图字节，供编辑器的「恢复原图」使用。 */
  getNodeOriginalImage(nodeId) {
    const node = this.scene.nodes.find((n) => n.id === nodeId)
    if (!node || node.type !== 'image' || !node.originalAssetId) return null
    const bytes = this.store.get(node.originalAssetId)
    if (!bytes) return null
    return {
      assetId: node.originalAssetId,
      bytes,
      mime: this.scene.assets[node.originalAssetId]?.mime || 'image/png'
    }
  }

  /**
   * 「完成」：登记新资源 → 换 assetId → 保持中心与显示宽度 → **一条**历史。
   *
   * 全部改动都在 #afterChange() 之前完成，所以无论换了几个字段，
   * 主画布只多出一步可撤销的操作。
   */
  async replaceNodeImage(nodeId, { bytes, mime = 'image/png', size }) {
    const node = this.scene.nodes.find((n) => n.id === nodeId)
    if (!node || node.type !== 'image') throw new Error('目标图片不存在')
    if (isNodeLocked(node)) throw new Error('图片已锁定')

    const assetId = registerAsset(this.scene, this.store, {
      data: bytes, mime, width: size.width, height: size.height
    })
    Object.assign(node, commitGeometry(node, size))
    node.assetId = assetId
    this.#revealNode(node)
    await this.#afterChange()
    return node
  }

  /** 恢复原图：同样保持中心与显示宽度，同样只落一条历史，可撤销可重做。 */
  async restoreNodeOriginal(nodeId) {
    const node = this.scene.nodes.find((n) => n.id === nodeId)
    if (!node || node.type !== 'image') return
    if (isNodeLocked(node)) {
      this.onStatus({ error: '该图片已锁定，请先解锁' })
      return
    }
    const originalId = node.originalAssetId
    if (!originalId || originalId === node.assetId) {
      this.onStatus({ error: '当前已是原图' })
      return
    }
    const asset = this.scene.assets[originalId]
    if (!asset || !this.store.has(originalId)) {
      this.onStatus({ error: '原图数据已不可用' })
      return
    }
    Object.assign(node, restoreGeometry(node, { width: asset.width, height: asset.height }))
    node.assetId = originalId
    this.#revealNode(node)
    await this.#afterChange()
    this.onStatus({ message: '已恢复原图' })
  }

  /** 若编辑后对象完全离开视口，做最小平移让它重新可见（规格 5.2）。 */
  #revealNode(node) {
    const viewport = this.canvas.viewportRect()
    const { dx, dy } = minimalPanToReveal(nodeBounds(node), viewport)
    // pan 收的是屏幕像素，世界位移要乘当前缩放；方向相反（移视口而非移对象）
    if (dx || dy) this.canvas.pan(-dx * this.zoom, -dy * this.zoom)
  }

  deleteSelected() {
    if (!this.selection.length) return
    // ⚠ removeNodes 是顺序 map，遇到锁定节点会中途抛出——混合选中时
    //   前几个已经删掉、异常又逃到控制台，场景被改一半且 #afterChange()
    //   永远执行不到，这一步不进历史，撤销也回不来。
    //   所以前置条件在这里挡：scene.js 的严格抛出保留为不变量兜底。
    const locked = this.selection.filter((id) =>
      isNodeLocked(this.scene.nodes.find((n) => n.id === id)))
    const removable = this.selection.filter((id) => !locked.includes(id))
    if (!removable.length) {
      this.onStatus({ warn: locked.length > 1 ? '选中对象已全部锁定，无法删除' : '该对象已锁定，无法删除' })
      return
    }
    this.clearAlignLines()
    removeNodes(this.scene, removable)
    if (locked.length) this.onStatus({ warn: `已跳过 ${locked.length} 个锁定对象` })
    this.selection = []
    // 删节点会级联删边，被选中的边可能已不存在
    if (this.selectedEdge && !this.scene.edges.some((e) => e.id === this.selectedEdge)) {
      this.selectedEdge = null
    }
    this.#afterChange()
  }

  /** 读取图片字节 → 量出原始尺寸 → 登记资源 → 建节点。 */
  async addImage(bytes, mime = 'image/png') {
    if (!(bytes instanceof Uint8Array)) throw new Error('图片数据无效')
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`单张图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024} MB`)
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
    try {
      const size = await new Promise((resolve, reject) => {
        const probe = new Image()
        probe.addEventListener('load', () =>
          resolve({ width: probe.naturalWidth, height: probe.naturalHeight }))
        probe.addEventListener('error', () => reject(new Error('图片无法解码')))
        probe.src = url
      })
      if (!size.width || !size.height) throw new Error('图片尺寸无效')

      const assetId = registerAsset(this.scene, this.store, {
        data: bytes,
        mime,
        width: size.width,
        height: size.height
      })
      const viewport = this.layoutViewport ?? this.canvas.viewportRect()
      const display = defaultImageSize(size.width, size.height, viewport)
      // 事务内已放的对象也要参与避让
      const existing = [...this.scene.nodes, ...this.#batchPlaced]
      // 本事务的**第一张**落在视口中心附近；同批后续的沿用左上角起排规则，
      // 由 placeNodes 的避让保证不重叠。这样单张截图不会再丢在世界原点，
      // 批量导入也不会挤成一堆。
      const anchor = this.#batchPlaced.length === 0 ? 'center' : 'top-left'
      const [spot] = placeNodes([display], existing, viewport, { anchor })
      const node = addImageNode(this.scene, {
        assetId,
        x: spot.x,
        y: spot.y,
        width: display.width,
        height: display.height
      })
      this.#batchPlaced.push(node)
      await this.#afterChange()
      return node
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  /** 在当前可见画布中央插入文本节点。 */
  addText(kind) {
    // U2：只保留一种文本对象，kind 参数保留仅为兼容旧调用
    const viewport = this.canvas.viewportRect()
    const node = addTextBoxNode(this.scene, {})
    // Fabric.Textbox 本身不会按内容自动收窄；先用同字体的 IText 测量默认文案，
    // 再把测量值作为初始尺寸。后续用户主动拉宽或输入长文本时仍沿用文本框行为。
    const measure = new this.fabric.IText(node.text, {
      fontSize: node.style.fontSize,
      fontFamily: node.style.fontFamily,
      fontWeight: node.style.fontWeight
    })
    node.width = Math.ceil(measure.width || node.width)
    node.height = Math.ceil(measure.height || node.height)
    node.x = viewport.x + (viewport.width - node.width) / 2
    node.y = viewport.y + (viewport.height - node.height) / 2
    this.#afterChange().then(() => {
      this.selection = [node.id]
      this.canvas.selectNodes([node.id])
      this.#syncControls()
    })
    return node
  }

  /** 开始一次加入事务：冻结视口，清空本批记录。 */
  beginAddTransaction() {
    this.layoutViewport = this.canvas.viewportRect()
    this.#batchPlaced = []
  }

  endAddTransaction() {
    this.layoutViewport = null
    this.#batchPlaced = []
  }

  async #onFilesPicked() {
    const files = [...(this.dom.fileInput.files || [])]
    this.dom.fileInput.value = ''
    await this.importFiles(files)
  }

  async importFiles(fileList) {
    const files = [...(fileList || [])]
      .filter((file) => /^image\/(png|jpeg|webp)$/.test(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name))
    if (!files.length) {
      this.onStatus({ error: '请拖入 PNG、JPG 或 WebP 图片' })
      return 0
    }
    this.beginAddTransaction()
    let added = 0
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        await this.addImage(bytes, file.type || 'image/png')
        added += 1
      } catch (error) {
        this.onStatus({ error: `${file.name}：${error.message}` })
      }
    }
    this.endAddTransaction()
    // 导入结束信号：成功数为 0 时同样要通知，调用方据此清理 pending
    this.onStatus({ imported: added })
    return added
  }

  // 文件夹 / 混合拖入：renderer 只提交路径，主进程递归扫描并校验图片，
  // 这里按安全路径取回字节重建 File，再走 importFiles。
  async importDroppedFiles(fileList) {
    const paths = Array.from(fileList || [])
      .map((file) => window.api?.getPathForFile?.(file))
      .filter(Boolean)
    if (!paths.length) return
    if (this.busy) return
    try {
      const result = await window.api.scanDroppedPaths({ paths, region: 'canvas' })
      if (!result.files.length) {
        this.onStatus({ error: '文件夹中未找到匹配的图片' })
        return
      }
      const built = []
      for (const item of result.files) {
        const data = await window.api.readDroppedFile(item.id)
        await this.importFiles([
          new File([data.bytes], data.name, { type: mimeFromCanvasName(data.name) })
        ])
      }
      if (result.skipped || (result.errors && result.errors.length)) {
        this.onStatus({
          error: `已导入图片，跳过 ${result.skipped || 0} 个非图片文件`
        })
      }
    } catch (error) {
      this.onStatus({ error: `拖入失败：${error instanceof Error ? error.message : String(error)}` })
    }
  }

  // ── 项目文件 ────────────────────────────────────────────
  /**
   * 保存。
   *
   * 顺序很重要：**打包 → 写入成功 → 才回收资源并重置历史**。
   * packBoard 只读 scene.assets，未被引用的字节本来就不会进文件，
   * 所以保存前不需要压缩仓库。
   * 若在弹对话框之前就 compact，用户一旦取消保存或写入失败，
   * 已删除图片的二进制就没了，而历史栈还在——之后撤销能恢复节点却恢复不了图片。
   */
  // ── 工程生命周期（U5 / 规格 7.2、7.3）─────────────────────

  /**
   * 丢弃当前改动前的统一确认。新建、打开、退出都走这里，
   * 三处各写一份文案迟早会不一致。
   *
   * 「保存」分支要真的保存成功才放行——保存失败或用户在系统对话框里
   * 取消时必须留在原地，不能顺势把工程切走（规格 7.2）。
   */
  async confirmDiscard(actionLabel = '继续') {
    if (!this.dirty) return true
    const choice = this.onConfirmDiscard
      ? await this.onConfirmDiscard(actionLabel)
      : (window.confirm(`当前画布有未保存的改动，${actionLabel}会丢弃它们。继续？`) ? 'discard' : 'cancel')
    if (choice === 'cancel') return false
    if (choice === 'save') return this.save(false)
    return true
  }

  /** 新建：清空为初始场景。单文档模式，不开第二个窗口或标签页。 */
  async newBoard() {
    if (!(await this.confirmDiscard('新建工程'))) return false
    const fresh = createScene()
    this.store.bytes.clear()
    this.scene.version = fresh.version
    this.scene.nodes = fresh.nodes
    this.scene.edges = fresh.edges
    this.scene.assets = fresh.assets
    this.scene.background = fresh.background
    this.scene.guides = fresh.guides
    this.scene.grid = fresh.grid
    this.canvas.setBackground(this.scene.background)
    this.selection = []
    this.selectedEdge = null
    this.filePath = null
    this.dirty = false
    await this.#resetRecoveryBaseline()
    this.history.reset(this.scene)
    this.#reportDirty()
    await this.#afterChange(false)
    this.resetZoom()
    return true
  }

  /**
   * 正常保存/打开/新建之后重置恢复基线。
   *
   * ⚠ 必须**等在途写盘结束**再删恢复文件。只 cancel() 的话，
   *   已经开始的那次 write 会在 clearRecovery 之后才完成 rename，
   *   把恢复文件又生出来；下次启动就会提示恢复一个已经正常保存过的旧状态。
   */
  async #resetRecoveryBaseline() {
    if (this.recovery) await this.recovery.cancelAndWait()
    try {
      await window.api.clearRecovery?.()
    } catch {
      // 删不掉不影响当前操作；下次启动读到的快照会因内容陈旧被用户放弃
    }
    this.recovery?.resume()
  }

  /**
   * 挂载崩溃恢复。写盘内容与正式工程同为 .moyuboard 字节流，
   * 但落在 userData 下，**不覆盖用户的正式工程**（规格 7.3）。
   */
  attachRecovery(scheduler) {
    this.recovery = scheduler
    return scheduler
  }

  /** 供恢复调度器调用：把当前画布打包成字节。 */
  packForRecovery() {
    return packBoard(this.scene, this.store)
  }

  /**
   * 从恢复数据装载。
   * 装载后保持**未保存**状态：用户崩溃前就没保存过，恢复不该假装已保存。
   */
  async loadRecovered(bytes, projectPath = null) {
    const { scene, assets } = unpackBoard(new Uint8Array(bytes))
    validateScene(scene)
    this.store.bytes.clear()
    for (const [assetId, data] of assets) this.store.put(assetId, data)
    this.scene.version = scene.version
    this.scene.nodes = scene.nodes
    this.scene.edges = scene.edges
    this.scene.assets = scene.assets
    this.scene.background = scene.background
    this.scene.guides = scene.guides
    this.scene.grid = scene.grid
    this.canvas.setBackground(this.scene.background)
    this.selection = []
    this.selectedEdge = null
    this.filePath = projectPath
    this.history.reset(this.scene)
    await this.#afterChange(false)
    this.resetZoom()
    // 恢复出来的内容尚未落到正式工程，仍是脏的
    this.dirty = true
    this.#reportDirty()
    this.#syncStatus()
    return true
  }

  async save(asNew = false) {
    try {
      const bytes = packBoard(this.scene, this.store)
      const result = await window.api.saveBoard({
        data: bytes,
        name: this.#suggestedName(),
        path: this.filePath,
        overwrite: Boolean(this.filePath) && !asNew
      })
      // 取消或未成功：**不动仓库、不动历史**，保持可撤销
      if (result.status !== 'saved') return false

      this.filePath = result.path
      this.dirty = false
      // 正常保存后更新恢复基线：待写的快照作废，已落盘的快照删除（规格 7.3）
      await this.#resetRecoveryBaseline()
      // 确认写入成功后才回收未引用二进制；这会让更早的删除无法再撤销，
      // 因此历史栈同步从当前状态重新开始。
      compactAssetStore(this.scene, this.store)
      this.history.reset(this.scene)
      this.#syncControls()
      this.#syncStatus()
      this.#reportDirty()
      this.onStatus({ saved: result.path, bytes: result.bytes })
      return true
    } catch (error) {
      // 抛错路径同样不得回收资源
      this.onStatus({ error: error instanceof Error ? error.message : '保存失败' })
      return false
    }
  }

  async open() {
    if (!(await this.confirmDiscard('打开其他工程'))) return false
    try {
      const result = await window.api.openBoard()
      if (result.status !== 'opened') return false
      const { scene, assets } = unpackBoard(new Uint8Array(result.data))
      validateScene(scene)
      // 整体替换：先清空仓库再灌入，避免旧文件的资源残留
      this.store.bytes.clear()
      for (const [assetId, bytes] of assets) this.store.put(assetId, bytes)
      this.scene.version = scene.version
      this.scene.nodes = scene.nodes
      this.scene.edges = scene.edges
      this.scene.assets = scene.assets
      // 背景、参考线、网格同属工程内容，漏掉会沿用上一个工程的设置
      this.scene.background = scene.background
      this.scene.guides = scene.guides
      this.scene.grid = scene.grid
      this.canvas.setBackground(this.scene.background)
      this.selection = []
      this.selectedEdge = null
      this.filePath = result.path
      this.dirty = false
      await this.#resetRecoveryBaseline()
      this.history.reset(this.scene)
      this.#reportDirty()
      await this.#afterChange(false)
      this.resetZoom()
      this.onStatus({ opened: result.path })
      return true
    } catch (error) {
      this.onStatus({ error: error instanceof Error ? error.message : '打开失败' })
      return false
    }
  }

  // ── 导出 ────────────────────────────────────────────────

  /**
   * 导出 PNG / JPG（U6 / 规格 8.2）。
   *
   * 两阶段：超限时第一阶段只返回待确认，**不栅格化、不调保存 IPC**。
   * 用户选"取消"就到此为止；选"等比缩小"后才带 confirmedScale 走第二阶段。
   */
  async exportImage({ range = 'content', format = 'png' } = {}) {
    try {
      const bounds = exportBounds(this.scene, range, { selection: this.selection })
      let plan = planExport(bounds)

      if (plan.status === 'needsConfirmation') {
        const accepted = this.onConfirmDownscale
          ? await this.onConfirmDownscale(plan)
          : window.confirm(`${describePlan(plan)}。\n\n等比缩小后导出？取消则不导出。`)
        // 取消：不生成临时文件、不调用保存 IPC
        if (!accepted) {
          this.onStatus({ warn: '已取消导出' })
          return { status: 'cancelled' }
        }
        plan = planExport(bounds, { confirmedScale: plan.suggestedScale })
      }

      const fillColor = exportFillColor(this.scene.background, format)
      const image = await this.canvas.renderRegion(plan.bounds, plan.appliedScale, {
        fillColor,
        mime: exportMime(format)
      })
      const result = await window.api.saveImageFile({
        data: image.bytes,
        name: exportFileName({ projectPath: this.filePath, range }),
        type: exportFileType(format)
      })
      if (result?.status === 'saved') {
        this.onStatus({ saved: result.path, note: describePlan(plan) })
      }
      return { status: result?.status ?? 'cancelled', plan }
    } catch (error) {
      this.onStatus({ error: error instanceof Error ? error.message : '导出失败' })
      return { status: 'error' }
    }
  }

  #suggestedName() {
    if (this.filePath) {
      return this.filePath.split(/[\\/]/).pop().replace(/\.moyuboard$/i, '')
    }
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    return `画布-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  }

  hasUnsavedChanges() {
    return this.dirty
  }

  /**
   * 把未保存状态告知主进程。
   * 关闭确认必须由主进程窗口 close 事件负责——renderer 的 beforeunload 是同步的，
   * 没法在里面等一个对话框，也拦不住"退出应用"这类路径。
   */
  #reportDirty() {
    window.api?.setBoardDirty?.(this.dirty)
  }

  /** 只读场景快照，供状态展示与后续切片（保存/导出）使用。 */
  getSceneSnapshot() {
    return snapshotScene(this.scene)
  }

  /**
   * 只读检视接口。**不提供任何修改状态的方法**——
   * 用于自动化验收与线上排障，不构成对外可编程 API。
   */
  inspector() {
    return Object.freeze({
      getScene: () => this.getSceneSnapshot(),
      getSelection: () => [...this.selection],
      getHistory: () => (this.history ? this.history.stats() : { undo: 0, redo: 0 }),
      getFileState: () => ({ path: this.filePath, dirty: this.dirty }),
      getBackground: () => ({ ...this.background }),
      getGrid: () => ({ show: this.showGrid, snap: this.snapGrid }),
      // 场景坐标 ↔ 屏幕坐标的换算依据。验收要在对象**真实所在的位置**发鼠标
      // 事件，"图应该在画布中间"是个会骗人的假设。
      getViewport: () => ({ ...this.canvas.viewportRect(), zoom: this.zoom }),
      // 浮动工具栏的定位依据。验收要能直接比对"实现算出来的框"与
      // "场景推出来的框"，否则只能靠倒推猜。
      getSelectionScreenRect: () => this.canvas.liveSelectionRect()
    })
  }
}

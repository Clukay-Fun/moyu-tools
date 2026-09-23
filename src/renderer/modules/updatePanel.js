/**
 * 设置页的自动更新面板（GitHub Releases）+ 安装前置检查。
 *
 * @param {object} deps
 * @param {object} deps.state 全局共享状态（读取 state.pdfBusy）
 * @param {(message: string) => void} deps.showToast
 * @param {() => boolean} deps.isIllustratorBusy
 * @param {() => boolean} deps.isFormatFactoryBusy
 * @param {() => boolean} deps.isBarcodeBusy
 * @param {() => boolean} deps.isRegionCaptureBusy
 * @param {() => object|null} deps.getBoardController 取当前画布控制器（可能尚未挂载，返回 null）
 */
export function initUpdatePanel({
  state,
  showToast,
  isIllustratorBusy,
  isFormatFactoryBusy,
  isBarcodeBusy,
  isRegionCaptureBusy,
  getBoardController
}) {
  /**
   * 安装更新前的预检（集中升级计划·第 2 步）。
   *
   * quitAndInstall 会强制退出重启，不走普通的窗口关闭流程——批处理任务
   * 进行到一半被强杀会留下不完整的输出文件，且现有的"部分完成/取消"逻辑
   * 只处理用户主动取消，处理不了进程被杀。画布未保存的改动同理：这里独立于
   * 主进程那份"关闭前确认"（mainWindow.on('close')），因为不能假设
   * electron-updater 内部一定会走 BrowserWindow 的 close 事件。
   */
  async function confirmInstallPreflight() {
    if (state.pdfBusy || isIllustratorBusy() || isFormatFactoryBusy() || isBarcodeBusy() || isRegionCaptureBusy()) {
      showToast('有任务正在处理中，请等待完成后再安装更新')
      return false
    }
    const boardController = getBoardController()
    if (boardController) {
      const fileState = boardController.inspector().getFileState()
      if (fileState.dirty) return boardController.confirmDiscard('安装更新并重启')
    }
    return true
  }

  const el = {
    current: document.querySelector('#update-current'),
    last: document.querySelector('#update-last'),
    autocheck: document.querySelector('#update-autocheck'),
    statusText: document.querySelector('#update-status-text'),
    notes: document.querySelector('#update-notes'),
    primary: document.querySelector('#update-primary'),
    secondary: document.querySelector('#update-secondary'),
    dialog: document.querySelector('#update-available-dialog'),
    dialogTitle: document.querySelector('#update-dialog-title'),
    dialogDescription: document.querySelector('#update-dialog-description'),
    dialogNotes: document.querySelector('#update-dialog-notes'),
    dialogLater: document.querySelector('#update-dialog-later'),
    dialogDownload: document.querySelector('#update-dialog-download')
  }
  if (!el.current) return
  let promptedVersion = null

  const allowedNoteTags = new Set(['H2', 'H3', 'H4', 'P', 'UL', 'OL', 'LI', 'STRONG', 'B', 'EM', 'I', 'CODE', 'PRE', 'BR'])
  const blockedNoteTags = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'IMG'])

  function appendSafeNoteNode(parent, node) {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.append(document.createTextNode(node.textContent || ''))
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE || blockedNoteTags.has(node.tagName)) return
    const child = allowedNoteTags.has(node.tagName)
      ? document.createElement(node.tagName.toLowerCase())
      : document.createDocumentFragment()
    for (const descendant of node.childNodes) appendSafeNoteNode(child, descendant)
    parent.append(child)
  }

  function renderNotes(target, notes) {
    const value = String(notes || '').trim()
    target.replaceChildren()
    target.hidden = !value
    target.classList.remove('is-plain')
    if (!value) return
    const body = new DOMParser().parseFromString(value, 'text/html').body
    if (!body.children.length) {
      target.textContent = value
      target.classList.add('is-plain')
      return
    }
    for (const child of body.childNodes) appendSafeNoteNode(target, child)
  }

  const fmtTime = (ts) => {
    if (!ts) return '—'
    try { return new Date(ts).toLocaleString() } catch { return '—' }
  }

  function statusLabel(s) {
    switch (s.status) {
      case 'checking': return '正在检查更新…'
      case 'available': return `发现新版本 v${s.availableVersion}`
      case 'downloading': return '正在下载更新…'
      case 'downloaded': return `v${s.availableVersion} 已下载，可重启安装`
      case 'up-to-date': return '已是最新版本'
      case 'error': return `更新出错：${s.message || '未知错误'}`
      case 'portable': return '便携版不支持自动更新，请前往 GitHub 手动下载'
      case 'unsupported': return s.message || '当前运行方式不支持自动更新'
      default: return '尚未检查更新'
    }
  }

  function render(s) {
    el.current.textContent = s.currentVersion ? `v${s.currentVersion}` : '—'
    el.last.textContent = fmtTime(s.lastCheckedAt)
    el.autocheck.checked = !!s.autoCheck
    el.statusText.textContent = statusLabel(s)
    renderNotes(el.notes, s.releaseNotes)
    el.secondary.hidden = s.status !== 'downloaded'
    const p = el.primary
    p.disabled = false
    p.hidden = false
    switch (s.status) {
      case 'available': p.textContent = '下载更新'; break
      case 'checking': p.textContent = '检查中…'; p.disabled = true; break
      case 'downloading': p.textContent = '下载中…'; p.disabled = true; break
      case 'downloaded': p.textContent = '立即重启更新'; break
      case 'portable': p.textContent = '前往 GitHub 下载'; break
      // 这种状态下没有任何可执行动作，按钮直接收起，不摆一个点不动的主按钮
      case 'unsupported': p.hidden = true; break
      default: p.textContent = '检查更新'
    }
    if (s.status === 'available' && s.promptOnAvailable && s.availableVersion !== promptedVersion && el.dialog) {
      promptedVersion = s.availableVersion
      el.dialogTitle.textContent = `发现新版本 v${s.availableVersion}`
      el.dialogDescription.textContent = `当前版本 v${s.currentVersion}，可下载新版本并在准备好后安装。`
      renderNotes(el.dialogNotes, s.releaseNotes)
      el.dialog.showModal()
      el.dialogLater.focus()
    }
  }

  async function downloadUpdate() {
    const result = await window.api.update.download()
    if (!result?.ok) showToast(result?.message || '下载更新失败')
  }

  el.primary.addEventListener('click', async () => {
    const s = await window.api.update.getState()
    if (s.status === 'portable') { await window.api.update.openReleases(); return }
    if (s.status === 'downloaded') {
      if (!(await confirmInstallPreflight())) return
      await window.api.update.install()
      return
    }
    if (s.status === 'available') { await downloadUpdate(); return }
    await window.api.update.check()
  })
  el.secondary.addEventListener('click', () => {
    el.secondary.hidden = true
    el.statusText.textContent = '已下载更新，稍后可在设置中重启安装'
  })
  el.autocheck.addEventListener('change', async () => {
    await window.api.update.setAutoCheck(el.autocheck.checked)
  })
  el.dialogLater?.addEventListener('click', () => el.dialog.close())
  el.dialogDownload?.addEventListener('click', () => {
    el.dialog.close()
    void downloadUpdate()
  })

  window.api.update.onState(render)
  window.api.update.getState().then(render).catch(() => {})
}

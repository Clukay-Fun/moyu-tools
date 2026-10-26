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
 * @param {() => void} deps.openUpdateSettings 打开「设置 › 更新与关于」
 *
 * 顶栏胶囊、设置页更新卡、下载完成 toast、「已更新到」对话框都只读主进程推来的同一份状态。
 */
export function initUpdatePanel({
  state,
  showToast,
  isIllustratorBusy,
  isFormatFactoryBusy,
  isBarcodeBusy,
  isRegionCaptureBusy,
  getBoardController,
  openUpdateSettings
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
  const isBusy = () => state.pdfBusy || isIllustratorBusy() || isFormatFactoryBusy() || isBarcodeBusy() || isRegionCaptureBusy()

  async function confirmInstallPreflight() {
    if (isBusy()) {
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
    dialogTag: document.querySelector('#update-dialog-tag'),
    dialogTitle: document.querySelector('#update-dialog-title'),
    dialogDescription: document.querySelector('#update-dialog-description'),
    dialogDateItem: document.querySelector('#update-dialog-date-item'),
    dialogDate: document.querySelector('#update-dialog-date'),
    dialogNotes: document.querySelector('#update-dialog-notes'),
    dialogEmpty: document.querySelector('#update-dialog-empty'),
    dialogSkip: document.querySelector('#update-dialog-skip'),
    dialogClose: document.querySelector('#update-dialog-close'),
    dialogLater: document.querySelector('#update-dialog-later'),
    dialogManual: document.querySelector('#update-dialog-manual'),
    dialogDownload: document.querySelector('#update-dialog-download'),
    hint: document.querySelector('#update-hint'),
    progress: document.querySelector('#update-progress'),
    progressBar: document.querySelector('#update-progress-bar'),
    progressFill: document.querySelector('#update-progress-fill'),
    progressPercent: document.querySelector('#update-progress-percent'),
    progressSize: document.querySelector('#update-progress-size'),
    errorDetail: document.querySelector('#update-error-detail'),
    errorText: document.querySelector('#update-error-text'),
    pill: document.querySelector('#update-pill'),
    pillText: document.querySelector('#update-pill-text'),
    pillIcon: document.querySelector('#update-pill use'),
    toast: document.querySelector('#update-toast'),
    toastText: document.querySelector('#update-toast-text'),
    toastLater: document.querySelector('#update-toast-later'),
    toastView: document.querySelector('#update-toast-view'),
    toastClose: document.querySelector('#update-toast-close'),
    doneDialog: document.querySelector('#update-done-dialog'),
    doneTitle: document.querySelector('#update-done-title'),
    doneNotes: document.querySelector('#update-done-notes'),
    doneNotesToggle: document.querySelector('#update-done-notes-toggle'),
    doneOk: document.querySelector('#update-done-ok')
  }
  if (!el.current) return
  // 已弹过的 promptId：主进程每决定弹一次就加 1
  let promptedId = 0
  let promptTimer = 0
  /** 弹窗正在展示的版本：关掉时据此记「本版本不再提示」 */
  let dialogVersion = null
  let doneShown = false
  let toastTimer = 0
  const TOAST_MS = 7000
  const BUSY_RETRY_MS = 3000

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
    // 发布说明开头常是「更新内容」标题，对话框自己已经有标题了，去掉重复的这一行
    const first = body.firstElementChild
    if (first && /^H[2-4]$/.test(first.tagName) && /^(更新内容|更新日志)$/.test((first.textContent || '').trim())) first.remove()
    for (const child of body.childNodes) appendSafeNoteNode(target, child)
    if (!target.textContent?.trim()) target.hidden = true
  }

  /** 发布时间按界面日期格式显示；拿不到或解析不了就返回空，整项隐藏 */
  const fmtDate = (iso) => {
    const date = iso ? new Date(iso) : null
    if (!date || Number.isNaN(date.getTime())) return ''
    const pad = (n) => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }

  const fmtTime = (ts) => {
    if (!ts) return '—'
    try { return new Date(ts).toLocaleString() } catch { return '—' }
  }

  const MB = 1024 * 1024
  const fmtMb = (bytes) => `${(bytes / MB).toFixed(1)} MB`

  function statusLabel(s) {
    switch (s.status) {
      case 'checking': return '正在检查更新…'
      case 'available': return `发现新版本 v${s.availableVersion}`
      case 'downloading': return `正在下载 v${s.availableVersion}…`
      case 'downloaded': return `v${s.availableVersion} 已下载完成`
      case 'installing': return `正在启动安装 v${s.availableVersion}…`
      case 'up-to-date': return '已是最新版本'
      case 'error': return s.errorStage === 'download' ? `更新下载失败：${s.message || '未知错误'}` : `更新出错：${s.message || '未知错误'}`
      case 'portable': return '便携版不支持自动更新，请前往 GitHub 手动下载'
      case 'unsupported': return s.message || '当前运行方式不支持自动更新'
      default: return '尚未检查更新'
    }
  }

  /** 顶栏胶囊：只在发现更新 / 下载中 / 已下载 / 失败 / 安装中出现 */
  function renderPill(s) {
    if (!el.pill) return
    const view = {
      available: ['download', '发现更新'],
      downloading: ['download', s.progress?.total ? `更新 ${s.progress.percent}%` : '更新下载中'],
      downloaded: ['update', '重启更新'],
      error: ['warning', '更新失败'],
      installing: ['update', '正在安装…']
    }[s.status]
    // 检查阶段的失败（启动时自动检查没连上）不打扰，只在设置页里看得到
    const show = Boolean(view) && !(s.status === 'error' && s.errorStage === 'check')
    el.pill.hidden = !show
    if (!show) return
    el.pill.dataset.state = s.status
    el.pill.disabled = s.status === 'installing'
    el.pillIcon.setAttribute('href', `#ic-${view[0]}`)
    el.pillText.textContent = view[1]
    el.pill.setAttribute('aria-label', `${view[1]}，查看更新详情`)
  }

  function renderProgress(s) {
    const downloading = s.status === 'downloading'
    el.progress.hidden = !downloading
    if (!downloading) return
    const { percent = 0, transferred = 0, total = 0, bytesPerSecond = 0 } = s.progress || {}
    const known = total > 0
    el.progressPercent.textContent = known ? `${percent}%` : '下载中'
    el.progressFill.style.width = known ? `${percent}%` : '0'
    if (known) el.progressBar.setAttribute('aria-valuenow', String(percent))
    else el.progressBar.removeAttribute('aria-valuenow')
    const size = known ? `${fmtMb(transferred)} / ${fmtMb(total)}` : `已下载 ${fmtMb(transferred)}`
    el.progressSize.textContent = bytesPerSecond > 0 ? `${size} · ${fmtMb(bytesPerSecond)}/s` : size
  }

  function hintFor(s) {
    if (s.status === 'downloading') return '可以继续使用软件，下载在后台进行。'
    if (s.status === 'downloaded') return '更新已准备就绪，可以选择重启安装。选择稍后安装不会在正常退出时自动安装。'
    if (s.status === 'installing') return '软件即将退出并安装新版本，完成后会自动重新打开。'
    return ''
  }

  function render(s) {
    document.querySelector('#update-status').dataset.status = s.status
    const statusIcon = s.status === 'up-to-date' ? 'check' : s.status === 'error' ? 'warning' : 'info'
    document.querySelector('#update-status > .ic use').setAttribute('href', `#ic-${statusIcon}`)
    el.current.textContent = s.currentVersion ? `v${s.currentVersion}` : '—'
    el.last.textContent = fmtTime(s.lastCheckedAt)
    el.autocheck.checked = !!s.autoCheck
    el.statusText.textContent = statusLabel(s)
    const hint = hintFor(s)
    el.hint.hidden = !hint
    el.hint.textContent = hint
    renderProgress(s)
    el.errorDetail.hidden = !(s.status === 'error' && s.errorDetail)
    el.errorText.textContent = s.errorDetail || ''
    renderNotes(el.notes, s.releaseNotes)
    renderPill(s)
    if (s.status !== 'downloaded') hideToast()
    el.secondary.hidden = s.status !== 'downloaded'
    const p = el.primary
    p.disabled = false
    p.hidden = false
    // 有明确下一步（下载 / 安装 / 重试）时用主按钮样式
    p.classList.toggle('m-btn--primary', ['available', 'downloaded', 'error'].includes(s.status))
    switch (s.status) {
      case 'available': p.textContent = '下载更新'; break
      case 'checking': p.textContent = '检查中…'; p.disabled = true; break
      case 'downloading': p.textContent = '下载中…'; p.disabled = true; break
      case 'downloaded': p.textContent = '立即重启安装'; break
      case 'installing': p.textContent = '正在安装…'; p.disabled = true; break
      case 'error': p.textContent = s.errorStage === 'download' && s.availableVersion ? '重试下载' : '重新检查'; break
      case 'portable': p.textContent = '前往 GitHub 下载'; break
      // 这种状态下没有任何可执行动作，按钮直接收起，不摆一个点不动的主按钮
      case 'unsupported': p.hidden = true; break
      default: p.textContent = '检查更新'
    }
    if (s.status !== 'available') {
      window.clearTimeout(promptTimer)
      if (el.dialog?.open) el.dialog.close()
    } else if (s.promptId > promptedId) {
      schedulePrompt(s)
    }
    if (s.justUpdated && !doneShown && el.doneDialog) showJustUpdated(s.justUpdated)
  }

  /** 有文件任务在跑时先不弹，只留顶栏「发现更新」，空下来再弹 */
  function schedulePrompt(s) {
    window.clearTimeout(promptTimer)
    if (!el.dialog || el.dialog.open) return
    if (isBusy() || document.querySelector('dialog[open]')) {
      promptTimer = window.setTimeout(() => {
        window.api.update.getState().then((next) => { if (next.status === 'available' && next.promptId > promptedId) schedulePrompt(next) }).catch(() => {})
      }, BUSY_RETRY_MS)
      return
    }
    promptedId = s.promptId
    showPrompt(s)
  }

  function showPrompt(s) {
    dialogVersion = s.availableVersion
    el.dialogTag.textContent = `v${s.availableVersion}`
    el.dialogTitle.textContent = `发现新版本 ${s.availableVersion}`
    el.dialogDescription.textContent = `当前版本 v${s.currentVersion}，可下载最新版本。`
    const date = fmtDate(s.releaseDate)
    el.dialogDateItem.hidden = !date
    el.dialogDate.textContent = date
    renderNotes(el.dialogNotes, s.releaseNotes)
    el.dialogEmpty.hidden = !el.dialogNotes.hidden
    el.dialogSkip.checked = false
    el.dialog.showModal()
    el.dialogLater.focus()
  }

  /** 重启后确认已经是新版本：只提示一次，关掉就告诉主进程记下 */
  function showJustUpdated({ version, notes }) {
    doneShown = true
    el.doneTitle.textContent = `摸鱼工具箱已更新至 v${version}`
    // 更新内容默认展开；没有内容时整块和按钮都不出现
    renderNotes(el.doneNotes, notes)
    el.doneNotesToggle.hidden = el.doneNotes.hidden
    el.doneNotesToggle.textContent = '收起更新内容'
    el.doneNotesToggle.setAttribute('aria-expanded', 'true')
    el.doneDialog.showModal()
    el.doneOk.focus()
  }

  function hideToast() {
    window.clearTimeout(toastTimer)
    if (el.toast) el.toast.hidden = true
  }

  function showDownloadedToast({ version }) {
    if (!el.toast) return
    el.toastText.textContent = `v${version} 已准备就绪，可选择重启安装。`
    el.toast.hidden = false
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(hideToast, TOAST_MS)
  }

  async function downloadUpdate() {
    const result = await window.api.update.download()
    if (!result?.ok) showToast(result?.message || '下载更新失败')
  }

  el.primary.addEventListener('click', async () => {
    const s = await window.api.update.getState()
    if (s.status === 'portable') { await window.api.update.openReleases(); return }
    if (s.status === 'downloaded') {
      // 有任务或未保存改动时停在「已下载」，用户处理完再点
      if (!(await confirmInstallPreflight())) return
      const result = await window.api.update.install()
      if (!result?.ok) showToast(result?.message || '无法开始安装')
      return
    }
    if (s.status === 'available' || (s.status === 'error' && s.errorStage === 'download' && s.availableVersion)) {
      await downloadUpdate()
      return
    }
    const result = await window.api.update.check()
    if (result && !result.ok && result.message && s.status !== 'unsupported') showToast(result.message)
  })
  // 稍后安装：什么都不装，只是收起提醒；顶栏「重启更新」和这里的按钮都还在
  el.secondary.addEventListener('click', () => {
    hideToast()
    showToast('已保留更新，可随时点顶栏「重启更新」安装；正常退出不会自动安装')
  })
  el.pill?.addEventListener('click', () => openUpdateSettings())
  el.toastLater?.addEventListener('click', hideToast)
  el.toastClose?.addEventListener('click', hideToast)
  el.toastView?.addEventListener('click', () => {
    hideToast()
    openUpdateSettings()
  })
  el.doneNotesToggle?.addEventListener('click', () => {
    el.doneNotes.hidden = !el.doneNotes.hidden
    el.doneNotesToggle.textContent = el.doneNotes.hidden ? '查看更新内容' : '收起更新内容'
    el.doneNotesToggle.setAttribute('aria-expanded', String(!el.doneNotes.hidden))
  })
  el.doneOk?.addEventListener('click', () => el.doneDialog.close())
  el.doneDialog?.addEventListener('close', () => { void window.api.update.dismissJustUpdated() })
  el.autocheck.addEventListener('change', async () => {
    await window.api.update.setAutoCheck(el.autocheck.checked)
  })
  // X、稍后、Esc 都是「先不下载」；勾了「本版本不再提示」才记下跳过。点「下载更新」不算跳过
  el.dialogClose?.addEventListener('click', () => el.dialog.close('later'))
  el.dialogLater?.addEventListener('click', () => el.dialog.close('later'))
  el.dialogManual?.addEventListener('click', () => { void window.api.update.openReleases() })
  el.dialogDownload?.addEventListener('click', () => {
    el.dialog.close('download')
    void downloadUpdate()
  })
  el.dialog?.addEventListener('close', () => {
    if (el.dialog.returnValue !== 'download' && el.dialogSkip.checked && dialogVersion) void window.api.update.skipVersion(dialogVersion)
    el.dialog.returnValue = ''
  })

  window.api.update.onState(render)
  window.api.update.onDownloadedToast(showDownloadedToast)
  window.api.update.onOpenSettings(() => openUpdateSettings())
  window.api.update.getState().then(render).catch(() => {})
}

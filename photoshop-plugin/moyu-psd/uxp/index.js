const { entrypoints } = require('uxp')
const { app, action, core, constants } = require('photoshop')
const fs = require('uxp').storage.localFileSystem
const formats = require('uxp').storage.formats
const { fitToBounds } = require('./fit.js')

const TOKEN_KEY = 'moyu.bridgeToken'
const OUTPUT_TOKENS_KEY = 'moyu.outputTokens'
const POLL_INTERVAL_MS = 1000
const HEARTBEAT_FILE = 'uxp-plugin-heartbeat.json'
const HEARTBEAT_INTERVAL_MS = 3000
const SAVE_OPTIONS = {
  alphaChannels: true,
  annotations: true,
  embedColorProfile: true,
  layers: true,
  spotColor: true,
  maximizeCompatibility: true
}

const lines = ['首次使用请授权 psd-bridge。之后生成任务会自动执行；“执行队列”仅用于手动补跑。']
let workerTimer = null
let panelRoot = null
let queueRunning = false
let heartbeatTimer = null
let heartbeatRunning = false
const boundClicks = new WeakSet()

function element(id) {
  if (panelRoot && typeof panelRoot.querySelector === 'function') {
    const found = panelRoot.querySelector('#' + id)
    if (found) return found
  }
  if (typeof document !== 'undefined' && document.getElementById) return document.getElementById(id)
  return null
}

function renderLog() {
  const el = element('log')
  if (el) el.textContent = lines.join('\n')
}

function log(line) {
  lines.push(line)
  if (lines.length > 80) lines.shift()
  renderLog()
}

entrypoints.setup({
  plugin: {
    create() {
      startWorker()
    },
    destroy() {
      stopWorker()
      unmountPanel()
    }
  },
  panels: {
    moyuPsd: {
      create(rootNode) {
        mountPanel(rootNode)
      },
      destroy() {
        unmountPanel()
      },
      show(rootNode) {
        mountPanel(rootNode)
      },
      hide() {}
    }
  },
  commands: {
    moyuRunQueue() {
      startWorker()
      runQueue({ silent: false })
    }
  }
})

function errorText(err) {
  if (!err) return '未知错误'
  if (typeof err === 'string') return err
  return err.message ? String(err.message) : String(err)
}

function num(value) {
  if (typeof value === 'number') return value
  if (value && typeof value._value === 'number') return value._value
  return Number(value)
}

function boundsOf(layer) {
  // `boundsNoEffects` can keep returning the smart-object mask bounds after
  // placedLayerReplaceContents. Use the actual layer bounds so the replacement
  // image is scaled back into the target rectangle.
  const bounds = layer.bounds
  return {
    left: num(bounds.left),
    top: num(bounds.top),
    right: num(bounds.right),
    bottom: num(bounds.bottom)
  }
}

function isSmartObject(layer) {
  const kind = layer.kind
  return kind === 'smartObject' || kind === constants.LayerKind.SMARTOBJECT
}

function isLocked(layer) {
  return layer.locked === true || layer.allLocked === true
}

function sameFile(doc, entry) {
  if (doc.name !== entry.name) return false
  const docPath = doc.path ? String(doc.path) : ''
  const entryPath = entry.nativePath ? String(entry.nativePath) : ''
  if (!docPath || !entryPath) return true
  const norm = (value) =>
    decodeURIComponent(value.replace(/^file:\/\//, ''))
      .replace(/\\/g, '/')
      .toLowerCase()
  return norm(docPath) === norm(entryPath)
}

function findLayer(container, name) {
  const layers = container.layers
  if (!layers) return null
  for (const layer of layers) {
    if (layer.name === name) return layer
    const nested = findLayer(layer, name)
    if (nested) return nested
  }
  return null
}

async function child(folder, name) {
  if (!folder) return null
  const entries = await folder.getEntries()
  return entries.find((entry) => entry.name === name) || null
}

async function ensureFolder(parent, name) {
  const found = await child(parent, name)
  if (found && found.isFolder) return found
  return parent.createFolder(name)
}

async function readText(file) {
  const data = await file.read({ format: formats.utf8 })
  return typeof data === 'string' ? data : new TextDecoder().decode(data)
}

async function park(file, folderName, job, bridge) {
  const folder = await ensureFolder(bridge, folderName)
  await file.write(JSON.stringify(job, null, 2), { format: formats.utf8 })
  const clash = await child(folder, file.name)
  if (clash) await clash.delete()
  await file.moveTo(folder)
}

async function batch(descriptors) {
  const results = await action.batchPlay(descriptors, { synchronousExecution: true, modalBehavior: 'execute' })
  for (let index = 0; index < results.length; index++) {
    const result = results[index]
    if (result?._obj === 'error' || (typeof result?.result === 'number' && result.result < 0)) {
      const command = descriptors[index]?._obj || 'unknown'
      const detail = result.message ? `：${result.message}` : ''
      throw new Error(`Photoshop 命令 ${command} 失败 (${result.result})${detail}`)
    }
  }
  return results
}

async function selectLayer(layer) {
  await batch([
    {
      _obj: 'select',
      _target: [{ _ref: 'layer', _id: layer.id }],
      makeVisible: false,
      _options: { dialogOptions: 'dontDisplay' }
    }
  ])
}

async function replaceContents(fileEntry) {
  const token = await fs.createSessionToken(fileEntry)
  await batch([
    {
      _obj: 'placedLayerReplaceContents',
      null: { _path: token, _kind: 'local' },
      _options: { dialogOptions: 'dontDisplay' }
    }
  ])
}

async function ensureOutput(outputs, name) {
  const found = await child(outputs, name)
  if (found) return found
  return outputs.createFile(name)
}

function normalizeNativePath(value) {
  let normalized = String(value || '')
    .replace(/\\/g, '/')
    .replace(/\/$/, '')
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')) normalized = normalized.toLowerCase()
  return normalized
}

function isAbsoluteNativePath(value) {
  return (
    typeof value === 'string' && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'))
  )
}

async function outputFolderFor(bridge, nativePath) {
  if (!nativePath) return ensureFolder(bridge, 'outputs')
  let tokens
  try {
    tokens = JSON.parse(localStorage.getItem(OUTPUT_TOKENS_KEY) || '{}')
  } catch {
    // Invalid saved token data is treated as an empty authorization list.
  }
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) tokens = {}
  const key = normalizeNativePath(nativePath)
  if (tokens[key]) {
    try {
      const saved = await fs.getEntryForPersistentToken(tokens[key])
      if (saved.isFolder && normalizeNativePath(saved.nativePath) === key) return saved
    } catch {
      /* folder was moved, removed or its permission expired */
    }
    delete tokens[key]
  }
  const folder = await fs.getFolder()
  if (!folder) throw new Error('已取消选择导出目录')
  if (normalizeNativePath(folder.nativePath) !== key) {
    throw new Error(`请选择应用设置的导出目录：${nativePath}`)
  }
  tokens[key] = await fs.createPersistentToken(folder)
  localStorage.setItem(OUTPUT_TOKENS_KEY, JSON.stringify(tokens))
  return folder
}

async function replaceOne(doc, staging, item) {
  const layer = findLayer(doc, item.layerName)
  if (!layer) throw new Error(`图层不存在: ${item.layerName}`)
  if (isLocked(layer)) throw new Error(`图层已锁定: ${item.layerName}`)
  if (!isSmartObject(layer)) throw new Error(`图层不是智能对象: ${item.layerName}`)
  const image = await child(staging, item.file)
  if (!image || !image.isFile) throw new Error(`素材文件不存在: ${item.file}`)
  // Template 2 keeps its empty lower-row targets hidden until the first asset
  // is assigned. Reveal before reading bounds so Photoshop reports the full
  // transformed smart-object rectangle consistently.
  layer.visible = true
  const before = boundsOf(layer)
  await selectLayer(layer)
  await replaceContents(image)
  const current = findLayer(doc, item.layerName)
  if (!current) throw new Error(`图层不存在: ${item.layerName}`)
  current.visible = true
  const afterReplace = boundsOf(current)
  const fit = fitToBounds(before, afterReplace)
  if (Math.abs(fit.scale - 1) > 0.001) {
    // Use Photoshop's Layer DOM transform methods instead of a hand-built
    // Action Manager transform descriptor.
    await current.scale(fit.scale * 100, fit.scale * 100, constants.AnchorPosition.MIDDLECENTER)
  }
  if (Math.abs(fit.dx) > 0.5 || Math.abs(fit.dy) > 0.5) await current.translate(fit.dx, fit.dy)

  const fittedLayer = findLayer(doc, item.layerName)
  if (!fittedLayer) throw new Error(`图层不存在: ${item.layerName}`)
  const fitted = boundsOf(fittedLayer)
  const tolerance = 2
  const targetCenterX = (before.left + before.right) / 2
  const targetCenterY = (before.top + before.bottom) / 2
  const fittedCenterX = (fitted.left + fitted.right) / 2
  const fittedCenterY = (fitted.top + fitted.bottom) / 2
  if (
    fitted.left < before.left - tolerance ||
    fitted.top < before.top - tolerance ||
    fitted.right > before.right + tolerance ||
    fitted.bottom > before.bottom + tolerance ||
    Math.abs(fittedCenterX - targetCenterX) > tolerance ||
    Math.abs(fittedCenterY - targetCenterY) > tolerance
  ) {
    throw new Error(
      `${item.layerName} 变换未落入模板范围：目标 ${Math.round(before.left)},${Math.round(before.top)},${Math.round(before.right)},${Math.round(before.bottom)}；结果 ${Math.round(fitted.left)},${Math.round(fitted.top)},${Math.round(fitted.right)},${Math.round(fitted.bottom)}`
    )
  }
}

function slotPairs(replacements) {
  const pairs = new Map()
  for (const item of replacements) {
    const match = /^(slot_\d+)_(dog|name)\.(?:png|jpe?g)$/i.exec(item.file)
    if (!match) throw new Error(`无法从任务文件名识别位置: ${item.file}`)
    const slotKey = match[1]
    const pair = pairs.get(slotKey) || {}
    pair[match[2].toLowerCase()] = item.layerName
    pairs.set(slotKey, pair)
  }
  return [...pairs.entries()].map(([slotKey, pair]) => {
    if (!pair.dog || !pair.name) throw new Error(`${slotKey} 缺少狗图或名字图，无法合并`)
    return { slotKey, dogLayerName: pair.dog, nameLayerName: pair.name }
  })
}

async function mergePlacedImages(doc, replacements) {
  const mergedLayers = []
  for (const pair of slotPairs(replacements)) {
    const dog = findLayer(doc, pair.dogLayerName)
    const name = findLayer(doc, pair.nameLayerName)
    if (!dog || !name) throw new Error(`${pair.slotKey} 图层不存在，无法合并`)
    await selectLayer(dog)
    await batch([
      {
        _obj: 'select',
        _target: [{ _ref: 'layer', _id: name.id }],
        selectionModifier: { _enum: 'selectionModifierType', _value: 'addToSelection' },
        makeVisible: false,
        _options: { dialogOptions: 'dontDisplay' }
      }
    ])
    const selected = doc.activeLayers
    if (
      selected.length !== 2 ||
      ![selected[0].id, selected[1].id].includes(dog.id) ||
      ![selected[0].id, selected[1].id].includes(name.id)
    ) {
      throw new Error(`${pair.slotKey} 未能同时选中狗图和名字图`)
    }
    await batch([{ _obj: 'mergeLayersNew', _options: { dialogOptions: 'dontDisplay' } }])
    const merged = doc.activeLayers[0]
    if (doc.activeLayers.length !== 1 || !merged) {
      throw new Error(`${pair.slotKey} 狗图和名字图未正确合并`)
    }
    merged.name = pair.slotKey
    if (findLayer(doc, pair.dogLayerName) || findLayer(doc, pair.nameLayerName)) {
      throw new Error(`${pair.slotKey} 狗图和名字图未正确合并`)
    }
    merged.visible = true
    mergedLayers.push(merged)
  }
  return mergedLayers
}

function removeExampleArtwork(layers) {
  for (const layer of [...layers]) {
    if (layer.kind === constants.LayerKind.GROUP) removeExampleArtwork(layer.layers)
    if (/^example_|_frames_overlay$/i.test(layer.name) || /^矩形\s+\d+(?:\s+拷贝(?:\s+\d+)?)?$/.test(layer.name)) {
      layer.delete()
    }
  }
}

function removeUnusedSlotArtwork(layers, selectedNames) {
  for (const layer of [...layers]) {
    if (layer.kind === constants.LayerKind.GROUP) removeUnusedSlotArtwork(layer.layers, selectedNames)
    if (/^slot_\d+_(dog|name)$/i.test(layer.name) && !selectedNames.has(layer.name)) layer.delete()
  }
}

async function addOpaqueTiffAlpha(doc) {
  await doc.selection.selectAll()
  await doc.selection.save('PreviewAlpha')
  doc.channels.getByName('PreviewAlpha').visible = false
  await doc.selection.deselect()
}

async function addSpotChannel(doc, layers) {
  doc.activeChannels = doc.componentChannels
  for (let i = doc.channels.length - 1; i >= 0; i -= 1) {
    if (doc.channels[i].name === 'W1') await doc.channels[i].remove()
  }
  for (let i = 0; i < layers.length; i += 1) {
    await doc.selection.load(layers[i], i === 0 ? constants.SelectionType.REPLACE : constants.SelectionType.EXTEND)
  }
  if (!doc.selection.bounds) throw new Error('合并图层没有可生成专色通道的像素')
  await doc.selection.inverse()
  await doc.selection.save('W1')
  const spot = doc.channels.getByName('W1')
  spot.kind = constants.ChannelType.SPOTCOLOR
  const SolidColor = app.SolidColor
  const red = new SolidColor()
  red.rgb.red = 255
  red.rgb.green = 0
  red.rgb.blue = 0
  spot.color = red
  spot.opacity = 100
  spot.visible = false
  await doc.selection.deselect()
}

async function saveExport(doc, output, format) {
  if (format !== 'tiff') {
    await doc.saveAs.psd(output, SAVE_OPTIONS, true)
    return
  }
  const token = await fs.createSessionToken(output)
  const results = await action.batchPlay(
    [
      {
        _obj: 'save',
        as: {
          _obj: 'TIFF',
          alphaChannels: true,
          byteOrder: { _enum: 'platform', _value: 'IBMPC' },
          embedColorProfile: true,
          LZWCompression: true,
          layerCompression: { _enum: 'encoding', _value: 'zip' },
          layers: true,
          spotColors: true
        },
        in: { _path: token, _kind: 'local' },
        copy: true,
        lowerCase: true,
        _options: { dialogOptions: 'silent' }
      }
    ],
    { synchronousExecution: false, modalBehavior: 'execute' }
  )
  const result = results[0]
  if (result?._obj === 'error' || (typeof result?.result === 'number' && result.result < 0)) {
    throw new Error(`Photoshop TIFF 保存失败：${result.message || result.result}`)
  }
}

async function runInPhotoshop(bridge, staging, job) {
  let doc = null
  const replaced = []
  try {
    const templateEntry = await child(staging, job.templateFile)
    if (!templateEntry || !templateEntry.isFile) throw new Error('任务素材目录里没有 template.psd')
    const opened = await app.open(templateEntry)
    if (!sameFile(opened, templateEntry)) throw new Error(`打开了错误文件: ${opened.name}`)
    doc = opened
    removeExampleArtwork(doc.layers)
    removeUnusedSlotArtwork(doc.layers, new Set(job.replacements.map((item) => item.layerName)))
    for (const item of job.replacements) {
      await replaceOne(doc, staging, item)
      replaced.push(item.layerName)
    }
    const mergedLayers = await mergePlacedImages(doc, job.replacements)
    const format = job.format || (/\.tiff?$/i.test(job.outputFile) ? 'tiff' : 'psd')
    if (format === 'tiff') await addOpaqueTiffAlpha(doc)
    await addSpotChannel(doc, mergedLayers)
    const outputs = await outputFolderFor(bridge, job.outputDir)
    const output = await ensureOutput(outputs, job.outputFile)
    await saveExport(doc, output, format)
    await doc.close(constants.SaveOptions.DONOTSAVECHANGES)
    return replaced
  } catch (err) {
    if (doc) {
      try {
        await doc.close(constants.SaveOptions.DONOTSAVECHANGES)
      } catch {
        /* 副本保持未保存，磁盘上的模板副本不被写回 */
      }
    }
    throw err
  }
}

async function prepareCutoutLayer(doc) {
  let layer = doc.layers && doc.layers[0]
  if (!layer) throw new Error('素材文件没有可处理的图层')
  if (layer.isBackgroundLayer) {
    // Converting the special Background layer via the `layerFromBackground`
    // action is unavailable in current Photoshop builds. Setting its layer
    // descriptor to a regular layer is the same operation Photoshop records
    // for Layer > New > Layer from Background.
    await batch([
      {
        _obj: 'set',
        _target: [{ _ref: 'layer', _property: 'background' }],
        to: {
          _obj: 'layer',
          name: 'Layer 0',
          opacity: { _unit: 'percentUnit', _value: 100 },
          mode: { _enum: 'blendMode', _value: 'normal' }
        },
        _options: { dialogOptions: 'dontDisplay' }
      }
    ])
    layer = doc.layers && doc.layers[0]
  }
  if (!layer) throw new Error('无法解锁素材图层')
  layer.visible = true
  if (layer.locked) layer.locked = false
  await selectLayer(layer)
  return layer
}

async function createCutoutMask(doc, kind) {
  if (kind === 'dog') {
    // Photoshop's Select Subject action produces a soft selection suitable for a non-destructive mask.
    await batch([{ _obj: 'autoCutout', sampleAllLayers: false, _options: { dialogOptions: 'dontDisplay' } }])
  } else if (kind === 'name') {
    // Name artwork is typography and grayscale paw ink. Select white by color, then retain
    // the inverse selection so antialiased strokes and gray paw details remain.
    await batch([
      {
        _obj: 'colorRange',
        colorModel: 0,
        fuzziness: 28,
        minimum: { _obj: 'labColor', a: 0, b: 0, luminance: 100 },
        maximum: { _obj: 'labColor', a: 0, b: 0, luminance: 100 },
        _options: { dialogOptions: 'dontDisplay' }
      }
    ])
    if (!doc.selection.bounds) throw new Error('名字图没有检测到白色背景')
    await doc.selection.inverse()
    if (!doc.selection.bounds) throw new Error('名字图没有找到可保留的笔画或爪印')
  } else {
    throw new Error('不支持的抠图模式')
  }

  await batch([
    {
      _obj: 'make',
      at: { _enum: 'channel', _ref: 'channel', _value: 'mask' },
      new: { _class: 'channel' },
      using: { _enum: 'userMaskEnabled', _value: 'revealSelection' },
      _options: { dialogOptions: 'dontDisplay' }
    }
  ])
  await doc.selection.deselect()
}

async function addCutoutMargin(doc) {
  await doc.trim(constants.TrimType.TRANSPARENT, true, true, true, true)
  await doc.resizeCanvas(doc.width + 20, doc.height + 20, constants.AnchorPosition.MIDDLECENTER)
}

async function runCutoutInPhotoshop(bridge, staging, task) {
  let doc = null
  let output = null
  try {
    const source = await child(staging, task.sourceFile)
    if (!source || !source.isFile) throw new Error(`素材文件不存在: ${task.sourceFile}`)
    await core.executeAsModal(
      async () => {
        const opened = await app.open(source)
        if (!sameFile(opened, source)) throw new Error(`打开了错误素材: ${opened.name}`)
        doc = opened
        await prepareCutoutLayer(doc)
        await createCutoutMask(doc, task.kind)
        await addCutoutMargin(doc)
        const outputs = await outputFolderFor(bridge, task.outputDir)
        output = await ensureOutput(outputs, task.outputFile)
        await doc.saveAs.png(output, { interlaced: false }, true)
        await doc.close(constants.SaveOptions.DONOTSAVECHANGES)
        doc = null
      },
      { commandName: task.kind === 'dog' ? '摸鱼抠出狗图主体' : '摸鱼移除名字图白底' }
    )
    return task.outputFile
  } catch (err) {
    if (output) {
      try {
        await output.delete()
      } catch {
        /* failed job must not keep a partial preview */
      }
    }
    if (doc) {
      try {
        await doc.close(constants.SaveOptions.DONOTSAVECHANGES)
      } catch {
        /* source file remains untouched */
      }
    }
    throw err
  }
}

async function runCutoutJob(bridge, file, task) {
  if (!task || typeof task !== 'object') task = { id: file.name, outputFile: null }
  const fail = async (message) => {
    task.result = { ok: false, error: message, outputFile: null }
    let outputs = null
    if (!task.outputDir || isAbsoluteNativePath(task.outputDir)) {
      try {
        outputs = await outputFolderFor(bridge, task.outputDir)
      } catch {
        /* if the output folder was not authorized, the failed task has no output to clean */
      }
    }
    const output = outputs && task.outputFile ? await child(outputs, task.outputFile) : null
    if (output) {
      try {
        await output.delete()
      } catch {
        /* result remains failed even if cleanup is denied by the host */
      }
    }
    await park(file, 'failed', task, bridge)
    log(`抠图 ${task.id || file.name} 失败：${message}`)
  }
  if (
    !task ||
    task.version !== 1 ||
    task.type !== 'cutout' ||
    !Number.isInteger(task.id) ||
    task.id < 1 ||
    !['dog', 'name'].includes(task.kind) ||
    (task.outputDir !== undefined && !isAbsoluteNativePath(task.outputDir)) ||
    !/^source\.(png|jpe?g)$/i.test(task.sourceFile || '') ||
    task.outputFile !== `cutout-${task.id}.png`
  ) {
    await fail('抠图任务文件无效')
    return
  }
  const stagingRoot = await child(bridge, 'staging')
  const staging = stagingRoot ? await child(stagingRoot, `cutout-${task.id}`) : null
  if (!staging || !staging.isFolder) {
    await fail('抠图素材目录不存在')
    return
  }
  try {
    const outputFile = await runCutoutInPhotoshop(bridge, staging, task)
    task.result = { ok: true, error: null, outputFile }
    await park(file, 'done', task, bridge)
    log(`抠图 ${task.id} 已生成 ${outputFile}，等待用户预览确认`)
  } catch (err) {
    await fail(errorText(err))
  }
}

async function runJob(bridge, inboxFile) {
  const processing = await ensureFolder(bridge, 'processing')
  const clash = await child(processing, inboxFile.name)
  if (clash) await clash.delete()
  await inboxFile.moveTo(processing)
  const file = await child(processing, inboxFile.name)
  if (!file) throw new Error('任务文件移入 processing 后找不到了')
  let job
  try {
    job = JSON.parse(await readText(file))
  } catch {
    log(`${inboxFile.name} 无法解析，已留在 processing`)
    return
  }
  if (job && job.type === 'cutout') {
    await runCutoutJob(bridge, file, job)
    return
  }
  const fail = async (message) => {
    job.result = { ok: false, replaced: [], error: message, outputFile: null }
    await park(file, 'failed', job, bridge)
    log(`${job.id || inboxFile.name} 失败：${message}`)
  }
  if (
    !job ||
    job.version !== 1 ||
    (job.outputDir !== undefined && !isAbsoluteNativePath(job.outputDir)) ||
    !Array.isArray(job.replacements) ||
    !job.replacements.length
  ) {
    job = job && typeof job === 'object' ? job : { id: inboxFile.name }
    await fail('任务文件无效')
    return
  }
  const stagingRoot = await child(bridge, 'staging')
  const staging = stagingRoot ? await child(stagingRoot, String(job.id)) : null
  if (!staging || !staging.isFolder) {
    await fail('任务素材目录不存在')
    return
  }
  try {
    let replaced = []
    await core.executeAsModal(
      async () => {
        replaced = await runInPhotoshop(bridge, staging, job)
      },
      { commandName: '摸鱼替换图层' }
    )
    job.result = { ok: true, replaced, error: null, outputFile: job.outputFile }
    await park(file, 'done', job, bridge)
    log(`${job.id} 已导出 ${job.outputFile}`)
  } catch (err) {
    await fail(errorText(err))
  }
}

async function getBridge() {
  const token = localStorage.getItem(TOKEN_KEY)
  if (!token) return null
  try {
    return await fs.getEntryForPersistentToken(token)
  } catch {
    return null
  }
}

async function refreshPluginHeartbeat() {
  if (heartbeatRunning) return
  heartbeatRunning = true
  try {
    const bridge = await getBridge()
    if (!bridge) return
    let file = await child(bridge, HEARTBEAT_FILE)
    if (!file) file = await bridge.createFile(HEARTBEAT_FILE)
    if (file && !file.isFolder) {
      await file.write(JSON.stringify({ updatedAt: Date.now() }), { format: formats.utf8 })
    }
  } finally {
    heartbeatRunning = false
  }
}

async function showFolder() {
  const el = element('folder')
  if (!el) return
  const folder = await getBridge()
  el.textContent = folder
    ? `已授权：${folder.nativePath || folder.name}`
    : '尚未授权。请选择摸鱼工具箱「定制」页里的 psd-bridge 目录。'
}

async function authorize() {
  const folder = await fs.getFolder()
  if (!folder) return
  const token = await fs.createPersistentToken(folder)
  localStorage.setItem(TOKEN_KEY, token)
  await showFolder()
  log('桥接目录已授权')
}

async function processInbox({ silent = false } = {}) {
  const bridge = await getBridge()
  if (!bridge) {
    if (!silent) log('请先授权桥接目录')
    return
  }
  const inbox = await child(bridge, 'inbox')
  if (!inbox || !inbox.isFolder) {
    if (!silent) log('这个目录里没有 inbox。请改选 psd-bridge。')
    return
  }
  const entries = await inbox.getEntries()
  const jobs = entries.filter((entry) => entry.isFile && entry.name.endsWith('.json'))
  if (!jobs.length) {
    if (!silent) log('队列是空的')
    return
  }
  for (const file of jobs) await runJob(bridge, file)
}

function runQueue(options) {
  if (queueRunning) return
  queueRunning = true
  const run = element('run')
  if (run) run.disabled = true
  if (!options?.silent) log('开始执行…')
  processInbox(options)
    .catch((err) => log(errorText(err)))
    .finally(() => {
      queueRunning = false
      const button = element('run')
      if (button) button.disabled = false
    })
}

function bindClick(el, handler) {
  if (!el || boundClicks.has(el)) return
  boundClicks.add(el)
  el.addEventListener('click', handler)
}

function mountPanel(rootNode) {
  if (rootNode && typeof rootNode.querySelector === 'function') panelRoot = rootNode
  bindClick(element('auth'), () => {
    authorize().catch((err) => log(errorText(err)))
  })
  bindClick(element('run'), () => {
    runQueue({ silent: false })
  })
  renderLog()
  showFolder().catch((err) => log(errorText(err)))
}

function unmountPanel() {
  panelRoot = null
}

function startWorker() {
  mountPanel()
  if (!heartbeatTimer) {
    refreshPluginHeartbeat().catch(() => {})
    heartbeatTimer = globalThis.setInterval(() => {
      refreshPluginHeartbeat().catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)
  }
  if (workerTimer) return
  runQueue({ silent: true })
  workerTimer = globalThis.setInterval(() => runQueue({ silent: true }), POLL_INTERVAL_MS)
}

function stopWorker() {
  if (workerTimer) {
    globalThis.clearInterval(workerTimer)
    workerTimer = null
  }
  if (heartbeatTimer) {
    globalThis.clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startWorker)
  else startWorker()
}

#target photoshop

var MoyuPS = (function () {
  var runBuffers = {}
  function sid(name) { return stringIDToTypeID(name) }
  function cid(name) { return charIDToTypeID(name) }
  function px(value) { try { return Number(value.as('px')) } catch (_) { return Number(value) } }
  function errorText(error) { return error && error.message ? String(error.message) : String(error) }
  function quote(value) {
    return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"'
  }
  function json(value) {
    if (value === null || typeof value === 'undefined') return 'null'
    if (typeof value === 'string') return quote(value)
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    if (value instanceof Array) {
      var items = []
      for (var i = 0; i < value.length; i++) items.push(json(value[i]))
      return '[' + items.join(',') + ']'
    }
    var pairs = []
    for (var key in value) if (value.hasOwnProperty(key)) pairs.push(quote(key) + ':' + json(value[key]))
    return '{' + pairs.join(',') + '}'
  }
  function parse(text) {
    if (typeof JSON !== 'undefined' && JSON.parse) return JSON.parse(text)
    return eval('(' + text + ')')
  }
  function decodeHex(hex) {
    if (typeof hex !== 'string' || hex.length % 4 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
      throw new Error('CEP 任务参数编码无效')
    }
    var text = ''
    for (var i = 0; i < hex.length; i += 4) text += String.fromCharCode(parseInt(hex.substr(i, 4), 16))
    return text
  }
  function bounds(layer) {
    return { left: px(layer.bounds[0]), top: px(layer.bounds[1]), right: px(layer.bounds[2]), bottom: px(layer.bounds[3]) }
  }
  function findLayer(container, name) {
    for (var i = 0; i < container.layers.length; i++) {
      var layer = container.layers[i]
      if (layer.name === name) return layer
      if (layer.typename === 'LayerSet') {
        var nested = findLayer(layer, name)
        if (nested) return nested
      }
    }
    return null
  }
  function locked(layer) {
    try { return layer.allLocked === true || layer.pixelsLocked === true || layer.positionLocked === true } catch (_) { return false }
  }
  function assertSmartObject(layer, name) {
    if (!layer) throw new Error('图层不存在: ' + name)
    if (locked(layer)) throw new Error('图层已锁定: ' + name)
    if (layer.kind !== LayerKind.SMARTOBJECT) throw new Error('图层不是智能对象: ' + name)
  }
  function replaceContents(imagePath) {
    var descriptor = new ActionDescriptor()
    descriptor.putPath(cid('null'), File(imagePath))
    executeAction(sid('placedLayerReplaceContents'), descriptor, DialogModes.NO)
  }
  function replaceLayer(doc, item) {
    var layer = findLayer(doc, item.layerName)
    assertSmartObject(layer, item.layerName)
    layer.visible = true
    var target = bounds(layer)
    var layerId = layer.id
    doc.activeLayer = layer
    replaceContents(item.imagePath)
    layer = doc.activeLayer
    if (!layer || layer.id !== layerId) throw new Error('替换后无法定位图层: ' + item.layerName)
    // Photoshop 会把智能对象图层重命名为素材文件名，后续按模板图层名查找前需要恢复。
    layer.name = item.layerName
    layer.visible = true
    var current = bounds(layer)
    var width = current.right - current.left
    var height = current.bottom - current.top
    var targetWidth = target.right - target.left
    var targetHeight = target.bottom - target.top
    if (width <= 0 || height <= 0 || targetWidth <= 0 || targetHeight <= 0) throw new Error('图层范围无效: ' + item.layerName)
    var scale = Math.min(targetWidth / width, targetHeight / height)
    if (Math.abs(scale - 1) > 0.001) layer.resize(scale * 100, scale * 100, AnchorPosition.MIDDLECENTER)
    var fitted = bounds(layer)
    var dx = (target.left + target.right - fitted.left - fitted.right) / 2
    var dy = (target.top + target.bottom - fitted.top - fitted.bottom) / 2
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) layer.translate(UnitValue(dx, 'px'), UnitValue(dy, 'px'))
    fitted = bounds(findLayer(doc, item.layerName))
    var tolerance = 2
    if (fitted.left < target.left - tolerance || fitted.top < target.top - tolerance || fitted.right > target.right + tolerance || fitted.bottom > target.bottom + tolerance) {
      throw new Error('变换未落入模板范围: ' + item.layerName)
    }
  }
  function slotPairs(replacements) {
    var pairs = []
    for (var i = 0; i < replacements.length; i++) {
      var item = replacements[i]
      var match = /^(slot_\d+)_(dog|name)\.(?:png|jpe?g)$/i.exec(item.file || '')
      if (!match) match = /^(slot_\d+)_(dog|name)$/i.exec(item.layerName || '')
      if (!match) throw new Error('无法识别位置: ' + (item.file || item.layerName))
      var slotKey = match[1]
      var pair = null
      for (var j = 0; j < pairs.length; j++) if (pairs[j].slotKey === slotKey) pair = pairs[j]
      if (!pair) {
        pair = { slotKey: slotKey, dogLayerName: null, nameLayerName: null }
        pairs.push(pair)
      }
      pair[match[2].toLowerCase() + 'LayerName'] = item.layerName
    }
    for (var k = 0; k < pairs.length; k++) {
      if (!pairs[k].dogLayerName || !pairs[k].nameLayerName) {
        throw new Error(pairs[k].slotKey + ' 缺少狗图或名字图，无法合并')
      }
    }
    return pairs
  }
  function removeExampleArtwork(container) {
    for (var i = container.layers.length - 1; i >= 0; i--) {
      var layer = container.layers[i]
      if (layer.typename === 'LayerSet') removeExampleArtwork(layer)
      if (/^example_|_frames_overlay$/i.test(layer.name) || /^矩形\s+\d+(?:\s+拷贝(?:\s+\d+)?)?$/.test(layer.name)) layer.remove()
    }
  }
  function removeUnusedSlotArtwork(container, selectedNames) {
    for (var i = container.layers.length - 1; i >= 0; i--) {
      var layer = container.layers[i]
      if (layer.typename === 'LayerSet') removeUnusedSlotArtwork(layer, selectedNames)
      if (/^slot_\d+_(dog|name)$/i.test(layer.name) && !selectedNames[layer.name]) layer.remove()
    }
  }
  function addOpaqueTiffAlpha(doc) {
    doc.selection.selectAll()
    var channel = doc.channels.add()
    doc.selection.store(channel, SelectionType.REPLACE)
    channel.name = 'PreviewAlpha'
    channel.visible = false
    doc.selection.deselect()
  }
  function selectLayerForMerge(layer, addToSelection) {
    var descriptor = new ActionDescriptor()
    var reference = new ActionReference()
    reference.putIdentifier(sid('layer'), layer.id)
    descriptor.putReference(cid('null'), reference)
    if (addToSelection) {
      descriptor.putEnumerated(sid('selectionModifier'), sid('selectionModifierType'), sid('addToSelection'))
    }
    executeAction(sid('select'), descriptor, DialogModes.NO)
  }
  function mergePlacedImages(doc, replacements) {
    var pairs = slotPairs(replacements)
    var mergedLayers = []
    for (var i = 0; i < pairs.length; i++) {
      var pair = pairs[i]
      var dog = findLayer(doc, pair.dogLayerName)
      var name = findLayer(doc, pair.nameLayerName)
      if (!dog || !name) throw new Error(pair.slotKey + ' 图层不存在，无法合并')
      selectLayerForMerge(dog, false)
      selectLayerForMerge(name, true)
      executeAction(cid('Mrg2'), undefined, DialogModes.NO)
      var merged = doc.activeLayer
      merged.name = pair.slotKey
      merged.visible = true
      mergedLayers.push(merged)
    }
    return mergedLayers
  }
  function selectLayerTransparency(layer, addToSelection) {
    var descriptor = new ActionDescriptor()
    var selection = new ActionReference()
    selection.putProperty(cid('Chnl'), cid('fsel'))
    descriptor.putReference(cid('null'), selection)
    var transparency = new ActionReference()
    transparency.putEnumerated(cid('Chnl'), cid('Chnl'), cid('Trsp'))
    transparency.putIdentifier(cid('Lyr '), layer.id)
    descriptor.putReference(cid('T   '), transparency)
    if (addToSelection) {
      descriptor.putEnumerated(sid('selectionModifier'), sid('selectionModifierType'), sid('addToSelection'))
    }
    executeAction(cid('setd'), descriptor, DialogModes.NO)
  }
  function addSpotChannel(doc, layers) {
    doc.activeChannels = doc.componentChannels
    for (var i = doc.channels.length - 1; i >= 0; i--) {
      if (doc.channels[i].name === 'W1') doc.channels[i].remove()
    }
    for (var j = 0; j < layers.length; j++) selectLayerTransparency(layers[j], j > 0)
    if (!hasSelection(doc)) throw new Error('合并图层没有可生成专色通道的像素')
    doc.selection.invert()
    var channel = doc.channels.add()
    doc.selection.store(channel, SelectionType.REPLACE)
    channel.name = 'W1'
    channel.kind = ChannelType.SPOTCOLOR
    var color = new SolidColor()
    color.rgb.red = 255
    color.rgb.green = 0
    color.rgb.blue = 0
    channel.color = color
    channel.opacity = 100
    channel.visible = false
    doc.selection.deselect()
  }
  function saveExport(doc, output, format) {
    if (format === 'tiff') {
      var tiff = new TiffSaveOptions()
      tiff.alphaChannels = true
      tiff.byteOrder = ByteOrder.IBM
      tiff.embedColorProfile = true
      tiff.imageCompression = TIFFEncoding.TIFFLZW
      tiff.layers = true
      tiff.spotColors = true
      doc.saveAs(output, tiff, true, Extension.LOWERCASE)
      return
    }
    var psd = new PhotoshopSaveOptions()
    psd.alphaChannels = true
    psd.annotations = true
    psd.embedColorProfile = true
    psd.layers = true
    psd.spotColors = true
    psd.maximizeCompatibility = true
    doc.saveAs(output, psd, true, Extension.LOWERCASE)
  }
  function openExact(path) {
    if (typeof path !== 'string' || path.length === 0) throw new Error('Photoshop 收到的文件路径为空')
    var file = File(path)
    if (!file.exists) throw new Error('文件不存在: ' + path)
    var doc = app.open(file)
    if (String(doc.fullName.fsName).replace(/\\/g, '/').toLowerCase() !== String(file.fsName).replace(/\\/g, '/').toLowerCase()) {
      try { doc.close(SaveOptions.DONOTSAVECHANGES) } catch (_) {}
      throw new Error('打开了错误文件: ' + doc.name)
    }
    return doc
  }
  function runExport(task) {
    var doc = null
    var stage = '校验导出参数'
    try {
      if (!task || typeof task.templatePath !== 'string' || !task.templatePath) {
        throw new Error('Photoshop 收到的导出任务缺少 templatePath')
      }
      if (typeof task.outputPath !== 'string' || !task.outputPath || !(task.replacements instanceof Array)) {
        throw new Error('Photoshop 收到的导出任务字段不完整')
      }
      stage = '打开模板'
      doc = openExact(task.templatePath)
      stage = '清除模板示例图案'
      removeExampleArtwork(doc)
      var selectedNames = {}
      for (var r = 0; r < task.replacements.length; r++) selectedNames[task.replacements[r].layerName] = true
      removeUnusedSlotArtwork(doc, selectedNames)
      var replaced = []
      for (var i = 0; i < task.replacements.length; i++) {
        stage = '替换图层 ' + task.replacements[i].layerName
        replaceLayer(doc, task.replacements[i])
        replaced.push(task.replacements[i].layerName)
      }
      stage = '合并每个位置的狗图和名字图'
      var mergedLayers = mergePlacedImages(doc, task.replacements)
      if (task.format === 'tiff') {
        stage = '创建 TIFF 预览 Alpha 通道'
        addOpaqueTiffAlpha(doc)
      }
      stage = '创建 W1 专色通道'
      addSpotChannel(doc, mergedLayers)
      var output = File(task.outputPath)
      stage = task.format === 'tiff' ? '保存 TIFF' : '保存 PSD'
      saveExport(doc, output, task.format)
      doc.close(SaveOptions.DONOTSAVECHANGES)
      doc = null
      return { ok: true, replaced: replaced }
    } catch (error) {
      if (doc) { try { doc.close(SaveOptions.DONOTSAVECHANGES) } catch (_) {} }
      return { ok: false, error: stage + '：' + errorText(error) }
    }
  }
  function unlockBackground(doc) {
    if (!doc.activeLayer.isBackgroundLayer) return
    var descriptor = new ActionDescriptor()
    var reference = new ActionReference()
    reference.putProperty(sid('layer'), sid('background'))
    descriptor.putReference(sid('null'), reference)
    var layer = new ActionDescriptor()
    layer.putString(sid('name'), 'Layer 0')
    layer.putUnitDouble(sid('opacity'), sid('percentUnit'), 100)
    layer.putEnumerated(sid('mode'), sid('blendMode'), sid('normal'))
    descriptor.putObject(sid('to'), sid('layer'), layer)
    executeAction(sid('set'), descriptor, DialogModes.NO)
  }
  function hasSelection(doc) {
    try { return !!doc.selection.bounds } catch (_) { return false }
  }
  function colorRangeWhite() {
    var descriptor = new ActionDescriptor()
    descriptor.putInteger(sid('colorModel'), 0)
    descriptor.putInteger(sid('fuzziness'), 28)
    var minimum = new ActionDescriptor()
    minimum.putDouble(sid('a'), 0)
    minimum.putDouble(sid('b'), 0)
    minimum.putDouble(sid('luminance'), 100)
    var maximum = new ActionDescriptor()
    maximum.putDouble(sid('a'), 0)
    maximum.putDouble(sid('b'), 0)
    maximum.putDouble(sid('luminance'), 100)
    descriptor.putObject(sid('minimum'), sid('labColor'), minimum)
    descriptor.putObject(sid('maximum'), sid('labColor'), maximum)
    executeAction(sid('colorRange'), descriptor, DialogModes.NO)
  }
  function revealSelectionMask() {
    var descriptor = new ActionDescriptor()
    descriptor.putClass(cid('Nw  '), cid('Chnl'))
    var at = new ActionReference()
    at.putEnumerated(cid('Chnl'), cid('Chnl'), cid('Msk '))
    descriptor.putReference(cid('At  '), at)
    descriptor.putEnumerated(cid('Usng'), cid('UsrM'), cid('RvlS'))
    executeAction(cid('Mk  '), descriptor, DialogModes.NO)
  }
  function runCutout(task) {
    var doc = null
    try {
      if (!task || typeof task.sourcePath !== 'string' || !task.sourcePath) {
        throw new Error('Photoshop 收到的抠图任务缺少 sourcePath [CEP 1.0.7]')
      }
      doc = openExact(task.sourcePath)
      unlockBackground(doc)
      var layer = doc.activeLayer
      if (!layer) throw new Error('素材文件没有可处理的图层')
      layer.visible = true
      try { layer.allLocked = false } catch (_) {}
      doc.activeLayer = layer
      if (task.assetKind === 'dog') {
        var selection = new ActionDescriptor()
        selection.putBoolean(sid('sampleAllLayers'), false)
        executeAction(sid('autoCutout'), selection, DialogModes.NO)
      } else if (task.assetKind === 'name') {
        colorRangeWhite()
        if (!hasSelection(doc)) throw new Error('名字图没有检测到白色背景')
        doc.selection.invert()
        if (!hasSelection(doc)) throw new Error('名字图没有找到可保留的笔画或爪印')
      } else {
        throw new Error('不支持的抠图模式')
      }
      revealSelectionMask()
      doc.selection.deselect()
      doc.trim(TrimType.TRANSPARENT, true, true, true, true)
      doc.resizeCanvas(UnitValue(px(doc.width) + 20, 'px'), UnitValue(px(doc.height) + 20, 'px'), AnchorPosition.MIDDLECENTER)
      var output = File(task.outputPath)
      var options = new PNGSaveOptions()
      options.interlaced = false
      doc.saveAs(output, options, true, Extension.LOWERCASE)
      doc.close(SaveOptions.DONOTSAVECHANGES)
      doc = null
      return { ok: true }
    } catch (error) {
      if (doc) { try { doc.close(SaveOptions.DONOTSAVECHANGES) } catch (_) {} }
      return { ok: false, error: errorText(error) }
    }
  }
  function run(raw) {
    var result
    try {
      var task = parse(raw)
      if (task.kind === 'export') {
        result = runExport(task)
      } else if (task.kind === 'cutout') {
        result = runCutout(task)
      } else {
        result = { ok: false, error: '不支持的 Photoshop 任务' }
      }
    } catch (error) {
      result = { ok: false, error: '解析或分派任务：' + errorText(error) }
    }
    return json(result)
  }
  function runFile(path) {
    var input = null
    try {
      if (typeof path !== 'string' || !path) throw new Error('任务文件路径为空')
      input = File(path)
      if (!input.exists) throw new Error('任务文件不存在: ' + path)
      input.encoding = 'UTF-8'
      if (!input.open('r')) throw new Error('无法打开任务文件: ' + path)
      var raw = input.read()
      input.close()
      return run(raw)
    } catch (error) {
      if (input) { try { input.close() } catch (_) {} }
      return json({ ok: false, error: '读取 Photoshop 任务：' + errorText(error) })
    }
  }
  function runHexPart(token, index, total, hexPart) {
    try {
      if (typeof token !== 'string' || !/^[a-z0-9]+$/i.test(token)) throw new Error('Photoshop 参数传输标识无效')
      if (typeof index !== 'number' || typeof total !== 'number' || index < 0 || total < 1 || index >= total) {
        throw new Error('Photoshop 参数分块序号无效')
      }
      if (typeof hexPart !== 'string' || hexPart.length % 4 !== 0 || !/^[0-9a-f]*$/i.test(hexPart)) {
        throw new Error('Photoshop 参数分块内容无效')
      }
      if (index === 0) runBuffers[token] = { next: 0, total: total, parts: [] }
      var buffer = runBuffers[token]
      if (!buffer || buffer.total !== total || buffer.next !== index) throw new Error('Photoshop 参数分块顺序错误')
      buffer.parts.push(hexPart)
      buffer.next++
      if (buffer.next < buffer.total) return true
      delete runBuffers[token]
      return run(decodeHex(buffer.parts.join('')))
    } catch (error) {
      delete runBuffers[token]
      return json({ ok: false, error: errorText(error) })
    }
  }
  return {
    run: run,
    runFile: runFile,
    runHexPart: runHexPart
  }
})()

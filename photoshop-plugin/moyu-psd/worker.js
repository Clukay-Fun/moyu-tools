/* global window */
;(function () {
  'use strict'

  var fs = require('fs')
  var path = require('path')
  var cep = window.__adobe_cep__
  var root = decodeURIComponent(cep.getSystemPath('extension').replace(/^file:\/\/\/?/i, '')).replace(/\/$/, '')
  var settingsPath = path.join(root, 'moyu-settings.json')
  var logPath = path.join(root, 'moyu-worker.log')
  var requestPath = path.join(root, 'moyu-run-now.flag')
  var cs = {
    evalScript: function (script, callback) {
      cep.evalScript(script, callback)
    }
  }
  var busy = false

  function log(message) {
    var stamp = new Date().toLocaleString()
    var existing = ''
    try {
      existing = fs.readFileSync(logPath, 'utf8')
    } catch {
      /* first run has no log file yet */
    }
    var lines = (existing + stamp + ' ' + message + '\n').split(/\r?\n/).filter(Boolean).slice(-80)
    try {
      fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf8')
    } catch {
      /* log file is optional */
    }
  }

  function settings() {
    var value = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    if (!value.bridgeDir || !path.isAbsolute(value.bridgeDir)) throw new Error('桥接目录设置无效')
    if (!value.outputDir || !path.isAbsolute(value.outputDir)) throw new Error('导出目录设置无效')
    return value
  }

  function safeFileName(value) {
    return (
      typeof value === 'string' && value.length > 0 && path.basename(value) === value && value !== '.' && value !== '..'
    )
  }

  function writeJsonAtomic(filePath, value) {
    var temp = filePath + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
    try {
      fs.unlinkSync(filePath)
    } catch {
      /* replace stale task metadata only when present */
    }
    fs.renameSync(temp, filePath)
  }

  function park(processingPath, bridge, folder, job) {
    var destinationDir = path.join(bridge, folder)
    var destination = path.join(destinationDir, path.basename(processingPath))
    if (fs.existsSync(destination)) fs.unlinkSync(destination)
    writeJsonAtomic(processingPath, job)
    fs.renameSync(processingPath, destination)
  }

  function cleanOutput(task, cfg) {
    if (!task || !safeFileName(task.outputFile)) return
    var dir = task.outputDir || cfg.outputDir
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return
    try {
      fs.unlinkSync(path.join(dir, task.outputFile))
    } catch {
      /* output may not have been created */
    }
  }

  function fail(processingPath, bridge, task, cfg, message, isCutout) {
    if (!task || typeof task !== 'object') task = { id: path.basename(processingPath) }
    cleanOutput(task, cfg)
    if (isCutout) task.result = { ok: false, error: message, outputFile: null }
    else task.result = { ok: false, replaced: [], error: message, outputFile: null }
    try {
      park(processingPath, bridge, 'failed', task)
    } catch (error) {
      log('任务失败文件写入失败：' + errorText(error))
    }
    log((isCutout ? '抠图 ' : '导出 ') + (task.id || path.basename(processingPath)) + ' 失败：' + message)
  }

  function errorText(error) {
    return error && error.message ? String(error.message) : String(error)
  }

  function hostRun(payload, payloadPath, callback) {
    log(
      '调用 Photoshop：' +
        payload.kind +
        '，模板路径=' +
        (typeof payload.templatePath === 'string' && payload.templatePath ? '已传入' : '缺失') +
        '，原图路径=' +
        (payload.kind === 'cutout'
          ? typeof payload.sourcePath === 'string' && payload.sourcePath
            ? '已传入'
            : '缺失'
          : '不适用') +
        '，素材数=' +
        (Array.isArray(payload.replacements) ? payload.replacements.length : 0) +
        '，传输方式=任务文件'
    )
    function receiveResult(raw) {
      var result
      try {
        result = JSON.parse(raw)
      } catch {
        callback(new Error('Photoshop JSX 运行未返回任务结果：' + (raw || '无返回结果')))
        return
      }
      if (!result || result.ok !== true) {
        callback(new Error((result && result.error) || 'Photoshop 处理失败'))
        return
      }
      callback(null, result)
    }

    var hostPath = path.join(root, 'host.jsx').replace(/\\/g, '/')
    var normalizedPayloadPath = payloadPath.replace(/\\/g, '/')
    cs.evalScript('$.evalFile(File(' + JSON.stringify(hostPath) + ')); typeof MoyuPS.runFile', function (raw) {
      if (raw !== 'function') {
        callback(new Error('Photoshop JSX 加载失败 [CEP 1.0.7]：' + (raw || '无返回结果')))
        return
      }
      cs.evalScript('MoyuPS.runFile(' + JSON.stringify(normalizedPayloadPath) + ')', receiveResult)
    })
  }

  function processTask(fileName, cfg, bridge, done) {
    var inboxPath = path.join(bridge, 'inbox', fileName)
    var processingPath = path.join(bridge, 'processing', fileName)
    try {
      fs.renameSync(inboxPath, processingPath)
    } catch {
      done()
      return
    }
    var task
    try {
      task = JSON.parse(fs.readFileSync(processingPath, 'utf8'))
    } catch {
      task = { id: fileName }
      fail(processingPath, bridge, task, cfg, '任务文件无法解析', false)
      done()
      return
    }
    var isCutout = task && task.type === 'cutout'
    try {
      if (!task || task.version !== 1 || !Number.isInteger(task.id) || task.id < 1) throw new Error('任务文件无效')
      if (task.outputDir && !path.isAbsolute(task.outputDir)) throw new Error('导出目录路径无效')
      if (!safeFileName(task.outputFile)) throw new Error('输出文件名无效')
      var outputDir = task.outputDir || cfg.outputDir
      fs.mkdirSync(outputDir, { recursive: true })
      var payload
      var stagingKey
      if (isCutout) {
        if (['dog', 'name'].indexOf(task.kind) < 0 || !/^source\.(png|jpe?g)$/i.test(task.sourceFile || ''))
          throw new Error('抠图任务文件无效')
        stagingKey = 'cutout-' + task.id
        var sourcePath = path.join(bridge, 'staging', stagingKey, task.sourceFile)
        if (!fs.existsSync(sourcePath)) throw new Error('抠图素材文件不存在')
        payload = {
          kind: 'cutout',
          sourcePath: sourcePath,
          outputPath: path.join(outputDir, task.outputFile),
          assetKind: task.kind
        }
      } else {
        if (!Array.isArray(task.replacements) || !task.replacements.length || !safeFileName(task.templateFile))
          throw new Error('导出任务文件无效')
        stagingKey = String(task.id)
        var staging = path.join(bridge, 'staging', stagingKey)
        var templatePath = path.join(staging, task.templateFile)
        if (!fs.existsSync(templatePath)) throw new Error('任务模板文件不存在')
        var replacements = []
        task.replacements.forEach(function (item) {
          if (!item || !safeFileName(item.file) || typeof item.layerName !== 'string' || !item.layerName)
            throw new Error('替换素材设置无效')
          var imagePath = path.join(staging, item.file)
          if (!fs.existsSync(imagePath)) throw new Error('素材文件不存在: ' + item.file)
          replacements.push({ layerName: item.layerName, imagePath: imagePath, file: item.file })
        })
        payload = {
          kind: 'export',
          templatePath: templatePath,
          outputPath: path.join(outputDir, task.outputFile),
          format: task.format || (/\.tiff?$/i.test(task.outputFile) ? 'tiff' : 'psd'),
          replacements: replacements
        }
      }
      if (payload.kind === 'export' && (!payload.templatePath || !payload.outputPath || !payload.replacements.length)) {
        throw new Error('Photoshop 导出参数不完整：模板、输出路径或替换素材缺失')
      }
      var payloadPath = path.join(bridge, 'staging', stagingKey, 'cep-payload.json')
      fs.writeFileSync(payloadPath, JSON.stringify(payload), 'utf8')
      hostRun(payload, payloadPath, function (error, result) {
        if (error) {
          fail(processingPath, bridge, task, cfg, errorText(error), isCutout)
          done()
          return
        }
        if (isCutout) task.result = { ok: true, error: null, outputFile: task.outputFile }
        else task.result = { ok: true, replaced: result.replaced || [], error: null, outputFile: task.outputFile }
        try {
          park(processingPath, bridge, 'done', task)
          log((isCutout ? '抠图 ' : '导出 ') + task.id + ' 已完成：' + task.outputFile)
        } catch (parkError) {
          log('任务结果写入失败：' + errorText(parkError))
        }
        done()
      })
    } catch (error) {
      fail(processingPath, bridge, task, cfg, errorText(error), isCutout)
      done()
    }
  }

  function processNext(files, index, cfg, bridge, done) {
    if (index >= files.length) {
      done()
      return
    }
    processTask(files[index], cfg, bridge, function () {
      processNext(files, index + 1, cfg, bridge, done)
    })
  }

  function processQueue() {
    if (busy) return
    busy = true
    try {
      var cfg = settings()
      var bridge = cfg.bridgeDir
      var inbox = path.join(bridge, 'inbox')
      var files = fs
        .readdirSync(inbox)
        .filter(function (name) {
          return /\.json$/i.test(name)
        })
        .sort()
      processNext(files, 0, cfg, bridge, function () {
        busy = false
      })
    } catch (error) {
      log('队列检查失败：' + errorText(error))
      busy = false
    }
  }

  log('Photoshop CEP 后台扩展已启动 [CEP 1.0.7 / 摸鱼工具箱]，加载目录=' + root)
  window.setInterval(function () {
    if (fs.existsSync(requestPath)) {
      try {
        fs.unlinkSync(requestPath)
      } catch {
        /* request flag may already be gone */
      }
      processQueue()
      return
    }
    processQueue()
  }, 1000)
})()

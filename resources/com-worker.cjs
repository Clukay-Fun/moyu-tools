const parentPort = process.parentPort
const winax = require(process.env.MOYU_WINAX_MODULE)
const cancelledTasks = new Set()

function post(message) {
  parentPort.postMessage(message)
}

function progress(id, completed, total, name, message) {
  post({
    type: 'progress',
    id,
    completed,
    total,
    name,
    message
  })
}

function release(...objects) {
  const available = objects.filter(Boolean)
  if (available.length) {
    try {
      winax.release(...available)
    } catch {
      // COM cleanup is best-effort after Close/Quit.
    }
  }
}

function assertWindows() {
  if (process.platform !== 'win32') {
    throw new Error('COM 联动仅支持 Windows')
  }
}

function extendScriptString(value) {
  return JSON.stringify(String(value))
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function illustratorScript(inputPath, outputPath, action) {
  const input = extendScriptString(inputPath)
  const output = extendScriptString(outputPath)
  const operation = action === 'outline'
    ? `
      var outlineFailures = 0;
      for (var index = document.textFrames.length - 1; index >= 0; index -= 1) {
        try {
          document.textFrames[index].createOutline();
        } catch (outlineError) {
          outlineFailures += 1;
        }
      }
      if (outlineFailures > 0) {
        throw new Error(outlineFailures + " 个文本对象无法转曲，请检查锁定对象或缺失字体");
      }
      var options = new IllustratorSaveOptions();
      options.pdfCompatible = true;
      document.saveAs(new File(${output}), options);
    `
    : `
      var options = new PDFSaveOptions();
      options.preserveEditability = ${action === 'minimal-pdf' ? 'false' : 'true'};
      options.generateThumbnails = false;
      options.optimization = true;
      ${action === 'minimal-pdf' ? `
      options.compressArt = true;
      options.colorDownsamplingMethod = DownsampleMethod.BICUBICDOWNSAMPLE;
      options.colorDownsampling = 250;
      options.colorDownsamplingImageThreshold = 250;
      options.grayscaleDownsamplingMethod = DownsampleMethod.BICUBICDOWNSAMPLE;
      options.grayscaleDownsampling = 250;
      options.grayscaleDownsamplingImageThreshold = 250;
      options.monochromeDownsamplingMethod = DownsampleMethod.BICUBICDOWNSAMPLE;
      options.monochromeDownsampling = 250;
      options.monochromeDownsamplingImageThreshold = 250;
      options.colorCompression = CompressionQuality.JPEGMINIMUM;
      options.grayscaleCompression = CompressionQuality.JPEGMINIMUM;
      ` : ''}
      document.saveAs(new File(${output}), options);
    `

  return `
    var sourceFile = new File(${input});
    var previousInteractionLevel = app.userInteractionLevel;
    var document = null;
    try {
      app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
      document = app.open(sourceFile);
      ${operation}
    } finally {
      if (document) document.close(SaveOptions.DONOTSAVECHANGES);
      app.userInteractionLevel = previousInteractionLevel;
    }
  `
}

// Spike：验证 SVG 导入 Illustrator 后能否得到"未编组的独立对象"。
//
// 口径说明（2026-08-03 修正）：
//   - 数字对象可以是 PathItem 或 CompoundPathItem——只有 0/6/8/9 等带内孔的
//     才会是复合路径，1/2/3/5/7 等通常是普通 PathItem。因此**不能**用
//     compoundPathItems≈12 作判据；正确判据是"HRI 区共 12 个独立数字对象"。
//   - 条为轴对齐矩形（4 个锚点），数字路径锚点数远多于 4，据此区分。
//   - mode='roundtrip' 才能证明**粘贴后**仍未编组；inspect 只证明复制前。
//
// 本脚本只回报证据，不下结论。
function illustratorUngroupedCopyScript(inputPath, mode) {
  const input = extendScriptString(inputPath)
  const doCopy = mode === 'copy' || mode === 'roundtrip' ? 'true' : 'false'
  const doRoundtrip = mode === 'roundtrip' ? 'true' : 'false'
  return `
    var previousInteractionLevel = app.userInteractionLevel;
    var doc = null;
    var pastedDoc = null;
    var report = {};
    try {
      app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;

      // 递归解组（自底向上，防死循环）
      function ungroupAll(container) {
        var changed = true, guard = 0;
        while (changed && guard < 64) {
          changed = false; guard++;
          for (var i = container.groupItems.length - 1; i >= 0; i--) {
            var group = container.groupItems[i];
            for (var j = group.pageItems.length - 1; j >= 0; j--) {
              group.pageItems[j].moveBefore(group);
            }
            group.remove();
            changed = true;
          }
        }
        return guard;
      }

      // 结构统计：只数**顶层独立对象**。
      // ⚠ Document.pathItems 会把 CompoundPathItem 的子路径也算进去，
      //   若直接遍历它再叠加 compoundPathItems，数字会被重复计数（DigitLike 虚高）。
      //   因此按 parent.typename === 'Layer' 过滤，排除复合路径内部子路径与组内成员。
      function survey(container, prefix) {
        var rectLike = 0, glyphLike = 0, holes = 0, topLevel = 0;
        for (var i = 0; i < container.pageItems.length; i++) {
          var item = container.pageItems[i];
          var parentType = '';
          try { parentType = item.parent.typename; } catch (e) { parentType = ''; }
          if (parentType !== 'Layer') continue;   // 跳过复合路径子路径 / 组内成员
          topLevel++;

          if (item.typename === 'CompoundPathItem') {
            glyphLike++;
            var subs = 0;
            try { subs = item.pathItems.length; } catch (e) { subs = 0; }
            if (subs >= 2) holes++;
          } else if (item.typename === 'PathItem') {
            var pts = 0;
            try { pts = item.pathPoints.length; } catch (e) { pts = 0; }
            if (pts === 4) rectLike++; else if (pts > 4) glyphLike++;
          }
        }
        report[prefix + 'Groups'] = container.groupItems.length;
        report[prefix + 'TopLevel'] = topLevel;
        report[prefix + 'BarLike'] = rectLike;
        report[prefix + 'DigitLike'] = glyphLike;
        report[prefix + 'WithHoles'] = holes;
      }

      doc = app.open(new File(${input}));
      report.ungroupPasses = ungroupAll(doc);

      // 删白色满幅背景
      var removed = 0;
      for (var m = doc.pathItems.length - 1; m >= 0; m--) {
        var item = doc.pathItems[m];
        var white = false;
        try {
          white = item.filled && item.fillColor.typename === 'RGBColor' &&
            item.fillColor.red > 250 && item.fillColor.green > 250 && item.fillColor.blue > 250;
        } catch (e) { white = false; }
        if (white && item.width >= doc.width - 1 && item.height >= doc.height - 1) {
          item.remove(); removed++;
        }
      }
      report.removedBackground = removed;
      report.docWidthPt = doc.width;
      report.docHeightPt = doc.height;
      survey(doc, 'before');

      if (${doCopy}) {
        app.executeMenuCommand('selectall');
        report.selectedCount = doc.selection.length;
        app.copy();
        report.copied = true;
      }

      if (${doRoundtrip}) {
        doc.close(SaveOptions.DONOTSAVECHANGES);
        doc = null;
        pastedDoc = app.documents.add();
        app.executeMenuCommand('paste');
        // 粘贴后可能仍带外层组：先如实统计，再解组统计，两者都回报
        survey(pastedDoc, 'pasted');
        report.pastedUngroupPasses = ungroupAll(pastedDoc);
        survey(pastedDoc, 'pastedAfterUngroup');
      }
    } catch (err) {
      report.error = String(err);
    } finally {
      try { if (doc) doc.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {}
      try { if (pastedDoc) pastedDoc.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {}
      app.userInteractionLevel = previousInteractionLevel;
    }
    var parts = [];
    for (var key in report) { parts.push(key + '=' + report[key]); }
    parts.join('|');
  `
}

function illustratorSvgScript(inputPath, outputPath) {
  const input = extendScriptString(inputPath)
  if (!outputPath) {
    return `
      var previousInteractionLevel = app.userInteractionLevel;
      try {
        app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
        app.open(new File(${input}));
      } finally {
        app.userInteractionLevel = previousInteractionLevel;
      }
    `
  }
  const output = extendScriptString(outputPath)
  return `
    var previousInteractionLevel = app.userInteractionLevel;
    var document = null;
    try {
      app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
      document = app.open(new File(${input}));
      var options = new EPSSaveOptions();
      document.saveAs(new File(${output}), options);
    } finally {
      if (document) document.close(SaveOptions.DONOTSAVECHANGES);
      app.userInteractionLevel = previousInteractionLevel;
    }
  `
}

function createComObject(progId, activateExisting = false) {
  try {
    return new winax.Object(progId, { activate: activateExisting })
  } catch (error) {
    const wrapped = new Error(`无法启动 ${progId}，请确认对应软件已安装`)
    wrapped.cause = error
    throw wrapped
  }
}

function disableOfficeMacros(application) {
  try {
    application.AutomationSecurity = 3
  } catch {
    // Older Office versions may not expose the shared automation security property.
  }
}

function runOfficeToPdf(payload) {
  const { kind, inputPath, outputPath } = payload
  let application
  let document

  try {
    if (kind === 'word') {
      application = createComObject('Word.Application')
      application.Visible = false
      application.DisplayAlerts = 0
      disableOfficeMacros(application)
      document = application.Documents.Open(inputPath, false, true)
      document.ExportAsFixedFormat(outputPath, 17)
    } else if (kind === 'excel') {
      application = createComObject('Excel.Application')
      application.Visible = false
      application.DisplayAlerts = false
      disableOfficeMacros(application)
      document = application.Workbooks.Open(inputPath, 0, true)
      document.ExportAsFixedFormat(0, outputPath)
    } else if (kind === 'powerpoint') {
      application = createComObject('PowerPoint.Application')
      disableOfficeMacros(application)
      document = application.Presentations.Open(inputPath, true, false, false)
      document.SaveAs(outputPath, 32)
    } else {
      throw new Error('不支持的 Office 文件类型')
    }
  } finally {
    if (document) {
      try {
        document.Close(false)
      } catch {
        try {
          document.Close()
        } catch {
          // Continue to application cleanup.
        }
      }
    }
    if (application) {
      try {
        application.Quit()
      } catch {
        // Release the COM proxy even if the application already closed.
      }
    }
    release(document, application)
  }

  return { outputPath }
}

async function runIllustratorBatch(id, payload) {
  const application = createComObject('Illustrator.Application', true)
  const files = payload.files || []
  const outputs = []

  try {
    for (const [index, file] of files.entries()) {
      if (cancelledTasks.has(id)) {
        const error = new Error('TASK_CANCELLED')
        error.code = 'TASK_CANCELLED'
        throw error
      }
      progress(id, index, files.length, file.name, `正在处理 ${file.name}`)
      application.DoJavaScript(illustratorScript(file.inputPath, file.outputPath, payload.action))
      outputs.push({ inputPath: file.inputPath, outputPath: file.outputPath, name: file.name })
      progress(id, index + 1, files.length, file.name, `${file.name} 已完成`)
      await new Promise((resolve) => setImmediate(resolve))
    }
  } finally {
    cancelledTasks.delete(id)
    release(application)
  }
  return { outputs }
}

function runIllustratorUngroupedCopy(payload) {
  const application = createComObject('Illustrator.Application', true)
  try {
    const raw = application.DoJavaScript(
      illustratorUngroupedCopyScript(payload.inputPath, payload.mode || 'inspect')
    )
    const report = String(raw == null ? '' : raw)
    // ExtendScript 内部异常写在 report.error 里；此处必须转成真正的失败，
    // 否则会把脚本失败误判为成功（与 PNG density 同类缺陷）。
    const fields = {}
    for (const pair of report.split('|')) {
      const at = pair.indexOf('=')
      if (at > 0) fields[pair.slice(0, at)] = pair.slice(at + 1)
    }
    if (fields.error) throw new Error(`Illustrator 脚本失败：${fields.error}`)
    if (!report) throw new Error('Illustrator 脚本未返回任何结构统计')
    return { report, fields }
  } finally {
    release(application)
  }
}

function runIllustratorSvg(payload) {
  const application = createComObject('Illustrator.Application', true)
  try {
    application.DoJavaScript(illustratorSvgScript(payload.inputPath, payload.outputPath))
  } finally {
    release(application)
  }
  return { outputPath: payload.outputPath || null }
}

function runPhotoshopOpen(payload) {
  const application = createComObject('Photoshop.Application', true)
  try {
    application.Open(payload.inputPath)
    application.Visible = true
  } finally {
    release(application)
  }
  return { opened: true }
}

async function execute(id, command, payload) {
  assertWindows()
  if (command === 'probe') {
    const shell = createComObject('WScript.Shell')
    try {
      return {
        winax: require(`${process.env.MOYU_WINAX_MODULE}/package.json`).version,
        windowsDirectory: String(shell.ExpandEnvironmentStrings('%WINDIR%')),
        processType: process.type
      }
    } finally {
      release(shell)
    }
  }
  if (command === 'office-to-pdf') return runOfficeToPdf(payload)
  if (command === 'illustrator-batch') return runIllustratorBatch(id, payload)
  if (command === 'illustrator-svg') return runIllustratorSvg(payload)
  if (command === 'illustrator-ungrouped-copy') return runIllustratorUngroupedCopy(payload)
  if (command === 'photoshop-open') return runPhotoshopOpen(payload)
  throw new Error(`不支持的 COM 命令：${command}`)
}

parentPort.on('message', async (event) => {
  const message = event?.data ?? event
  if (message?.type === 'cancel' && message.id) {
    cancelledTasks.add(message.id)
    return
  }
  if (message?.type !== 'request' || !message.id) return

  try {
    const result = await execute(message.id, message.command, message.payload || {})
    post({ type: 'result', id: message.id, ok: true, result })
  } catch (error) {
    post({
      type: 'result',
      id: message.id,
      ok: false,
      error: error?.code === 'TASK_CANCELLED'
        ? 'TASK_CANCELLED'
        : String(error?.message || error)
    })
  }
})

parentPort.start?.()

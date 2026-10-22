/* global window */
;(function () {
  'use strict'

  var status = document.getElementById('status')
  var cep = window.__adobe_cep__
  var fileApi = window.cep && window.cep.fs

  function extensionPath() {
    var raw = cep.getSystemPath('extension')
    return decodeURIComponent(raw.replace(/^file:\/\/\/?/i, '')).replace(/\/$/, '')
  }

  function read(path) {
    if (!fileApi) return null
    var result = fileApi.readFile(path)
    return result && result.err === 0 ? result.data : null
  }

  function show() {
    var root = extensionPath()
    document.getElementById('extension-root').textContent = root
    var settings
    try {
      settings = JSON.parse(read(root + '/moyu-settings.json') || '{}')
    } catch {
      settings = {}
    }
    document.getElementById('bridge').textContent = settings.bridgeDir || '请先在摸鱼工具箱 安装插件'
    document.getElementById('output').textContent = settings.outputDir || '请先在摸鱼工具箱 安装插件'
    var log = read(root + '/moyu-worker.log')
    document.getElementById('log').textContent = log
      ? log.split(/\r?\n/).slice(-12).join('\n')
      : '等待 Photoshop 后台扩展启动…'
  }

  if (!cep || typeof cep.getSystemPath !== 'function') {
    status.textContent = 'CEP 宿主接口没有加载，请重启 Photoshop'
    return
  }
  if (!fileApi || typeof fileApi.readFile !== 'function') {
    status.textContent = 'CEP 文件接口没有加载，请重启 Photoshop'
    return
  }

  status.textContent = '面板已载入，正在连接后台…'
  document.getElementById('run').addEventListener('click', function () {
    var result = fileApi.writeFile(extensionPath() + '/moyu-run-now.flag', String(Date.now()))
    status.textContent = result && result.err === 0 ? '已通知后台检查队列' : '通知后台失败，请查看安装目录权限'
    window.setTimeout(show, 500)
  })
  show()
  window.setInterval(show, 1500)
})()

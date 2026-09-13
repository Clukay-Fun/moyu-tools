import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { loadSharp } from '../lib/lazyModules.js'
import { sanitizeFileBaseName } from '../lib/outputPath.js'
import { runFormatProcess } from '../lib/spawnProcess.js'

// 音视频/图片格式工厂：文件登记、FFmpeg 调用、批处理进度与取消、结果保存。

export const FORMAT_EXTENSIONS = {
  video: new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v']),
  audio: new Set(['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg', '.opus', '.wma']),
  image: new Set(['.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.gif', '.avif'])
}
export const FORMAT_MAX_FILES = 100
export const FORMAT_MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024
const FORMAT_ACTIONS = new Map([
  ['视频转换', 'video-convert'],
  ['视频压缩', 'video-compress'],
  ['抽取音频', 'extract-audio'],
  ['音频转换', 'audio-convert'],
  ['图片转换', 'image-convert'],
  ['图片压缩', 'image-compress']
])

const formatInputSessions = new Map()
const formatResultSessions = new Map()
const formatTasks = new Map()

function getFormatResultDirectory(app) {
  return join(app.getPath('userData'), 'format-results')
}

function getFormatToolPath(app, tool) {
  const override = tool === 'ffmpeg'
    ? process.env.MOYU_FFMPEG_PATH
    : process.env.MOYU_FFPROBE_PATH
  if (!app.isPackaged && override) return override
  if (process.platform !== 'win32') {
    throw new Error('音视频格式工厂当前只随 Windows 发布包提供')
  }
  const fileName = `${tool}.exe`
  return app.isPackaged
    ? join(process.resourcesPath, 'tools', 'ffmpeg', fileName)
    : join(app.getAppPath(), 'build', 'ffmpeg', fileName)
}

function normalizeFormatKind(value) {
  if (!Object.hasOwn(FORMAT_EXTENSIONS, value)) throw new Error('不支持的格式工厂输入类型')
  return value
}

function getFormatInput(event, inputId) {
  const input = formatInputSessions.get(inputId)
  if (!input || input.ownerId !== event.sender.id) {
    throw new Error('格式工厂文件会话不存在或无权访问')
  }
  return input
}

function getFormatResult(event, resultId) {
  const result = formatResultSessions.get(resultId)
  if (!result || result.ownerId !== event.sender.id) {
    throw new Error('格式工厂结果会话不存在或无权访问')
  }
  return result
}

export async function registerFormatInput(filePath, ownerId, kind) {
  const extension = extname(filePath).toLowerCase()
  if (!FORMAT_EXTENSIONS[kind].has(extension)) {
    throw new Error(`${basename(filePath)} 不是受支持的${kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '图片'}文件`)
  }
  const info = await stat(filePath)
  if (!info.isFile() || info.size > FORMAT_MAX_FILE_BYTES) {
    throw new Error(`${basename(filePath)} 不是文件或超过 4 GB`)
  }

  const id = randomUUID()
  let dimensions = null
  let previewData = null
  if (kind === 'image') {
    const metadata = await (await loadSharp())(filePath, { animated: true }).metadata()
    dimensions = {
      width: metadata.width || 0,
      height: metadata.height || 0
    }
    previewData = new Uint8Array(
      await (await loadSharp())(filePath, { animated: true })
        .resize({ width: 320, height: 240, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer()
    )
  }

  const input = {
    id,
    ownerId,
    path: filePath,
    name: basename(filePath),
    size: info.size,
    kind,
    extension,
    dimensions
  }
  formatInputSessions.set(id, input)
  return {
    id,
    name: input.name,
    size: input.size,
    kind,
    dimensions,
    previewData
  }
}

function sanitizeProcessError(error, paths = []) {
  let message = error instanceof Error ? error.message : String(error)
  paths.filter(Boolean).forEach((filePath) => {
    message = message.replaceAll(filePath, basename(filePath))
  })
  const normalized = message.toLowerCase()
  if (normalized.includes('no space left on device') || normalized.includes('disk full')) {
    return '磁盘空间不足，请清理输出磁盘后重试'
  }
  if (normalized.includes('permission denied') || normalized.includes('read-only file system')) {
    return '没有写入权限，请更换输出位置'
  }
  if (normalized.includes('invalid data found') || normalized.includes('moov atom not found') ||
      normalized.includes('error while decoding')) {
    return '输入文件已损坏或编码格式无法读取'
  }
  if (normalized.includes('unknown encoder') || normalized.includes('encoder not found')) {
    return '发布包缺少所需编码器，请重新安装完整版本'
  }
  if (normalized.includes('does not contain any stream') || normalized.includes('matches no streams') ||
      normalized.includes('output file does not contain any stream')) {
    return '输入文件没有可用的音轨'
  }
  if (normalized.includes('timed out') || normalized.includes('执行超时')) {
    return '转换超时，请检查文件是否损坏或尝试较小文件'
  }
  return message.slice(-2000)
}

async function probeFormatMedia(app, input) {
  const result = await runFormatProcess(
    getFormatToolPath(app, 'ffprobe'),
    [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      input.path
    ],
    { timeoutMs: 3000 }
  )
  const data = JSON.parse(result.stdout)
  const video = data.streams?.find((stream) => stream.codec_type === 'video')
  const audio = data.streams?.find((stream) => stream.codec_type === 'audio')
  return {
    duration: Number(data.format?.duration) || 0,
    bitrate: Number(data.format?.bit_rate) || 0,
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0,
    videoCodec: video?.codec_name || '',
    audioCodec: audio?.codec_name || '',
    sampleRate: Number(audio?.sample_rate) || 0
  }
}

function parseFfmpegTime(value) {
  const match = String(value).match(/(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (!match) return 0
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

function buildFfmpegArgs(action, input, outputPath, options) {
  const target = String(options?.target || '').toLowerCase()
  const quality = Math.min(35, Math.max(18, Number(options?.quality) || 23))
  const bitrate = Math.min(320, Math.max(64, Number(options?.audioBitrate) || 192))
  const sampleRate = [32000, 44100, 48000].includes(Number(options?.sampleRate))
    ? Number(options.sampleRate)
    : 44100
  const maxWidth = Math.min(3840, Math.max(0, Number(options?.maxWidth) || 0))
  const scaleArgs = maxWidth ? ['-vf', `scale='min(${maxWidth},iw)':-2`] : []

  if (action === 'video-convert') {
    if (!['mp4', 'mkv', 'webm'].includes(target)) throw new Error('不支持的视频输出格式')
    return target === 'webm'
      ? ['-y', '-i', input.path, ...scaleArgs, '-c:v', 'libvpx-vp9', '-crf', String(quality), '-b:v', '0', '-c:a', 'libopus', outputPath]
      : ['-y', '-i', input.path, ...scaleArgs, '-c:v', 'libx264', '-crf', String(quality), '-preset', 'medium', '-c:a', 'aac', '-b:a', `${bitrate}k`, outputPath]
  }
  if (action === 'video-compress') {
    return ['-y', '-i', input.path, ...scaleArgs, '-c:v', 'libx264', '-crf', String(quality), '-preset', 'medium', '-c:a', 'aac', '-b:a', `${bitrate}k`, '-movflags', '+faststart', outputPath]
  }
  if (action === 'extract-audio' || action === 'audio-convert') {
    const prefix = ['-y', '-i', input.path, '-vn', '-ar', String(sampleRate)]
    if (target === 'mp3') return [...prefix, '-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, outputPath]
    if (target === 'aac' || target === 'm4a') return [...prefix, '-c:a', 'aac', '-b:a', `${bitrate}k`, outputPath]
    if (target === 'wav') return [...prefix, '-c:a', 'pcm_s16le', outputPath]
    if (target === 'flac') return [...prefix, '-c:a', 'flac', outputPath]
    throw new Error('不支持的音频输出格式')
  }
  throw new Error('不支持的 FFmpeg 任务')
}

function formatOutputExtension(action, options, input) {
  const target = String(options?.target || '').toLowerCase()
  if (action === 'video-compress') return 'mp4'
  if (['video-convert', 'extract-audio', 'audio-convert', 'image-convert'].includes(action)) {
    return target === 'jpeg' ? 'jpg' : target
  }
  if (action === 'image-compress') {
    return input.extension === '.jpeg' ? 'jpg' : input.extension.slice(1)
  }
  throw new Error('无法确定输出格式')
}

async function processFormatImage(action, input, outputPath, options) {
  const target = formatOutputExtension(action, options, input)
  const quality = Math.min(100, Math.max(10, Number(options?.quality) || 82))
  const maxWidth = Math.min(12000, Math.max(0, Number(options?.maxWidth) || 0))
  let pipeline = (await loadSharp())(input.path, { animated: target === 'gif', limitInputPixels: 400_000_000 })
    .rotate()
  if (maxWidth) {
    pipeline = pipeline.resize({
      width: maxWidth,
      fit: 'inside',
      withoutEnlargement: true
    })
  }
  if (target === 'jpg') pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true })
  else if (target === 'png') pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true })
  else if (target === 'webp') pipeline = pipeline.webp({ quality, effort: 5 })
  else if (target === 'avif') pipeline = pipeline.avif({ quality, effort: 5 })
  else if (target === 'tif' || target === 'tiff') pipeline = pipeline.tiff({ compression: 'lzw', quality })
  else if (target === 'gif') pipeline = pipeline.gif({ effort: 7, colours: Math.max(32, Math.round(quality * 2.56)) })
  else throw new Error('不支持的图片输出格式')
  const info = await pipeline.toFile(outputPath)
  return { width: info.width, height: info.height, format: info.format }
}

async function registerFormatResult(event, outputPath, input, metadata = null) {
  const info = await stat(outputPath)
  const id = randomUUID()
  const result = {
    id,
    ownerId: event.sender.id,
    path: outputPath,
    name: basename(outputPath),
    size: info.size,
    inputId: input.id,
    inputName: input.name,
    metadata
  }
  formatResultSessions.set(id, result)
  return {
    id,
    inputId: input.id,
    inputName: input.name,
    name: result.name,
    size: result.size,
    metadata
  }
}

/**
 * 注册格式工厂相关 IPC。行为与拆分前逐字一致，只是把散落在
 * src/main/index.js 里、跟其它业务（Illustrator/COM/条码等）交错的
 * 格式工厂代码收拢到一起。
 */
export function registerFormatFactoryHandlers({ ipcMain, dialog, BrowserWindow, app, assertMainWindowSender }) {
  ipcMain.handle('format:get-status', async (event) => {
    assertMainWindowSender(event)
    let ffmpegReady = false
    let ffmpegMessage = ''
    let ffmpegVersion = ''
    let missingEncoders = []
    try {
      const [ffmpegPath, ffprobePath] = [
        getFormatToolPath(app, 'ffmpeg'),
        getFormatToolPath(app, 'ffprobe')
      ]
      const [ffmpegInfo, ffprobeInfo] = await Promise.all([
        stat(ffmpegPath).catch(() => null),
        stat(ffprobePath).catch(() => null)
      ])
      ffmpegReady = Boolean(ffmpegInfo?.isFile() && ffprobeInfo?.isFile())
      if (!ffmpegReady) {
        ffmpegMessage = '请先执行 npm run build:tools:win'
      } else {
        const [versionResult, encodersResult] = await Promise.all([
          runFormatProcess(ffmpegPath, ['-version'], { timeoutMs: 5000 }),
          runFormatProcess(ffmpegPath, ['-hide_banner', '-encoders'], { timeoutMs: 8000 })
        ])
        ffmpegVersion = versionResult.stdout.split(/\r?\n/, 1)[0].trim()
        const requiredEncoders = ['libx264', 'libvpx-vp9', 'libopus', 'libmp3lame']
        missingEncoders = requiredEncoders.filter((encoder) =>
          !encodersResult.stdout.includes(encoder)
        )
        if (missingEncoders.length) {
          ffmpegReady = false
          ffmpegMessage = `FFmpeg 缺少编码器：${missingEncoders.join('、')}`
        }
      }
    } catch (error) {
      ffmpegMessage = error.message
    }
    return {
      ffmpegReady,
      ffmpegMessage,
      ffmpegVersion,
      missingEncoders,
      sharp: (await loadSharp()).versions,
      platform: process.platform
    }
  })

  ipcMain.handle('format:pick-files', async (event, payload) => {
    assertMainWindowSender(event)
    const kind = normalizeFormatKind(payload?.kind)
    const ownerWindow = BrowserWindow.fromWebContents(event.sender)
    const extensions = [...FORMAT_EXTENSIONS[kind]].map((extension) => extension.slice(1))
    const result = await dialog.showOpenDialog(ownerWindow, {
      title: `选择${kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '图片'}文件`,
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '支持的文件', extensions }]
    })
    if (result.canceled) return { status: 'cancelled', files: [] }
    if (result.filePaths.length > FORMAT_MAX_FILES) {
      throw new Error(`一次最多选择 ${FORMAT_MAX_FILES} 个文件`)
    }
    const files = []
    const errors = []
    for (const filePath of result.filePaths) {
      try {
        files.push(await registerFormatInput(filePath, event.sender.id, kind))
      } catch (error) {
        errors.push(error.message)
      }
    }
    return { status: 'selected', files, errors }
  })

  ipcMain.handle('format:add-paths', async (event, payload) => {
    assertMainWindowSender(event)
    const kind = normalizeFormatKind(payload?.kind)
    const paths = payload?.paths
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > FORMAT_MAX_FILES) {
      throw new Error(`一次只能拖入 1–${FORMAT_MAX_FILES} 个文件`)
    }
    const files = []
    const errors = []
    for (const filePath of paths) {
      try {
        if (typeof filePath !== 'string' || !filePath) throw new Error('文件路径无效')
        files.push(await registerFormatInput(filePath, event.sender.id, kind))
      } catch (error) {
        errors.push(error.message)
      }
    }
    return { status: 'selected', files, errors }
  })

  ipcMain.handle('format:pick-folder', async (event, payload) => {
    assertMainWindowSender(event)
    const kind = normalizeFormatKind(payload?.kind)
    const ownerWindow = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(ownerWindow, {
      title: '选择批量转换文件夹',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return { status: 'cancelled', files: [] }
    const directory = result.filePaths[0]
    const entries = await readdir(directory, { withFileTypes: true })
    const candidates = entries
      .filter((entry) => entry.isFile() && FORMAT_EXTENSIONS[kind].has(extname(entry.name).toLowerCase()))
      .slice(0, FORMAT_MAX_FILES)
    const files = []
    const errors = []
    for (const entry of candidates) {
      try {
        files.push(await registerFormatInput(join(directory, entry.name), event.sender.id, kind))
      } catch (error) {
        errors.push(error.message)
      }
    }
    return {
      status: 'selected',
      files,
      errors,
      truncated: candidates.length === FORMAT_MAX_FILES
    }
  })

  ipcMain.handle('format:remove-inputs', (event, inputIds) => {
    assertMainWindowSender(event)
    const ids = Array.isArray(inputIds) ? inputIds : []
    let removed = 0
    ids.forEach((id) => {
      const input = formatInputSessions.get(id)
      if (input?.ownerId === event.sender.id) {
        formatInputSessions.delete(id)
        removed += 1
      }
    })
    return { status: 'removed', count: removed }
  })

  ipcMain.handle('format:run', async (event, payload) => {
    assertMainWindowSender(event)
    const action = FORMAT_ACTIONS.get(payload?.action)
    if (!action) throw new Error('不支持的格式工厂任务')
    const inputIds = Array.isArray(payload?.inputIds) ? payload.inputIds : []
    if (!inputIds.length || inputIds.length > FORMAT_MAX_FILES) {
      throw new Error(`任务文件数量必须在 1–${FORMAT_MAX_FILES} 之间`)
    }
    const inputs = inputIds.map((id) => getFormatInput(event, id))
    const expectedKind = action.startsWith('video') || action === 'extract-audio'
      ? 'video'
      : action.startsWith('audio')
        ? 'audio'
        : 'image'
    if (inputs.some((input) => input.kind !== expectedKind)) {
      throw new Error('任务中包含与当前功能不匹配的文件')
    }

    const taskId = typeof payload?.taskId === 'string' && payload.taskId.length <= 80
      ? payload.taskId
      : randomUUID()
    if (formatTasks.has(taskId)) throw new Error('已有同名格式转换任务正在执行')
    const task = {
      id: taskId,
      ownerId: event.sender.id,
      cancelled: false,
      process: null
    }
    formatTasks.set(taskId, task)
    const outputDirectory = join(getFormatResultDirectory(app), randomUUID())
    await mkdir(outputDirectory, { recursive: true })
    const results = []
    const errors = []

    try {
      for (const [index, input] of inputs.entries()) {
        if (task.cancelled) return { status: 'cancelled', taskId, results, errors }
        const extension = formatOutputExtension(action, payload?.options, input)
        const base = sanitizeFileBaseName(basename(input.name, extname(input.name)), `file-${index + 1}`)
        const suffix = action.includes('compress') ? 'compressed' : extension
        const outputPath = join(outputDirectory, `${base}-${suffix}.${extension}`)
        event.sender.send('format:progress', {
          taskId,
          status: 'running',
          inputId: input.id,
          completed: index,
          total: inputs.length,
          fileProgress: 0,
          name: input.name
        })

        try {
          let metadata
          if (input.kind === 'image') {
            metadata = await processFormatImage(action, input, outputPath, payload?.options)
            event.sender.send('format:progress', {
              taskId,
              status: 'running',
              inputId: input.id,
              completed: index,
              total: inputs.length,
              fileProgress: 1,
              name: input.name
            })
          } else {
            const sourceMetadata = await probeFormatMedia(app, input)
            if (action === 'extract-audio' && !sourceMetadata.audioCodec) {
              throw new Error('输入文件没有可用的音轨')
            }
            let stderrBuffer = ''
            const args = buildFfmpegArgs(action, input, outputPath, payload?.options)
            await runFormatProcess(getFormatToolPath(app, 'ffmpeg'), args, {
              task,
              onStderr: (chunk) => {
                stderrBuffer = `${stderrBuffer}${chunk}`.slice(-2000)
                const matches = [...stderrBuffer.matchAll(/time=(\d+:\d+:\d+(?:\.\d+)?)/g)]
                const seconds = matches.length ? parseFfmpegTime(matches.at(-1)[1]) : 0
                const fileProgress = sourceMetadata.duration
                  ? Math.min(0.99, seconds / sourceMetadata.duration)
                  : 0
                event.sender.send('format:progress', {
                  taskId,
                  status: 'running',
                  inputId: input.id,
                  completed: index,
                  total: inputs.length,
                  fileProgress,
                  name: input.name
                })
              }
            })
            metadata = await probeFormatMedia(app, { path: outputPath })
          }
          results.push(await registerFormatResult(event, outputPath, input, metadata))
        } catch (error) {
          if (error.message === 'TASK_CANCELLED') {
            return { status: 'cancelled', taskId, results, errors }
          }
          errors.push({
            inputId: input.id,
            name: input.name,
            message: sanitizeProcessError(error, [input.path, outputPath])
          })
        }

        event.sender.send('format:progress', {
          taskId,
          status: 'running',
          inputId: input.id,
          completed: index + 1,
          total: inputs.length,
          fileProgress: 1,
          name: input.name
        })
      }
      event.sender.send('format:progress', {
        taskId,
        status: 'complete',
        completed: inputs.length,
        total: inputs.length,
        fileProgress: 1
      })
      return { status: 'complete', taskId, results, errors }
    } finally {
      formatTasks.delete(taskId)
    }
  })

  ipcMain.handle('format:cancel', (event, taskId) => {
    assertMainWindowSender(event)
    const task = formatTasks.get(taskId)
    if (!task || task.ownerId !== event.sender.id) return { status: 'not-running' }
    task.cancelled = true
    if (task.process && !task.process.killed) task.process.kill()
    return { status: 'cancelling' }
  })

  ipcMain.handle('format:save-results', async (event, resultIds) => {
    assertMainWindowSender(event)
    const ids = Array.isArray(resultIds) ? resultIds : []
    if (!ids.length || ids.length > FORMAT_MAX_FILES) throw new Error('没有可保存的转换结果')
    const results = ids.map((id) => getFormatResult(event, id))
    const ownerWindow = BrowserWindow.fromWebContents(event.sender)

    if (results.length === 1) {
      const result = results[0]
      const extension = extname(result.name).slice(1)
      const selection = await dialog.showSaveDialog(ownerWindow, {
        title: '保存格式转换结果',
        defaultPath: result.name,
        filters: [{ name: `${extension.toUpperCase()} 文件`, extensions: [extension] }]
      })
      if (selection.canceled || !selection.filePath) return { status: 'cancelled', saved: 0 }
      await copyFile(result.path, selection.filePath)
      return { status: 'saved', saved: 1, path: selection.filePath }
    }

    const selection = await dialog.showOpenDialog(ownerWindow, {
      title: '选择格式转换结果保存文件夹',
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    })
    if (selection.canceled || !selection.filePaths[0]) return { status: 'cancelled', saved: 0 }
    const directory = selection.filePaths[0]
    const usedNames = new Map()
    for (const [index, result] of results.entries()) {
      const key = result.name.toLocaleLowerCase('en-US')
      const occurrence = (usedNames.get(key) || 0) + 1
      usedNames.set(key, occurrence)
      const extension = extname(result.name)
      const base = basename(result.name, extension)
      const uniqueName = occurrence === 1 ? result.name : `${base}-${occurrence}${extension}`
      await copyFile(result.path, join(directory, uniqueName))
      event.sender.send('format:progress', {
        status: 'saving',
        completed: index + 1,
        total: results.length,
        name: uniqueName
      })
    }
    return { status: 'saved', saved: results.length, directory }
  })
}

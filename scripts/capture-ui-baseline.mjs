// UI 基线截图（V0）
//
// 为什么必须先拍：改造后只有 After 的话，无法判断"变好了"还是"只是变了"。
// 有了同尺寸同 DPR 的 Before，逐图对比才有意义。
//
// 用法：node scripts/capture-ui-baseline.mjs [输出目录] [选项]
//   --width=960 --height=640 --dpr=2   锁定视口（默认 1440×900 / DPR 2）
//   --shell                            只拍外壳：各模块默认态、一级栏悬停、
//                                      搜索弹层、头像菜单；跳过画布和独立窗口
// 默认输出到 scope/ui-baseline/<宽>x<高>/（scope 不入 Git）
//
// ⚠ 窗口尺寸与 DPR 固定并记进 manifest：After 必须用同一组参数重拍，
//   否则两张图尺寸不同，差异里混着布局重排，看不出真正的视觉变化。
import { spawn } from 'node:child_process'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const positional = args.filter((arg) => !arg.startsWith('--'))
const flag = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const hasFlag = (name) => args.includes(`--${name}`)
const WINDOW = {
  width: Number(flag('width', 1440)),
  height: Number(flag('height', 900)),
  dpr: Number(flag('dpr', 2))
}
const SHELL_ONLY = hasFlag('shell')
const OUT = resolve(positional[0] || `scope/ui-baseline/${WINDOW.width}x${WINDOW.height}`)
const PORT = 9411

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let shots = 0

// ⚠ npx 只是包装进程，kill 它杀不掉真正的 Electron——残留的实例会占着单实例锁，
//   下一次启动（包括手动 npm run dev）会直接退出。所以放进独立进程组，退出时整组杀掉。
const app = spawn('npx', ['electron', `--remote-debugging-port=${PORT}`, 'out/main/index.js'],
  { stdio: 'ignore', detached: true })
process.on('exit', () => {
  try { process.kill(-app.pid, 'SIGKILL') } catch { app.kill('SIGKILL') }
})

async function connect(pick) {
  for (let i = 0; i < 80; i += 1) {
    const list = await fetch(`http://localhost:${PORT}/json`).then((r) => r.json()).catch(() => [])
    const target = list.find(pick)
    if (target) {
      const ws = new WebSocket(target.webSocketDebuggerUrl)
      await new Promise((r) => ws.addEventListener('open', r, { once: true }))
      let id = 0
      const pending = new Map()
      ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data)
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
      })
      const send = (method, params = {}) => new Promise((res, rej) => {
        const i2 = ++id
        const timer = setTimeout(() => { pending.delete(i2); rej(new Error(`CDP ${method} 无响应`)) }, 60000)
        pending.set(i2, (m) => { clearTimeout(timer); res(m) })
        ws.send(JSON.stringify({ id: i2, method, params }))
      })
      const ev = (expr) => send('Runtime.evaluate',
        { expression: expr, returnByValue: true, awaitPromise: true, includeCommandLineAPI: true })
        .then((r) => {
          if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description)
          return r.result.result.value
        })
      await send('Runtime.enable')
      await send('DOM.enable')
      return { send, ev, ws }
    }
    await sleep(400)
  }
  return null
}

async function shot(conn, name) {
  // ⚠ 摸鱼计时器每分钟跳一次。不固定的话，跨分钟拍的两张必然有差异，
  //   而且它在右上角，会把差异包围盒撑到整幅图宽，掩盖真正的改动区域。
  await conn.send('Runtime.evaluate', {
    expression: `(() => { const t = document.querySelector('#mochi-time'); if (t) t.textContent = '00:00'; return 1 })()`
  }).catch(() => {})
  const r = await conn.send('Page.captureScreenshot', { format: 'png' })
  const buf = Buffer.from(r.result.data, 'base64')
  const file = join(OUT, `${String(++shots).padStart(2, '0')}-${name}.png`)
  await writeFile(file, buf)
  // 从 PNG 的 IHDR 直接读真实像素尺寸。manifest 里写的期望值可能与实际
  // 不符（我第一版就写错过），以图本身为准才靠得住。
  const px = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  console.log(`  📸 ${name.padEnd(26)} ${px.width}×${px.height}`)
  return px
}

const manifest = { 拍摄时间: new Date().toISOString(), 窗口尺寸: WINDOW, 图: [] }
let lastPx = null
const record = (name, note) => manifest.图.push({
  文件: `${String(shots).padStart(2, '0')}-${name}.png`, 说明: note, 像素: lastPx })

try {
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })

  const M = await connect((x) => x.url.includes('index.html') === false && x.type === 'node')
  const P = await connect((x) => x.url.includes('index.html'))
  if (!P) throw new Error('连不上主窗口')

  // ⚠ 必须**真的**固定视口，不能只在常量里写一个数字然后记进 manifest。
  //   应用的默认窗口大小随机器和上次退出状态变化，不固定的话 After 换台
  //   机器重拍就是另一个尺寸，逐图对比里混着布局重排，看不出视觉变化。
  //   用 setDeviceMetricsOverride 而不是改 OS 窗口：它连 DPR 一起锁死，
  //   且不受实际屏幕大小限制。
  await P.send('Emulation.setDeviceMetricsOverride', {
    width: WINDOW.width, height: WINDOW.height,
    deviceScaleFactor: WINDOW.dpr, mobile: false
  })
  await sleep(600)
  const info = await P.ev(`(() => ({ dpr: window.devicePixelRatio,
    inner: [innerWidth, innerHeight], ua: navigator.platform }))()`)
  manifest.实测视口 = info.inner
  manifest.DPR = info.dpr
  manifest.平台 = info.ua
  console.log(`主窗口视口 ${info.inner.join('×')} · DPR ${info.dpr} · ${info.ua}`)
  if (info.inner[0] !== WINDOW.width || info.inner[1] !== WINDOW.height) {
    console.log(`  ⚠ 视口未锁到预期值（期望 ${WINDOW.width}×${WINDOW.height}），After 必须核对本行`)
  }

  await P.ev(`window.confirm = () => true; true`)
  await sleep(1200)

  const MODULES = [
    ['home', '主页'], ['pdf', 'PDF'], ['ai', 'Adobe'], ['bc', '条码'],
    ['image', '图片画布'], ['video', '格式工厂'], ['dieline', '刀模'],
    ['erp', '库存'], ['custom', '定制'], ['more', '设置']
  ]

  /** 切模块：优先点一级栏；「设置」在一级栏移除后改走头像菜单。 */
  async function openModule(module) {
    const route = await P.ev(`(async () => {
      const nav = document.querySelector('.nav-ic[data-module="${module}"]')
      if (nav) { nav.click(); return 'nav' }
      if ('${module}' === 'more') {
        const avatar = document.querySelector('.profile-avatar, #profile-avatar')
        if (avatar) {
          avatar.click()
          await new Promise(r => setTimeout(r, 150))
          const item = document.querySelector('#profile-menu [data-profile-action="settings"]')
          if (item) { item.click(); return 'profile-menu' }
        }
        const trigger = document.querySelector('.topbar-search-btn')
        if (trigger) {
          trigger.click()
          await new Promise(r => setTimeout(r, 200))
          const input = document.querySelector('#search-dialog input, #feature-search')
          if (input) {
            input.value = '主题'
            input.dispatchEvent(new Event('input', { bubbles: true }))
            await new Promise(r => setTimeout(r, 250))
            const result = [...document.querySelectorAll('.search-result')]
              .find((button) => button.textContent.includes('主题'))
            if (result) { result.click(); return 'search' }
          }
        }
      }
      return null
    })()`)
    if (!route) console.log(`  ⚠ 找不到进入「${module}」的入口`)
    return route
  }

  function moduleSettleTime(module) {
    if (module === 'image') return 1400
    if (module === 'dieline') return 2200
    if (module === 'erp' || module === 'custom') return 1600
    return 700
  }

  /** 搜索：S6 前是顶栏常驻输入框，S6 后是顶栏图标 + 居中弹窗。 */
  async function openSearch() {
    return P.ev(`(() => {
      const trigger = document.querySelector('.topbar-search-btn')
      if (trigger) { trigger.click(); return 'trigger' }
      const input = document.querySelector('#feature-search')
      if (input) { input.focus(); return 'input' }
      return null
    })()`)
  }

  async function typeSearchQuery(query) {
    return P.ev(`(() => {
      const input = document.querySelector('#search-dialog input, #feature-search')
      if (!input) return false
      input.value = ${JSON.stringify(query)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
  }

  async function closeTransientLayer() {
    await P.ev(`(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      document.body.click()
      const input = document.querySelector('#search-dialog input, #feature-search')
      if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })) }
      return true
    })()`).catch(() => {})
    await sleep(250)
  }

  for (const theme of ['light', 'dark']) {
    console.log(`\n── ${theme === 'light' ? '亮色' : '暗色'}主题 ─────────────`)
    await P.ev(`document.body.dataset.theme = '${theme}'; true`)
    await sleep(400)

    for (const [mod, label] of MODULES) {
      await openModule(mod)
      await sleep(moduleSettleTime(mod))
      lastPx = await shot(P, `${theme}-${mod}-默认`)
      record(`${theme}-${mod}-默认`, `${label} 模块 · 默认状态`)
    }

    if (SHELL_ONLY) {
      // 一级栏悬停：先回条码页，再真实移动指针
      await openModule('bc')
      await sleep(500)
      const navBox = await P.ev(`(() => {
        const b = document.querySelector('.nav-ic[data-module="bc"]').getBoundingClientRect()
        return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } })()`)
      await P.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: navBox.x, y: navBox.y })
      await sleep(800)
      lastPx = await shot(P, `${theme}-悬停-一级栏`)
      record(`${theme}-悬停-一级栏`, '一级栏悬停 Tooltip')
      await P.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 500 })
      await sleep(250)

      const searchOpened = await openSearch()
      if (searchOpened) {
        await sleep(350)
        await typeSearchQuery('水印')
        await sleep(400)
        lastPx = await shot(P, `${theme}-搜索-水印`)
        record(`${theme}-搜索-水印`, '搜索「水印」结果')
        await closeTransientLayer()
      } else {
        console.log('  ⚠ 未找到搜索入口')
        manifest.缺失 = [...(manifest.缺失 || []), `${theme}-搜索`]
      }

      const hasProfile = await P.ev(`Boolean(document.querySelector('.profile-avatar, #profile-avatar'))`)
      if (hasProfile) {
        await P.ev(`document.querySelector('.profile-avatar, #profile-avatar').click(); true`)
        await sleep(400)
        lastPx = await shot(P, `${theme}-头像菜单`)
        record(`${theme}-头像菜单`, '头像菜单打开态')
        await closeTransientLayer()
      } else {
        console.log('  ⚠ 未找到头像入口（S4 之前属预期）')
        manifest.缺失 = [...(manifest.缺失 || []), `${theme}-头像菜单`]
      }
      continue
    }

    // ── 关键状态：只在最有代表性的模块上拍，避免 24 张里一半是重复 ──
    await openModule('image')
    await sleep(1200)

    // 弹层打开
    await P.ev(`(async () => {
      document.querySelector('#cmd-project').click()
      await new Promise(r => setTimeout(r, 300)); return true })()`)
    lastPx = await shot(P, `${theme}-弹层-项目菜单`)
    record(`${theme}-弹层-项目菜单`, '下拉弹层打开态')
    await P.ev(`document.body.click(); true`); await sleep(300)

    // 选中 + 浮动工具栏 + 禁用态
    await P.ev(`(async () => {
      document.querySelector('#board-add-textbox').click()
      await new Promise(r => setTimeout(r, 900)); return true })()`)
    lastPx = await shot(P, `${theme}-选中-文本工具栏`)
    record(`${theme}-选中-文本工具栏`, '对象选中 · 横向工具栏 · 撤销/重做禁用态')

    // 悬停：用 CSS 类模拟不可靠，改为真实移动指针到主导航
    const navBox = await P.ev(`(() => {
      const b = document.querySelector('.nav-ic[data-module="bc"]').getBoundingClientRect()
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } })()`)
    await P.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: navBox.x, y: navBox.y })
    await sleep(700) // 等原生 tooltip 出现——它正是 V5 要替换的东西
    lastPx = await shot(P, `${theme}-悬停-主导航`)
    record(`${theme}-悬停-主导航`, '悬停态 + 原生 title tooltip（V5 将替换）')
    await P.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 500 })
    await sleep(300)

    // 图片编辑器（图标最密集的地方）
    await P.ev(`(async () => {
      document.querySelector('#cmd-project').click(); await new Promise(r => setTimeout(r, 200))
      document.querySelector('#project-menu [data-project="new"]').click()
      await new Promise(r => setTimeout(r, 1000)); return true })()`)
  }

  if (!SHELL_ONLY) {
    // ── 独立窗口：截图覆盖层 ──────────────────────────────────
    console.log('\n── 独立窗口 ─────────────────────')
    await P.ev(`document.body.dataset.theme = 'light'; true`)
    await P.ev(`window.api.startScreenshot(); true`).catch(() => {})
    const overlay = await connect((x) => x.url.includes('screenshot.html'))
    if (overlay) {
      await sleep(900)
      lastPx = await shot(overlay, 'screenshot-覆盖层')
      record('screenshot-覆盖层', '区域截图覆盖层（独立窗口）')
      await overlay.ev(`window.api.cancelScreenshot(new URLSearchParams(location.search).get('session'))`)
        .catch(() => {})
      overlay.ws.close()
    } else {
      console.log('  ⚠ 未能打开截图覆盖层（可能缺少录屏权限），该项基线缺失')
      manifest.缺失 = [...(manifest.缺失 || []), 'screenshot.html']
    }
    await sleep(1200)

    // ── 独立窗口：钉图 ───────────────────────────────────────
    await P.ev(`(async () => {
      const c = document.createElement('canvas'); c.width = 420; c.height = 280
      const g = c.getContext('2d')
      g.fillStyle = '#6978e6'; g.fillRect(0, 0, 420, 280)
      g.fillStyle = '#fff'; g.font = '24px sans-serif'; g.fillText('钉图基线', 130, 150)
      const blob = await new Promise(r => c.toBlob(r, 'image/png'))
      await window.api.pinScreenshot(new Uint8Array(await blob.arrayBuffer()))
      return true
    })()`).catch((e) => console.log('  ⚠ 钉图失败：' + e.message))
    const pin = await connect((x) => x.url.includes('pin.html'))
    if (pin) {
      await sleep(800)
      lastPx = await shot(pin, 'pin-钉图窗口')
      record('pin-钉图窗口', '桌面钉图（独立窗口）')
      await pin.ev(`window.api.closePinnedScreenshot(new URLSearchParams(location.search).get('pin'))`)
        .catch(() => {})
      pin.ws.close()
    } else {
      console.log('  ⚠ 未能打开钉图窗口，该项基线缺失')
      manifest.缺失 = [...(manifest.缺失 || []), 'pin.html']
    }
  }

  await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  console.log(`\n共 ${shots} 张，输出到 ${OUT}`)
  console.log('manifest.json 记录了窗口尺寸与 DPR —— After 必须用同一组参数重拍。')
  P.ws.close(); M?.ws.close()
} catch (error) {
  console.error(`\n❌ 采集失败：${error.message}`)
  process.exitCode = 1
} finally {
  app.kill('SIGKILL')
}

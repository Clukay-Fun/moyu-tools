// 样式地图（UI 基础设施 · 第一步）
//
// 用法：node scripts/style-report.mjs [--json] [--out <文件>] [--catalog]
//   --catalog  重新生成组件目录读取的动效清单 docs/ui/motion-inventory.js
//
// 回答三个问题：现在有多少规则、分别属于哪个模块、哪些值本该是变量却写死了。
// 报告必须能随代码重跑——手工清单两周就过期，没人会再维护。
//
// ⚠ 这里用的是"够用就好"的花括号解析，不是完整 CSS 解析器：
//   样式表里没有嵌套语法（原生 CSS nesting），只有 @media / @supports 这类条件组，
//   按层级计数即可。真引入嵌套语法时这个脚本要改。
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cssPath = join(root, 'src/renderer/style.css')
function cssFilesInOrder(path) {
  const source = readFileSync(path, 'utf8')
  const imports = [...source.matchAll(/^@import url\(['"](.+?)['"]\);\s*$/gm)]
  if (!imports.length) return [{ path, css: source }]
  return imports.flatMap((match) => cssFilesInOrder(resolve(dirname(path), match[1])))
}
const cssFiles = cssFilesInOrder(cssPath)
const css = cssFiles.map((file) => file.css).join('\n')

// 选择器前缀 → 模块。顺序有意义：先匹配到的算数。
const MODULES = [
  ['条码', /^\.?(barcode|bc-|itf14|gs1)/],
  ['刀模', /^\.?(dieline|page-dieline)/],
  ['PDF', /^\.?(pdf|page-pdf)/],
  ['画布/图片编辑', /^\.?(board|canvas|image-|artboard|layer|eraser|crop)/],
  ['格式工厂', /^\.?(format|video-)/],
  ['截图/钉图', /^\.?(shot|screenshot|pin-|capture)/],
  ['设置', /^\.?(settings|setting-|shortcut|theme-|accent|update|about|github-link|version-)/],
  ['Illustrator', /^\.?(illustrator|ai-)/],
  ['搜索', /^\.?search/],
  ['导航/外壳', /^\.?(topbar|rail|nav-|panel|app-body|window-shell|brand|content$|pages$|page$|orbs?|mochi|slogan|home-)/]
]

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 展平成 { selector, body, atRule } 列表 */
function parseRules(text, atRule = null) {
  const rules = []
  let index = 0
  let prelude = ''
  while (index < text.length) {
    const char = text[index]
    if (char === '{') {
      let depth = 1
      let end = index + 1
      while (end < text.length && depth > 0) {
        if (text[end] === '{') depth += 1
        else if (text[end] === '}') depth -= 1
        end += 1
      }
      const body = text.slice(index + 1, end - 1)
      const head = prelude.trim()
      if (head.startsWith('@')) {
        // 条件组：里面还是规则
        if (/^@(media|supports|layer|container)/.test(head)) rules.push(...parseRules(body, head))
        else rules.push({ selector: head, body, atRule })   // @keyframes / @font-face 等
      } else if (head) {
        rules.push({ selector: head, body, atRule })
      }
      prelude = ''
      index = end
      continue
    }
    if (char === ';' && !prelude.trim().startsWith('@')) prelude = ''
    else prelude += char
    index += 1
  }
  return rules
}

const rules = parseRules(stripComments(css))

function classOf(selector) {
  const names = selector.match(/\.[A-Za-z][\w-]*/g) || []
  const ids = selector.match(/#[A-Za-z][\w-]*/g) || []
  return [...names, ...ids].map((n) => n.slice(1))
}

function moduleOf(selector) {
  const parts = selector.split(',').map((s) => s.trim())
  const hits = new Set()
  for (const part of parts) {
    const tokens = classOf(part)
    if (!tokens.length) { hits.add('基础/元素'); continue }
    const matched = MODULES.find(([, pattern]) => tokens.some((t) => pattern.test(t)))
    hits.add(matched ? matched[0] : '公共控件')
  }
  return hits.size === 1 ? [...hits][0] : '跨模块共用'
}

// ── 1. 规则分布 ──
const byModule = new Map()
for (const rule of rules) {
  if (rule.selector.startsWith('@')) continue
  const key = moduleOf(rule.selector)
  const entry = byModule.get(key) || { rules: 0, declarations: 0 }
  entry.rules += 1
  entry.declarations += (rule.body.match(/[^;{}]+:[^;{}]+/g) || []).length
  byModule.set(key, entry)
}

// ── 2. 设计变量 ──
const defined = new Map()
for (const match of css.matchAll(/^\s*(--[\w-]+)\s*:\s*([^;]+);/gm)) {
  const list = defined.get(match[1]) || []
  list.push(match[2].trim())
  defined.set(match[1], list)
}
const used = new Map()
for (const match of css.matchAll(/var\(\s*(--[\w-]+)/g)) {
  used.set(match[1], (used.get(match[1]) || 0) + 1)
}
const unusedTokens = [...defined.keys()].filter((token) => !used.has(token))
const undefinedTokens = [...used.keys()].filter((token) => !defined.has(token))

// ── 3. 本该是变量却写死的值 ──
function literalCounts(pattern, { skipInsideVarDef = true } = {}) {
  const counts = new Map()
  for (const rule of rules) {
    for (const declaration of rule.body.split(';')) {
      const [prop, value] = declaration.split(':')
      if (!prop || !value) continue
      if (skipInsideVarDef && prop.trim().startsWith('--')) continue
      for (const match of value.matchAll(pattern)) {
        const key = match[0].toLowerCase()
        counts.set(key, (counts.get(key) || 0) + 1)
      }
    }
  }
  return counts
}

const colors = literalCounts(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)
const radii = literalCounts(/(?<=border-radius:[^;]*?)\b\d+px\b/gi)
const fontSizes = new Map()
for (const rule of rules) {
  for (const declaration of rule.body.split(';')) {
    const [prop, value] = declaration.split(':')
    if (!prop || !value || prop.trim() !== 'font-size') continue
    const literal = value.trim()
    if (literal.startsWith('var(')) continue
    fontSizes.set(literal, (fontSizes.get(literal) || 0) + 1)
  }
}

// ── 4. 重复定义的选择器 ──
const selectorSeen = new Map()
for (const rule of rules) {
  if (rule.selector.startsWith('@')) continue
  const key = `${rule.atRule || ''}|${rule.selector.replace(/\s+/g, ' ')}`
  selectorSeen.set(key, (selectorSeen.get(key) || 0) + 1)
}
const duplicated = [...selectorSeen].filter(([, count]) => count > 1)

// ── 5. 没有出处的类名（HTML 与 JS 里都找不到）──
const sources = ['src/renderer/index.html', 'src/renderer/screenshot.html', 'src/renderer/pin.html']
  .map((file) => readFileSync(join(root, file), 'utf8'))
  .join('\n')
const scripts = []
const walk = (dir) => {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(path)
    else if (/\.(js|mjs)$/.test(entry.name)) scripts.push(readFileSync(join(root, path), 'utf8'))
  }
}
import { readdirSync } from 'node:fs'
walk('src/renderer')
const haystack = sources + scripts.join('\n')
const declaredClasses = new Set()
for (const rule of rules) {
  if (rule.selector.startsWith('@')) continue
  for (const name of rule.selector.match(/\.[A-Za-z][\w-]*/g) || []) declaredClasses.add(name.slice(1))
}
const orphanClasses = [...declaredClasses].filter((name) => !haystack.includes(name)).sort()

// ── 6. 动效清单：每条过渡拆成 属性 / 时长 / 曲线，标出是否走变量 ──
/** 从 start 处的 "name(" 开始，按括号配对截到对应的 ")"，嵌套的 var() 不会被截断 */
function takeBalanced(value, start) {
  let depth = 0
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === '(') depth += 1
    else if (value[index] === ')') {
      depth -= 1
      if (depth === 0) return value.slice(start, index + 1)
    }
  }
  return value.slice(start)
}

function splitTopLevel(value) {
  const parts = []
  let depth = 0
  let current = ''
  for (const char of value) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (char === ',' && depth === 0) { parts.push(current.trim()); current = ''; continue }
    current += char
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}
const motion = []
for (const rule of rules) {
  if (rule.selector.startsWith('@')) continue
  const selector = rule.selector.replace(/\s+/g, ' ')
  for (const declaration of rule.body.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    const prop = declaration.slice(0, colon).trim()
    const value = declaration.slice(colon + 1).trim().replace(/\s+/g, ' ')
    if (prop === 'transform' && selector.includes(':active') && /scale\(/.test(value)) {
      motion.push({ selector, kind: 'press', property: 'transform', value: takeBalanced(value, value.indexOf('scale(')), media: rule.atRule })
    }
    if ((prop !== 'transition' && prop !== 'animation') || value === 'none') continue
    for (const item of splitTopLevel(value)) {
      const duration = (item.match(/var\(--dur-[\w-]+\)|\b[\d.]+m?s\b/) || [''])[0]
      const easingAt = item.search(/var\(--ease-|cubic-bezier\(/)
      const easing = easingAt >= 0
        ? takeBalanced(item, easingAt)
        : (item.match(/\b(ease-in-out|ease-in|ease-out|ease|linear)\b/) || ['ease'])[0]
      const property = item.split(' ')[0]
      motion.push({
        selector,
        kind: prop,
        property,
        duration,
        easing,
        tokenized: duration.startsWith('var(') && (easing.startsWith('var(') || easing === 'ease'),
        media: rule.atRule
      })
    }
  }
}

if (process.argv.includes('--catalog')) {
  const target = join(root, 'docs/ui/motion-inventory.js')
  const banner = '// 由 scripts/style-report.mjs --catalog 生成，请勿手改。组件目录的动效清单读取这里。\n'
  writeFileSync(target, `${banner}window.MOTION_INVENTORY = ${JSON.stringify(motion, null, 2)}\n`)
  console.log(`已写入 ${target}（${motion.length} 条）`)
  process.exit(0)
}

// ── 输出 ──
const top = (map, n = 12) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n)
const report = {
  file: 'src/renderer/style.css',
  lines: css.split('\n').length,
  rules: rules.filter((r) => !r.selector.startsWith('@')).length,
  atRules: rules.filter((r) => r.selector.startsWith('@')).length,
  files: cssFiles.map(({ path, css }) => ({
    file: path.slice(root.length + 1),
    lines: css.split('\n').length,
    rules: parseRules(stripComments(css)).filter((rule) => !rule.selector.startsWith('@')).length
  })),
  modules: Object.fromEntries([...byModule].sort((a, b) => b[1].rules - a[1].rules)),
  tokens: { defined: defined.size, used: used.size, unused: unusedTokens, undefined: undefinedTokens },
  literals: {
    colors: top(colors),
    borderRadius: top(radii),
    fontSize: top(fontSizes)
  },
  motion,
  duplicatedSelectors: duplicated.map(([key, count]) => ({ selector: key.split('|')[1], media: key.split('|')[0] || null, count })),
  orphanClasses
}

if (process.argv.includes('--json')) {
  const outIndex = process.argv.indexOf('--out')
  const json = JSON.stringify(report, null, 2)
  if (outIndex > -1 && process.argv[outIndex + 1]) writeFileSync(process.argv[outIndex + 1], json)
  else console.log(json)
} else {
  const pad = (text, width) => String(text).padEnd(width)
  console.log(`样式地图 · ${report.file}`)
  console.log(`${report.lines} 行 · ${report.rules} 条规则 · ${report.atRules} 条 @ 规则 · ${report.tokens.defined} 个变量\n`)
  console.log('文件分布：')
  for (const file of report.files) console.log(`  ${pad(file.file, 45)} ${file.rules} 条规则`)
  console.log('')
  console.log('规则分布：')
  for (const [name, entry] of Object.entries(report.modules)) {
    console.log(`  ${pad(name, 16)} ${pad(entry.rules + ' 条', 9)} ${entry.declarations} 条声明`)
  }
  console.log(`\n变量：定义 ${report.tokens.defined} · 被引用 ${report.tokens.used}` +
    `${unusedTokens.length ? ` · 定义了没人用 ${unusedTokens.length}：${unusedTokens.join(', ')}` : ''}` +
    `${undefinedTokens.length ? ` · 用了没定义 ${undefinedTokens.length}：${undefinedTokens.join(', ')}` : ''}`)
  console.log('\n写死的高频值（出现 3 次以上的最该收进变量）：')
  for (const [label, list] of [['颜色', report.literals.colors], ['圆角', report.literals.borderRadius], ['字号', report.literals.fontSize]]) {
    const frequent = list.filter(([, count]) => count >= 3)
    if (!frequent.length) continue
    console.log(`  ${label}：${frequent.map(([value, count]) => `${value}×${count}`).join('  ')}`)
  }
  if (report.duplicatedSelectors.length) {
    console.log(`\n同一选择器写了多处（${report.duplicatedSelectors.length} 个，后者覆盖前者，容易改漏）：`)
    for (const item of report.duplicatedSelectors.slice(0, 10)) {
      console.log(`  ${item.selector}${item.media ? `  @ ${item.media}` : ''} ×${item.count}`)
    }
  }
  if (orphanClasses.length) {
    console.log(`\nHTML/JS 里找不到出处的类名（${orphanClasses.length} 个，可能已废弃）：`)
    console.log('  ' + orphanClasses.join(', '))
  }
}

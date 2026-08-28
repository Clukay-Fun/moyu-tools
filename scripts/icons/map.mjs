// 图标映射清单（V1）
//
// 这是**唯一**的图标真值表。只有列在这里的图标才会被抽进 sprite——
// Lucide 有 1112 个图标，全打包进去是几百 KB 的死重量。
//
// 键 = 应用内语义名（symbol id 用 `ic-<键>`），值 = Lucide 文件名。
// 用语义名而不是直接用 Lucide 名：将来换库或换具体图标时，
// 只改这一张表，不用去动几十处 <use href>。
//
// ⚠ V1 只建立清单与 sprite，**不替换任何可见图标**。
//   下面的键有些在 V1 结束时还没有任何 <use> 引用，这是预期的。
export const ICON_MAP = {
  // ── 主导航（V3a）──
  'nav-home': 'home',
  'nav-pdf': 'file-text',
  'nav-adobe': 'pen-tool',
  'nav-barcode': 'barcode',
  'nav-image': 'image',
  'nav-video': 'clapperboard',
  'nav-settings': 'settings',

  // ── V2 第一批：高风险字符与彩色 emoji ──
  settings: 'settings',
  lock: 'lock',
  unlock: 'lock-open',
  delete: 'trash-2',
  copy: 'copy',
  'bring-front': 'bring-to-front',
  'send-back': 'send-to-back',
  undo: 'undo-2',
  redo: 'redo-2',
  'zoom-in': 'zoom-in',
  'zoom-out': 'zoom-out',
  'zoom-fit': 'maximize',
  'zoom-reset': 'scan',
  'collapse-left': 'chevron-left',
  'collapse-right': 'chevron-right',
  search: 'search',
  close: 'x',
  check: 'check',

  // ── 图片编辑器工具（V3a）──
  'tool-crop': 'crop',
  'tool-adjust': 'sliders-horizontal',
  'tool-mosaic': 'grid-2x2',
  'tool-doodle': 'pencil',
  'tool-rect': 'square',
  'tool-ellipse': 'circle',
  'tool-line': 'minus',
  'tool-arrow': 'arrow-up-right',
  'tool-text': 'type',
  'action-restore': 'rotate-ccw',
  'action-ocr': 'scan-text',

  // ── 通用动作（V3a / V4）──
  capture: 'crop',
  import: 'image-plus',
  save: 'save',
  'save-as': 'copy-plus',
  open: 'folder-open',
  export: 'download',
  add: 'plus',
  remove: 'minus',
  play: 'play',
  pin: 'pin',
  edit: 'pencil',
  bold: 'bold',
  'align-left': 'align-left',
  'align-center': 'align-center',
  'align-right': 'align-right',
  'chevron-down': 'chevron-down',
  warning: 'triangle-alert',
  info: 'info',
  keyboard: 'keyboard',
  appearance: 'sun-moon',
  github: 'git-fork',
  'external-link': 'external-link',
  'folder-add': 'folder-plus',
  project: 'folder-cog',
  background: 'palette',
  textbox: 'text-cursor-input',
  clear: 'eraser',
  previous: 'chevron-left',
  next: 'chevron-right',
  stop: 'square',

  // ── 独立窗口：截图覆盖层与钉图（V3a）──
  // ⚠ 与主窗口共用同一份 sprite 和同一套语义名。同一语义只能对一个图标：
  //   "删除"全应用都是 trash-2，"关闭"都是 x，不允许某个窗口自成一套。
  'opacity-down': 'sun-dim',
  'opacity-up': 'sun',
  download: 'download',
  update: 'refresh-cw'
}

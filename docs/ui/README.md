# UI 规范与组件目录

- [`catalog.html`](catalog.html)：组件目录。浏览器直接打开即可，引用的是真实的 `src/renderer/style.css`，浅色 / 深色并排。
- `node scripts/style-report.mjs`：样式地图。统计各模块规则、变量引用、写死的高频值、重复选择器和疑似废弃类名；加 `--json` 输出机器可读结果。

## 样式文件

`src/renderer/style.css` 是唯一入口，按顺序导入 `src/renderer/styles/` 下的子文件。子文件按原样式表的顶层规则边界拆出，编号即原有级联顺序；后段的跨模块补充规则保留在对应的覆盖文件中。修改已有规则时先定位所属子文件，不要仅按文件名移动规则，除非重新验证级联顺序。`style-report.mjs --json` 的 `files` 字段列出各文件规则数，总规则数仍按原有口径统计。

## 外壳（V1 桌面改版 + V2 精修）

外壳只负责窗口与导航层，不碰各工具页面的业务结构和流程。改外壳时先看这一节，别在页面里重复造顶栏或导航。

- **顶栏**：`.topbar` 高 `--shell-bar`（56px，Windows `TITLEBAR_HEIGHT` 同为 56，macOS 红黄绿 `y: 21`），不铺底色、无分隔线，整条 `-webkit-app-region: drag`；搜索按钮、计时胶囊 `.mochi` 是 `no-drag`。平台由 `body[data-platform]` 决定让位：`darwin` 左留 96px（红黄绿后再空约 32px 才到搜索），`win32` 右留 148px 给系统最小化/最大化/关闭。进入全屏后 `body[data-fullscreen="true"]` 会把左右让位都收成 8px，搜索跟随窗口左移。平台值来自 preload 的 `process.platform`。
- **颜色**：三层抽屉：外层背景 `--app-bg`（顶栏和无框一级导航直接显露它，连成 L 形底层）、二级书签和工作区同一表面 `--workspace-bg`、工作区圆角 `--workspace-radius`（20px）、书签圆角 `--drawer-radius`（16px）。深色在 `[data-theme="dark"]` 有独立值，工作区不是强制白底。
- **一级栏**：`.rail` 无框：不铺底色、不描边、无阴影（宽 `--shell-bar` 56px，与顶栏高度一致；40 的按钮两侧各 8px，底部留 8px），模块按钮放在可滚动的 `.rail-list` 里，头像 `.rail-footer` 固定在底部；`.nav-ic` 40px（选中块圆角 10），只放图标，名称走 `aria-label` + `data-tip`（`data-tip-side="right"`），由 `installTooltips()` 统一显示，键盘聚焦也会出现。选中底板是独立的 `.nav-indicator`，和按钮同在 `.rail-list` 里，滚动时一起走。
- **二级栏**：`.submenu` 宽度由 `fitSubmenuWidth()` 按所有模块里最长的一行（按粗体量）算一次，限制 120–240px，各模块同宽，切模块、悬停、选中都不变；是书签抽屉：底色同工作区 `--workspace-bg`、背景模糊，只描左上下三边（`--glass-border`），左侧圆角 `--drawer-radius`、右侧直角开放，阴影 `--drawer-shadow` 往左和上下散；和工作区不重叠（都是半透明底，叠 1px 会多出一条深线）；内边距 12px；行高 36px、行间 2px，分组标题行高 22px、到首个工具 6px、组间 12px；独立滚动；名称 `.submenu-label` 单行省略，被截断的行由 `renderSubmenu()` 补 `data-tip` 显示全名；普通行无边框，选中态由 `.submenu-indicator` 画淡色圆角底板。主页没有二级栏。
- **工作区**：`.content` 是抽屉主体，半透明毛玻璃，上外边距 0（顶栏 56px 里的胶囊上下各空 11px）、右下 8px（与顶栏左右内边距一致）。有二级栏时（`.submenu.show + .content`）左侧直角，和书签接成一个面，左边描边用中性灰 `--drawer-divider` 作为书签与内容的分隔线，阴影换成只往右下走的 `--drawer-body-shadow`；没有二级栏时四角圆角 20、四边描边。首页（`body.home-active`）去掉底色、描边、阴影，标语直接压在背景上。`overflow: hidden`；`.pages` 不滚，`.page` 自己滚。页面内部结构不用改。
- **搜索**：`#search-wrap` 是居中模态（遮罩 + `#search-dialog`），内部仍复用 `#feature-search`、`#search-results`、`.search-result`。⌘K / Ctrl+K、Esc、点击遮罩；关闭后焦点回到打开前的元素。结果按模块相关度分组，组标题就是分类名（`renderSearchResults()`）。
- **头像**：左下 `.profile-avatar`（按钮 38px、图片 32px，悬停提示「设置与反馈」），无自定义图片时用内置 SVG `#ic-default-avatar`；菜单 `#profile-menu` 挂在 `#overlay-layer`，用 `placePopover` 的 `side: 'right'` 出现在导航条右侧、底边对齐头像；菜单展开时头像不再显示悬停提示；只有「设置」「意见反馈」两项。换头像入口在「设置 › 通用」。
- **阴影与毛玻璃（V4）**：只有工作区 `.content` 带一层柔和外阴影（`--glass-shadow`）、描边（`--glass-border`）和顶部高光（`--glass-highlight`）；工作区里的内容框（`.m-card`、`.settings-section-body`）用描边 + `--surface-inner` + 顶部高光 + 折射边（`::before` 画 `--glass-edge`），圆角 `--frame-radius`（12px），**不加外阴影、不做背景模糊**。透明度统一由 `--glass-opacity`（工作区，默认 0.3）和 `--glass-inner-opacity`（= 工作区 × 0.5）控制，深色下系数翻倍；模糊用 `--glass-blur-px`（默认 26px），只作用于工作区、二级书签和旧版白纱，`body[data-bg="plain"]` 时不开。浅灰背景下描边换成中性色、关掉高光和折射边。库存 / 定制页面里的 `--erp-bg-surface` 映射到 `--surface-inner`，不走 portal 的浮层用实色 `--erp-bg-popover`。新页面要半透明就用这几个变量，别再写死 rgba 白，也别给整个组件设 `opacity`。弹窗保留 `--shadow-panel`，下拉菜单 `.app-menu` 用 `--shadow-small`。
- **背景**：`.window-shell` 铺 `--app-bg`。「设置 › 外观 › 背景与毛玻璃」（`modules/background.js`）写 `body[data-bg]`（`classic` 默认 / `plain` 浅灰 / `gradient` / `solid`）和 `--app-bg-start`、`--app-bg-end`、`--app-bg-angle`、`--glass-opacity`、`--glass-blur-px`；深色主题下自定义颜色只混入 22% 深色底。`classic` 是 V1 之前的旧版背景（`b8e8e7b` 原样）：`.orbs` 三团模糊光斑（`--orb-1/2/3`、`--orb-opacity`）加 `.panel` 白纱（`--veil`）。设置存 `localStorage['appearance-bg']`，带 `version: 4`；没有版本号的 V3 存档只保留自定义渐变 / 纯色及颜色，其余按首次使用进入 `classic`。
- **不要再加**：顶栏常驻长搜索框；光斑和白纱只由 `body[data-bg="classic"]` 打开，不要在别处另加背景装饰。新外壳只用上面的 token 和类。

## 新功能怎么选组件

1. 先在目录里找现成模式，照抄目录里的 HTML 结构与类名。
2. 颜色、字号、圆角、间距只用变量；需要新值时先加变量。
3. 目录里没有合适的，再新增组件——同时把示例和「适用场景 / 现用模块」补进 `catalog.html`。

## 不纳入统一的范围

刀模画布、图片编辑器、截图覆盖层有各自的交互约束，不为了统一改动已验收的样式。

## 统一进度

- [x] **A 变量收口**：与 `--fs-*` 相等的写死字号 70 处；过渡里的 `140ms`、`cubic-bezier(0.23, 1, 0.32, 1)` 改为 `--dur-press` / `--ease-out`；新增 `--border-neutral` / `--border-neutral-hover`。22 张基线截图无差异。
- [x] **B 交互规范**：键盘焦点改为「实线内圈 + 柔光」（对浅色底约 3.6～3.9:1），补上开关的焦点，并去掉焦点规则里把控件圆角改成父元素圆角的 `border-radius: inherit`；公共控件按下缩放统一 `--press-scale`（0.97），图片编辑器内三处保留；浮层退场淡出（`--dur-popover-exit`，可被打断，淡出期间不拦截点击）；减弱动效全局兜底；危险色 `#d54f50` 及派生收进 `--danger`（深色下变为 `#e36a6c`）。
- [x] **时长按用途收口**：新增 `--dur-hover`（悬停颜色类过渡，30 项）、`--dur-panel`（轻提示、图片编辑面板）；取值不同的旧写法保持原值，不为统一改变节奏。
- [x] **C 组件提升**（待审阅）：带单位输入框 `.unit-input`、步进器 `.stepper` 提成公共组件（刀模参数区改用，外观不变）；步进器焦点改画在外框上（原先被 `overflow: hidden` 裁成两条竖线）。输入错误态统一读 `aria-invalid`：条码与刀模从切 `.invalid` 类名改为设属性，条码错误提示用 `aria-describedby` 关联；只有内容校验失败才标 `aria-invalid`，保存 / 复制 / 联动失败只显示提示（原先切 `.invalid` 时这两类混在一起，操作失败也会把输入框标红）；错误态在悬停、聚焦、刀模参数高亮时保持，禁用时不显示。
- [x] **D 拆分 style.css**：保留唯一 `@import` 入口，按原级联顺序拆入 `styles/`；989 条业务规则不变。全量 290 状态比较中的 6 处指针状态差异经固定指针复核，34 个常规与交互状态零差异；OCR-B 在开发版、构建版及 `file://` 组件目录均加载成功。

- [x] **E 库存 / 定制并入**：原 ajuan-erp 组件的变量统一改为 `--erp-*` 并映射到摸鱼变量（`src/renderer/erp/styles/erp.css`），主题跟随摸鱼；摸鱼全局输入框边框在 ERP 范围内复位。约定见组件目录「库存 / 定制」。
- [x] **三层抽屉**：顶栏 56px、无框一级导航 56px（与顶栏连成 L 形）、二级栏改书签抽屉（三边描边、左圆角 16、右侧开放）、工作区作为抽屉主体（右圆角 20）。
- [x] **V4 精修**：默认主题还原旧版光斑 + 白纱 + 毛玻璃；首页去底板；顶栏 48px、下方不再留间距；二级栏宽度按最长工具名统一（120–240px）、行高 36px；PDF 菜单去掉转 DOCX / XLSX / PPTX；变量改名为 `--app-bg-*`、`--glass-opacity`、`--glass-border`、`--glass-shadow`。
- [x] **V3 视觉系统**：导航条圆角 14、二级栏 180–190px；阴影只留工作区一层；毛玻璃变量（`--glass-alpha` / `--glass-blur-px` / `--surface-inner`）；外观设置新增「背景与毛玻璃」，旧版紫蓝渐变作为预设；浅色控件描边改中性色。
- [x] **V2 外壳精修**：三层底色（删 `--shell-nav-bg`）、顶栏 50px、独立圆角一级导航条、图标底板 40px、头像 32px、二级栏收窄并透明、长名称省略加提示。
- [x] **V1 桌面外壳**：外层底色 + 两级导航 + 白色工作区容器；顶栏改 56px 无边框（macOS 红黄绿 / Windows `titleBarOverlay`），一级栏只留图标与 Tooltip，二级栏固定宽度，搜索改居中弹窗，左下加入头像与两项菜单。约定见上面「外壳（V1 桌面改版）」。

A 片后仍无对应档位的字号：13px×6、9px×4、17px×3、20px×3、10.5px×3——是否新增档位待定。

## 注意

引用了 `--foreground` 等主题变量的自定义属性（如 `--border-neutral`），必须在 `[data-theme="dark"]` 块里再声明一次：主题挂在 `body` 上，而 `:root` 上的值在继承前就已按浅色算好了。

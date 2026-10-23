# UI 规范与组件目录

- [`catalog.html`](catalog.html)：组件目录。浏览器直接打开即可，引用的是真实的 `src/renderer/style.css`，浅色 / 深色并排。
- `node scripts/style-report.mjs`：样式地图。统计各模块规则、变量引用、写死的高频值、重复选择器和疑似废弃类名；加 `--json` 输出机器可读结果。

## 样式文件

`src/renderer/style.css` 是唯一入口，按顺序导入 `src/renderer/styles/` 下的子文件。子文件按原样式表的顶层规则边界拆出，编号即原有级联顺序；后段的跨模块补充规则保留在对应的覆盖文件中。修改已有规则时先定位所属子文件，不要仅按文件名移动规则，除非重新验证级联顺序。`style-report.mjs --json` 的 `files` 字段列出各文件规则数，总规则数仍按原有口径统计。

## 外壳（V1 桌面改版）

外壳只负责窗口与导航层，不碰各工具页面的业务结构和流程。改外壳时先看这一节，别在页面里重复造顶栏或导航。

- **顶栏**：`.topbar` 固定 56px，整条 `-webkit-app-region: drag`；搜索按钮、计时胶囊 `.mochi` 是 `no-drag`。平台由 `body[data-platform]` 决定让位：`darwin` 左留 78px 给红黄绿，`win32` 右留 148px 给系统最小化/最大化/关闭。平台值来自 preload 的 `process.platform`。
- **颜色**：外层 `--shell-bg`、导航 `--shell-nav-bg`、工作区 `--workspace-bg`、圆角 `--workspace-radius`（20px）。深色在 `[data-theme="dark"]` 有独立值，工作区不是强制白底。
- **一级栏**：`.rail` 宽 64px；`.nav-ic` 只放图标，名称走 `aria-label` + `data-tip`（`data-tip-side="right"`），由 `installTooltips()` 统一显示，键盘聚焦也会出现。选中底板是独立的 `.nav-indicator`。
- **二级栏**：`.submenu` 宽 `clamp(184px, 18vw, 208px)`，行高 40px、独立滚动；普通行无边框，选中态由 `.submenu-indicator` 画淡色圆角底板。主页没有二级栏。
- **工作区**：`.content` 是白色/深色实色圆角容器，外边距 12px，`overflow: hidden`；`.pages` 不滚，`.page` 自己滚。页面内部结构不用改。
- **搜索**：`#search-wrap` 是居中模态（遮罩 + `#search-dialog`），内部仍复用 `#feature-search`、`#search-results`、`.search-result`。⌘K / Ctrl+K、Esc、点击遮罩；关闭后焦点回到打开前的元素。结果按模块相关度分组，组标题就是分类名（`renderSearchResults()`）。
- **头像**：左下 `.profile-avatar`，无自定义图片时用内置 SVG `#ic-default-avatar`；菜单 `#profile-menu` 挂在 `#overlay-layer`，只有「设置」「意见反馈」两项。换头像入口在「设置 › 通用」。
- **不要再加**：`.window-shell` 上的渐变光球、`.panel` 的毛玻璃、顶栏常驻长搜索框。新外壳只用上面的 token 和类。

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
- [x] **V1 桌面外壳**：外层底色 + 两级导航 + 白色工作区容器；顶栏改 56px 无边框（macOS 红黄绿 / Windows `titleBarOverlay`），一级栏只留图标与 Tooltip，二级栏固定宽度，搜索改居中弹窗，左下加入头像与两项菜单。约定见上面「外壳（V1 桌面改版）」。

A 片后仍无对应档位的字号：13px×6、9px×4、17px×3、20px×3、10.5px×3——是否新增档位待定。

## 注意

引用了 `--foreground` 等主题变量的自定义属性（如 `--border-neutral`），必须在 `[data-theme="dark"]` 块里再声明一次：主题挂在 `body` 上，而 `:root` 上的值在继承前就已按浅色算好了。

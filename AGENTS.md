# 摸鱼工具箱 — Electron 开发约定

## 项目定位

`摸鱼工具箱` 是一个 Windows 优先的本地 Electron 桌面工具箱（图片、PDF、条码、截图、格式转换等）。

技术与范围以本机 `scope/` 当前计划为准。`scope/` 是本地开发依据，不纳入 Git。

## 工作规则

1. 修改前运行 `git status --short --branch`，保留已有改动。
2. 按 `scope/plans/README.md` 的里程碑顺序开发。每片先完成计划中的 Spike 或验收，再扩展下一片。
3. 使用 Electron、npm 和项目现有构建链；不引入第二套包管理器。
4. renderer 必须 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；所有桌面能力仅经白名单桥接暴露。
5. 文件读写、系统能力、原生模块和外部进程都放在主进程或受控任务进程；renderer 不直接访问 Node、文件系统或系统 API。
6. 新增原生模块、WASM、worker、独立可执行文件或打包后需解析路径的资源时，先做目标平台打包 Spike。
7. 不保留未实现的可点击控件；未实现能力须明确禁用或标为预览。
8. 不使用 CDN 作为核心运行依赖；运行资源经 npm 或 `assets/` 本地交付。
9. 不提交缓存、构建产物、用户私有素材、凭证、本地计划文档或测试代码。

## 代码语言

- 主进程（`src/main`）、preload、`src/shared`、库存 / 定制界面（`src/renderer/erp`）一律 TypeScript，`npm run typecheck` 全量严格检查；新文件不再写 `.js`。
- 原工具箱界面（`src/renderer` 下 `erp/` 以外）保持原生 JS + DOM，改动时不要求顺带改写成 TS 或 React；文件顶部有 `// @ts-check` 的也纳入 `typecheck`，改这些文件要保持检查通过。新写的界面模块优先加 `// @ts-check`。
- `resources/` 下由子进程直接加载的 `.cjs`（如 `com-worker.cjs`）不经构建，保持 CommonJS。

## 验证

- 日常改动：相关 harness、静态检查和 `npm run build`。
- Renderer 改动：检查控制台、导航、主题、菜单与涉及的点击路径。
- IPC/主进程：验证成功、取消和失败提示；renderer 不获得额外 Node API。
- 原生资产：按目标平台实测，不能用另一平台的结果代替。
- 打包验证：只在触及打包布局、原生资产、运行闭包或发布收口时执行；不要为普通功能切片反复打包。

- 样式改动：`npm run lint:css`（Stylelint + 样式门槛）。门槛只能减：写死的颜色、圆角、字号、重复选择器、废弃类名、没人用的变量都不能比 `scripts/style-baseline.json` 多；数字降下来后再跑 `node scripts/style-report.mjs --update-baseline`。

未能执行的验证必须在交付中说明原因与残余风险。

## 界面样式

- 外观只改变量：基础值在 `styles/00-foundation.css`，组件语义变量（`--btn-*`、`--field-*`、`--seg-*`、`--card-*`、`--menu-*`、`--dialog-*`）在 `styles/01-tokens.css`。
- 同类元素只用一种写法，组件在 `styles/components/`（前缀 `m-`）：按钮 `m-btn`、输入 `m-field-unit` / `m-stepper` / `m-select`、分段 `m-segmented`、开关 `m-switch`、卡片 `m-card`、空状态 `m-empty`、菜单 `m-menu`、对话框 `m-dialog` + `m-backdrop`。尺寸和变体用修饰类（`m-btn--primary`、`--sm`），状态用属性（`aria-pressed`、`aria-selected`、`aria-invalid`、`:disabled`）。
- 模块文件（`02-*`–`13-*`）只写布局：宽度、位置、网格、间距组合；不再为某个按钮或输入框补外观。`components/` 里禁止写死颜色、圆角、字号（Stylelint 会拦）。
- 库存 / 定制的 React 组件在 `.module.css` 里直接引用同一组语义变量，不另起一套外观。
- 设置页：一类设置一页（`[data-settings-page]`，导航 `#settings-nav`）；分组用 `h2.settings-group-title` + `.m-card.settings-group` + `.setting-row`（名称说明在左、控件在右）。React 分类用 `erp/features/settings/SettingsLayout.tsx`，不另写卡片样式。新增设置项只接已有能力，不放占位按钮。
- 新组件或新变体要同步进 `docs/ui/catalog.html`。

## 发布与交付

发布命名统一使用 `moyu-tools`（安装包文件名前缀 `moyu-tools-v<version>-windows-x64-*`）。当前发布流程以 `docs/` 中的现行文档和 `scope/` 当前计划为准。

## Git

- 开发主线：`dev`；`main` 保留为稳定基线。
- 提交前运行 `git diff --check`、`git diff --stat` 与 `git status --short --branch`。
- 使用约定式提交，例如 `feat(tools): ...`、`fix(screenshot): ...`、`docs(project): ...`。
- 不推送远程，除非用户明确要求。

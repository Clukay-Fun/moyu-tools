# Changelog

## v2.2.0 — 摸鱼工具箱集中升级

### Changed

- `main.js`（渲染进程）与 `src/main/index.js`（主进程）按业务模块拆分：条码、格式工厂、Illustrator 联动、拖拽/Office 转换、区域截图、PDF、更新面板等各自迁到 `src/renderer/modules/` 与 `src/main/modules/`，原单体文件体量大幅缩减。
- 生产依赖审计：升级 `sharp` 至 0.35.4，`js-yaml` 通过 `overrides` 锁定到 4.3.2 修复版本，`npm audit --omit=dev` 生产依赖零漏洞。
- `release-dryrun.yml` 发布演练与正式发布（`release.yml`）版本号命名空间隔离：演练版本强制带 `-dryrun.<run_number>` 后缀，避免与正式版本号在极端情况下重名；新增 workflow 级 `concurrency` 分组；清理步骤新增"仅允许删除演练命名空间内的 tag/Release"的兜底校验。

### Fixed

- 画布保存期间继续编辑会导致新改动被静默丢弃：`save()` 在检测到保存过程中场景又发生改动时，此前仍会返回 `true`，导致"保存后新建/打开工程"以及应用退出握手把这次保存误判为"已完整落盘、可以安全丢弃当前场景"。现在这种情况下会如实返回 `false`。
- 安装更新前置检查遗漏条码模块：正在保存/导出条码或联动 Illustrator/Office 时，仍可点击"立即重启更新"强制退出，导致写到一半的文件损坏。新增条码模块忙碌状态跟踪并接入前置检查。
- 修复两处自动化测试假通过：条码类型切换测试使用了错误的选择器字符串，"未找到目标"的兜底分支本应视为失败却被判定通过；全模块冒烟测试的页面激活断言末尾带有恒真的 `|| true`，没有验证任何真实状态。

### Known limitations

- 画布文字工具栏的缩放输入框在特定时序下仍会抛出"节点不存在"异常（`verify-text-toolbar.mjs` 第 9 节），已记录、未在本轮修复范围内。
- Windows 实机验收（Illustrator/Photoshop COM 联动、多屏截图、多种系统缩放比例、NSIS 安装/升级/回滚）仍需人工执行，未被自动化 harness 覆盖。

## Unreleased — v2 Electron 重构

### Added

- M0a Electron + Vite + Vanilla 最小安全外壳。
- `sandbox:true`、上下文隔离、关闭 Node 集成的 preload 白名单 IPC。
- Windows x64 portable 打包配置。
- JsBarcode 单个与批量一维条码、SVG/PNG/EPS 导出及 Adobe 联动。
- Fabric.js 图片编辑与 PNG/JPG/WebP/TIFF 导出。
- PDF 转换、编辑、OCR、AES 加解密与图片转 PDF。
- 区域截图、应用内滚动截图、离线 OCR 与钉图。
- FFmpeg/sharp 格式工厂与本地 AI 图像 sidecar。
- winax utility process：Illustrator 批处理与 Office 转 PDF。

### Changed

- 项目目标切换为 Windows x64 Electron 桌面工具箱。
- 正式 UI 迁移目标改为 Electron renderer；根目录 `index.html` 仅作为视觉蓝本。
- 开发主线改为 `dev`。

### Removed

- 当前分支不再维护 pywebview/Python 桌面运行与 PyInstaller 打包路径。
- 不再维护独立浏览器产品路线。

旧 Python 桌面版本保留在本地 Git 分支 `archive/desktop-v1.2`。

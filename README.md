# 摸鱼工具箱

> 一款 Windows 优先的本地桌面工具箱，把 PDF、图片、条码、截图、格式转换和纸盒刀模放在一个应用里。

## 特性

- **PDF**：合并、拆分、旋转、加解密、水印、页码、页面转图片、图片转 PDF，以及文本和内嵌图片提取。
- **图片与截图**：图片编辑、格式导出、区域截图、离线 OCR 和钉图。
- **条码**：制作和批量导出一维条码，支持 PNG、SVG、EPS 等格式。
- **格式转换**：批量处理视频、音频和图片文件。
- **刀模**：内置飞机盒、平口箱、天地盖、托盘围套、插舌盒等常用盒型预设，按长宽高、厚度、材质和结构参数生成展开图；2D 图纸、3D 折叠预览与导出共用同一套几何，支持 mm/in 与制造/内/外三种尺寸口径，可导出 1:1 矢量 PDF，Windows + Illustrator 环境下还可导出分层 AI。当前为工程草稿，结构比例与内外尺寸补偿需按工厂样板和实物打样校准。
- **桌面联动**：在受支持的 Windows 环境中使用 Illustrator 和 Office 相关工具。

主要处理在本机完成；部分桌面联动需要相应软件已安装。具体可用功能以应用内界面为准。

## 安装

前往 [Releases](https://github.com/Clukay-Fun/moyu-tools/releases) 下载 Windows x64 版本：

- `moyu-tools-v<版本号>-windows-x64-setup.exe`：安装版，支持在应用内检查和安装更新。
- `moyu-tools-v<版本号>-windows-x64-portable.exe`：便携版，无需安装；更新时需手动下载新版。

运行安装包或便携版即可打开应用。部分功能依赖 Windows 或本机安装的第三方软件；macOS 不属于当前正式发布目标。

## 快速开始

以合并 PDF 为例：

1. 打开摸鱼工具箱，进入左侧的 **PDF** 模块。
2. 选择 **合并 PDF**，添加文件并调整顺序。
3. 点击合并，选择保存位置，得到合并后的 PDF。

## 用法

从左侧导航选择工具模块，添加文件或填写参数，预览结果后再导出。需要处理多张图片或多个媒体文件时，可在对应模块批量添加；制作纸盒刀模时，请先核对尺寸口径，再用导出的校样进行测量和打样。

安装版可在 **设置 → 更新** 中检查新版。使用中遇到问题，可到 [Issues](https://github.com/Clukay-Fun/moyu-tools/issues) 反馈。

## 开发

需要 Node.js 22.12 或更新版本及 npm。克隆仓库后运行：

```bash
npm install
npm run dev
```

构建检查：

```bash
npm run build
```

开发约定见 [AGENTS.md](AGENTS.md)，构建与发布说明见 [docs](docs/README.md)。

## 许可证

当前仓库未提供项目级许可证。第三方组件的授权和声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 [licenses](licenses/)。

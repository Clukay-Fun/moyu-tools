# moyu-dsh

`moyu-dsh` 是一个基于 DeepSeek Harness 的本地桌面应用。DSH 负责主界面、会话和工具调用，Electron 负责桌面窗口、安全边界、文件访问与系统能力桥接。

## 当前能力

- 图片转换：通过本地 Host Service 处理图片格式转换、压缩和结果保存。
- PDF：通过本地 Host Service 处理 PDF 合并、拆分、旋转、加解密、水印、页码、图片转 PDF、整页转图、文本与内嵌图片提取。
- 截图：通过 Electron 系统能力完成屏幕采集、用户确认、区域选择和结果回传。

## 技术基线

- Electron
- DeepSeek Harness
- npm workspaces
- 本地 DSH profile
- 主进程与 DSH Host 的窄桥通信
- 本地文件令牌与结果令牌，不向模型暴露绝对路径

## 开发

```bash
npm install
npm run dev
npm run build
```

构建、打包和验收以当前 `scope/` 计划为准。`scope/`、`tests/`、`release/` 是本地开发资料和产物目录，不纳入 Git。

## 目录

- `apps/`：桌面应用入口与 Electron 宿主代码。
- `packages/`：DSH profile、内置插件和本地能力实现。
- `resources/`：运行期 worker 与桌面桥资源。
- `scripts/`：构建、资源和发布辅助脚本。
- `docs/`：随源码交付的当前开发与发布说明。
- `licenses/`：第三方组件和运行库声明。
- `scope/`：本地路线图、计划和验收材料。
- `tests/`：本地测试与样本。

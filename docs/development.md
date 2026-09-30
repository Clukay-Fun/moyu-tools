# 本地开发

摸鱼工具箱 使用 Electron 与项目构建链开发。

## 常用命令

```bash
npm install
npm run dev
npm run build
```

## 验证口径

- 普通代码改动：运行相关 harness 与 `npm run build`。
- 原生资源、worker、WASM、独立可执行文件或打包运行闭包变化：运行对应资源构建与专项验证。
- 原生资源或打包布局变化：执行目标平台打包验证。

`scope/`、`tests/`、`release/` 不纳入 Git。不要把缓存、构建产物、凭证或本地测试素材提交到仓库。

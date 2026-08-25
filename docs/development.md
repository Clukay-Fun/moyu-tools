# 本地开发

`moyu-dsh` 使用 Electron 与本地 DSH 运行环境开发。

## 常用命令

```bash
npm install
npm run dev
npm run build
```

## 验证口径

- 普通代码改动：运行相关 harness 与 `npm run build`。
- DSH profile、运行闭包或自建插件变化：运行对应 DSH runtime 构建与专项验证。
- 原生资源或打包布局变化：执行目标平台打包验证。

`scope/`、`tests/`、`release/` 不纳入 Git。不要把缓存、构建产物、凭证或本地测试素材提交到仓库。

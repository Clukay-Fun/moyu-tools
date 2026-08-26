# 发布说明

`moyu-tools`（摸鱼工具箱）发布包以当前 `package.json`、lockfile 和 `scope/` 发布计划为准。发布前必须确认目标提交、运行闭包、原生资源和产物校验信息一致。

## 发布前检查

```bash
git status --short --branch
npm ci
npm run build
git diff --check
npm audit --omit=dev
```

涉及打包布局、原生模块、WASM、worker、独立可执行文件或 DSH 运行闭包变化时，必须执行目标平台打包验证。

## 产物命名

发布产物统一使用 `moyu-tools` 前缀，并附带版本、平台、架构和 SHA-256 校验文件。

示例：

```text
moyu-tools-v<version>-windows-x64-setup.exe
moyu-tools-v<version>-windows-x64-setup.sha256
```

实际平台、格式和命名以发布计划为准。

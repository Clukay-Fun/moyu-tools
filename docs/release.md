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

## Release 文案规范

正式 Release 必须用中文说明面向用户的变化。自动发布会读取最新 Release 标签之后的提交标题，按提交类型整理成固定结构；没有可展示的提交说明时，发布会失败，不会生成空白说明。

提交标题使用约定式格式，并在冒号后写清用户能做什么、行为有什么变化或问题如何解决：

```text
feat(dieline): 新增天地盖纸盒模板
fix(pdf): 修复拆分文件时空白页丢失
style(settings): 调整更新状态与操作按钮布局
```

Release 正文使用 `更新内容` 标题，并按有内容的类别列出要点：

```markdown
## 更新内容

### 新增
- 新增天地盖纸盒模板，可直接生成对应展开图。

### 改进
- 调整更新状态与操作按钮布局，当前可执行操作更清楚。

### 修复
- 修复 PDF 拆分时空白页丢失的问题。
```

每条说明聚焦一个用户可见结果，使用“动作 + 功能/问题 + 结果”的写法。避免“更新优化”“若干问题修复”等无法说明变化的笼统表述，也不要把内部重构、提交哈希或发布流程当作功能说明。提交标题中的类型和范围只用于归类，不会显示在 Release 要点里。`chore(release)` 提交会从 Release 正文中排除。

## 产物命名

发布产物统一使用 `moyu-tools` 前缀，并附带版本、平台、架构和 SHA-256 校验文件。

示例：

```text
moyu-tools-v<version>-windows-x64-setup.exe
moyu-tools-v<version>-windows-x64-setup.sha256
```

实际平台、格式和命名以发布计划为准。

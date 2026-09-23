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

## 正式发布流程

- 日常开发继续提交并推送到 `dev`；普通分支推送不会生成 Release。
- 确认准备发布的改动已合并到 `main` 后，使用 `npm version patch --no-git-tag-version` 或 `npm version minor --no-git-tag-version` 同步更新 `package.json` 与 `package-lock.json`，并提交版本变更。
- 在包含该版本提交的 `main` 提交上创建并推送 `v<version>` tag，例如 `v2.1.8`。发布工作流只响应 `v*` tag，并会校验 tag、两个包文件中的版本一致，且 tag 对应的提交已进入 `main`。
- 工作流从最近一个正式 Release 生成中文更新说明，构建 Windows NSIS 安装包，生成 SHA-256 校验文件，校验资产后发布。
- 修复和小调整递增 patch（如 `2.1.7` → `2.1.8`）；新增用户功能递增 minor（如 `2.1.7` → `2.2.0`）。
- 自动更新仅支持 Windows 安装版；开发运行和便携版需要手动获取正式 Release。

## 产物命名

发布产物统一使用 `moyu-tools` 前缀，并附带版本、平台、架构和 SHA-256 校验文件。

示例：

```text
moyu-tools-v<version>-windows-x64-setup.exe
moyu-tools-v<version>-windows-x64-setup.exe.sha256
```

实际平台、格式和命名以发布计划为准。

# moyu-dsh — Electron 开发约定

## 项目定位

`moyu-dsh` 是一个基于 DeepSeek Harness 的本地桌面应用。DSH 是应用内核与唯一主界面；Electron 是桌面宿主、安全边界和系统能力桥。

技术与范围以本机 `scope/` 当前计划为准。`scope/` 是本地开发依据，不纳入 Git。

## 工作规则

1. 修改前运行 `git status --short --branch`，保留已有改动。
2. 按 `scope/plans/README.md` 的里程碑顺序开发。每片先完成计划中的 Spike 或验收，再扩展下一片。
3. 使用 Electron、DeepSeek Harness、npm 和项目现有构建链；不引入第二套包管理器。
4. renderer 必须 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；所有桌面能力仅经白名单桥接暴露。
5. 文件读写、系统能力、原生模块和外部进程都放在主进程或受控任务进程；renderer 不直接访问 Node、文件系统或系统 API。
6. 新增原生模块、WASM、worker、独立可执行文件或打包后需解析路径的资源时，先做目标平台打包 Spike。
7. 不保留未实现的可点击控件；未实现能力须明确禁用或标为预览。
8. 不使用 CDN 作为核心运行依赖；运行资源经 npm 或 `assets/` 本地交付。
9. 不提交缓存、构建产物、用户私有素材、凭证、本地计划文档或测试代码。

## 验证

- 日常改动：相关 harness、静态检查和 `npm run build`。
- Renderer 改动：检查控制台、导航、主题、菜单与涉及的点击路径。
- IPC/主进程：验证成功、取消和失败提示；renderer 不获得额外 Node API。
- 原生资产：按目标平台实测，不能用另一平台的结果代替。
- 打包验证：只在触及打包布局、原生资产、运行闭包或发布收口时执行；不要为普通功能切片反复打包。

未能执行的验证必须在交付中说明原因与残余风险。

## 发布与交付

发布命名统一使用 `moyu-dsh`。当前发布流程以 `docs/` 中的现行文档和 `scope/` 当前计划为准。

## Git

- 开发主线：`dev`；`main` 保留为稳定基线。
- 提交前运行 `git diff --check`、`git diff --stat` 与 `git status --short --branch`。
- 使用约定式提交，例如 `feat(dsh): ...`、`fix(screenshot): ...`、`docs(project): ...`。
- 不推送远程，除非用户明确要求。

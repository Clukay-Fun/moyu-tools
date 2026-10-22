# 摸鱼 PSD Photoshop 插件

本目录包含两套平台插件，共用摸鱼工具箱「定制」的 `psd-bridge` 队列协议。

## macOS：UXP

`uxp/` 是原来的 UXP 插件。「设置 › 定制」的“准备 UXP 插件”会复制它到应用数据目录，打开 Photoshop 并把 UXP Developer Tools 切到前台；也可用“打开 UXP Developer Tools”按钮重新调出开发工具。首次使用在 UXP Developer Tools 中添加安装目录下的 `manifest.json` 并点 Load，然后在 Photoshop「插件 → 摸鱼 PSD」打开面板，授权桥接与导出目录。Photoshop 原生运行，无需 Rosetta。应用启动时会打开开发工具和 Photoshop；插件加载状态仍由 UXP Developer Tools 管理。

## Windows：CEP

「设置 › 定制」的“安装 CEP 面板”会复制本目录的 CEP 文件到 `%APPDATA%\Adobe\CEP\extensions\com.clukay.moyu.psd`，写入目录设置，并开启当前用户的 `CSXS.12` 调试加载设置。重启 Photoshop 后，从「窗口 → 扩展（旧版）→ 摸鱼 PSD」打开面板。

`CSXS/manifest.xml` 注册可见面板及独立的后台扩展。可见面板使用 CEP 文件接口读取状态；后台扩展使用 Node.js 处理队列，并通过 `host.jsx` 调用 Photoshop。输出写入 `done` 或 `failed`，原始 PSD 和素材不会被覆盖。

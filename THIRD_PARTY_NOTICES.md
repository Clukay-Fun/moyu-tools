# Third-party notices

摸鱼工具箱包含以下第三方组件。对应许可证全文随应用一起发布在 `licenses/` 目录。

## OCRB 字体组（用户提供）

- 用途：条码人眼可读数字的可选字体；随渲染层一起交付，不依赖用户系统安装字体。
- 来源：用户本地提供的 `~/Downloads/ocra-ocrb-fonts/`，包含 OCRB、OCRB I、OCRB III、OCRB IV。
- 许可证：字体元数据未提供版权、许可证名称或许可证 URL；仅限用户声明的个人学习用途，确认授权前不得分发。
- 说明文件：`licenses/OCRB-USER-PROVIDED-NOTICE.txt`。

## opentype.js

- 用途：将随包 OCR-B 字体的人眼可读字符转换为 SVG 路径，避免 Adobe 联动时发生字体替换。
- 版本：2.0.0。
- 许可证：MIT。
- 许可证文件：`licenses/opentype.js-MIT.txt`。

## qrcode-generator 2.0.4

- 用途：「视频转二维码」在渲染进程本地把链接编码成二维码码点矩阵，不联网。
- 许可证：MIT
- Copyright (c) 2009 Kazuhiko Arase
- npm integrity：`sha512-mZSiP6RnbHl4xL2Ap5HfkjLnmxfKcPWpWe/c+5XxCuetEenqmNFf1FH/ftXPCtFG5/TDobjsjz6sSNL0Sr8Z9g==`
- 许可证文件：`licenses/qrcode-generator-MIT.txt`
- 「QR Code」是 DENSO WAVE INCORPORATED 的注册商标。

## qpdf-run 0.2.1

- 用途：在 Electron 渲染进程的 Web Worker 中运行 QPDF WebAssembly，为 PDF 提供加密与解密能力。
- 许可证：MIT
- Copyright (c) 2026 CrabPDF contributors
- npm integrity：`sha512-X4ZknJPl7av/o+VEX3XafWyzfOUm9qSoa+JqXS+hGSNVI1Wxk60bKhmLvvX/8gp7pCzbp3KW0zY8aLBjL5EkYQ==`
- 许可证文件：`licenses/qpdf-run-MIT.txt`

## QPDF 11.10.0

- 用途：由 `qpdf-run` 打包为 JavaScript/WebAssembly，执行 PDF AES-256 加密与解密。
- 许可证：Apache License 2.0
- Copyright (c) 2005-2021 Jay Berkenbilt, 2022-2025 Jay Berkenbilt and Manfred Holger
- `qpdf.wasm` SHA-256：`86cba3db67ce3add2dd4b3533dd0614dade0b4e98b14a229bfda90306c053dd3`
- `qpdf.js` SHA-256：`35df3cad3919f370dd86970e1ea3fc8bd57f744be23a50a773f17abcbf1d9ffc`
- 许可证文件：`licenses/QPDF-Apache-2.0.txt`
- 上游 NOTICE：`licenses/QPDF-NOTICE.md`

## FFmpeg / ffprobe 6.1.1

- 用途：格式工厂通过独立、隐藏窗口的子进程执行音频与视频探测、转换和压缩。
- 来源：`eugeneware/ffmpeg-static` release `b6.1.1`，实际 Windows 构建来自 gyan.dev essentials。
- 实际许可证：GPL-3.0-or-later；构建启用了 `--enable-gpl --enable-version3 --enable-static`。
- 版本、二进制哈希、源码获取与发布义务：`licenses/FFMPEG-NOTICE.md`
- 上游许可证与完整构建配置随二进制放在发布包 `resources/tools/ffmpeg/`。

## sharp 0.35.3 / libvips

- 用途：格式工厂读取图片元数据并执行批量格式转换、缩放和压缩。
- sharp 许可证：Apache License 2.0。
- Windows 原生包与 libvips 许可证：Apache-2.0 AND LGPL-3.0-or-later。
- 固定版本、npm integrity、动态链接边界和源码获取方式：`licenses/SHARP-NOTICE.md`
- Apache License 2.0 全文：`licenses/QPDF-Apache-2.0.txt`

## winax 3.6.9

- 用途：在独立 Electron utility process 中调用 Windows COM，联动 Microsoft Office、Adobe Illustrator 与 Adobe Photoshop。
- 许可证：MIT
- Copyright (c) 2023 Yuri Dursin
- npm integrity：`sha512-R+6yTIk8pnIf50P4z8unG3yfRP0DCYzq7v8J04tool1OR4UkoXKEGfAj+cq6IPPhnVQHz7+m7isg+yU38T727w==`
- 许可证文件：`licenses/winax-MIT.txt`

## gs1encoder (GS1 Barcode Syntax Engine)

- 版本：1.4.1（精确固定，非 `^` 范围）
- 许可证：Apache-2.0（见 `licenses/GS1-SYNTAX-ENGINE-Apache-2.0.txt`）
- 项目：https://github.com/gs1/gs1-syntax-engine
- npm integrity：`sha512-wiLHo41Jg5o3gPFOoNgv0zy6DVzMeTLq2x/9ue+0PRt6GoDqgfbSIMFpxzq8GcfVOyGRU9b7czhGK2GP4V58vQ==`
- 用途：GS1-128 的 AI 语法校验与 HRI 生成。使用包内嵌固定 AI 表，
  **不在运行时下载 Syntax Dictionary**，WASM 随构建本地打包。

## lucide-static 1.30.0

图标资源。**仅作构建期依赖**：构建时从中抽取映射表里用到的图标，
生成内联 SVG sprite；图标库本身不进入运行时产物，也不随安装包分发。

许可证：ISC

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

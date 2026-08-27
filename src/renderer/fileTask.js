// 统一文件任务模板（M2）
// 文件列表渲染：PDF / Illustrator / 格式工厂 共用「清空容器 + 切换空态 + 生成行」逻辑。
// 各模块通过 renderRow 回调保留自己的列与状态样式，行为不变。

export function renderFileRows(listBody, emptyEl, items, { renderRow } = {}) {
  listBody.replaceChildren()
  if (emptyEl) {
    // PDF / AI 的空态由 .hidden 类控制，格式工厂由 [hidden] 属性控制，两者都设置以兼容。
    const hasItems = items.length > 0
    emptyEl.classList.toggle('hidden', hasItems)
    emptyEl.hidden = hasItems
  }
  const fragment = document.createDocumentFragment()
  items.forEach((item, index) => {
    const row = renderRow ? renderRow(item, index) : item
    if (row) fragment.append(row)
  })
  listBody.append(fragment)
}

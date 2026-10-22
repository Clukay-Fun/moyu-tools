/**
 * 把替换后的图片等比例放进原来的图层边界，完整显示，不拉伸。
 * scale 取宽、高里更小的那个比例。Photoshop 以中心为锚缩放，再用 dx/dy 把中心移回目标中心。
 * 图层缩放后保持在模板目标区域内。测试在 tests/psdExport.test.ts；
 * 插件用 require 加载本文件。
 */
function fitToBounds(oldBounds, newBounds) {
  const oldW = oldBounds.right - oldBounds.left
  const oldH = oldBounds.bottom - oldBounds.top
  const newW = newBounds.right - newBounds.left
  const newH = newBounds.bottom - newBounds.top
  if (!(oldW > 0 && oldH > 0 && newW > 0 && newH > 0)) {
    throw new Error('图层边界无效，无法按原位置缩放')
  }
  const oldCx = (oldBounds.left + oldBounds.right) / 2
  const oldCy = (oldBounds.top + oldBounds.bottom) / 2
  const newCx = (newBounds.left + newBounds.right) / 2
  const newCy = (newBounds.top + newBounds.bottom) / 2
  return {
    scale: Math.min(oldW / newW, oldH / newH),
    dx: oldCx - newCx,
    dy: oldCy - newCy
  }
}

module.exports = { fitToBounds }

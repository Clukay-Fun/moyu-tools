import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'

// 库存 / 定制只服务摸鱼主窗口：对话框挂在主窗口上，IPC 只接受主窗口发起的请求。
// 摸鱼还有隐藏的截图 / 贴图窗口，不能用 getFocusedWindow() ?? getAllWindows()[0] 兜底。
let getMainWindow: () => BrowserWindow | null = () => null

export function setErpMainWindowGetter(getter: () => BrowserWindow | null): void {
  getMainWindow = getter
}

export function owner(): BrowserWindow | undefined {
  const win = getMainWindow()
  return win && !win.isDestroyed() ? win : undefined
}

export function assertMainWindowSender(event: IpcMainInvokeEvent): void {
  const win = owner()
  if (!win || event.sender !== win.webContents) throw new Error('此操作只允许从主窗口发起')
}

/** 通知主窗口：数据已整体替换（恢复备份 / 清空 / 演示数据），renderer 丢弃内存状态重新加载 */
export function notifyMainWindow(channel: string): void {
  owner()?.webContents.send(channel)
}

import type {
  BrowserWindow,
  IpcMainEvent,
  IpcMainInvokeEvent,
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue,
  WebContents
} from 'electron'

type ElectronModule = typeof import('electron')

/**
 * index.ts 注入给各业务模块的依赖。
 * 模块按需取一部分：`Pick<MainDeps, 'ipcMain' | 'app'>`，方便测试时只传用到的几项。
 */
export interface MainDeps {
  ipcMain: ElectronModule['ipcMain']
  dialog: ElectronModule['dialog']
  BrowserWindow: ElectronModule['BrowserWindow']
  app: ElectronModule['app']
  shell: ElectronModule['shell']
  clipboard: ElectronModule['clipboard']
  nativeImage: ElectronModule['nativeImage']
  desktopCapturer: ElectronModule['desktopCapturer']
  screen: ElectronModule['screen']
  globalShortcut: ElectronModule['globalShortcut']
  utilityProcess: ElectronModule['utilityProcess']
  /** 主进程是 ESM，CommonJS 依赖（tesseract 语言包路径等）经 createRequire 解析 */
  require: NodeJS.Require
  __dirname: string
  /** 只允许主窗口发起；校验时读取 index.ts 里最新的 mainWindow */
  assertMainWindowSender: (event: IpcMainInvokeEvent | IpcMainEvent) => void
  getMainWindow: () => BrowserWindow | null
  /** sender 销毁时回收它登记过的文件会话（dropAndOffice.ts） */
  bindOwnerSessionCleanup: (sender: WebContents) => void
}

// 系统对话框：发起窗口找得到就挂在它上面，找不到就独立弹出
export function showOpenDialogFor(
  dialog: MainDeps['dialog'],
  owner: BrowserWindow | null,
  options: OpenDialogOptions
): Promise<OpenDialogReturnValue> {
  return owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options)
}

export function showSaveDialogFor(
  dialog: MainDeps['dialog'],
  owner: BrowserWindow | null,
  options: SaveDialogOptions
): Promise<SaveDialogReturnValue> {
  return owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options)
}

/** 取 catch 到的错误里的 message；不是 Error 时返回 undefined，调用方再回退到原值 */
export function messageOf(error: unknown): unknown {
  return (error as { message?: unknown } | null | undefined)?.message
}

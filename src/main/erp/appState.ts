import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { app } from 'electron'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { openDatabase, type Db } from './db/connection'
import { runMigrations } from './db/migrations'

/** 数据库连接是可替换的（恢复备份时会关闭并重新打开），所以放在一个可变的状态对象里。 */
class AppState {
  private _db: Db | null = null
  private _psdDirectories: { bridgeDir: string; outputDir: string } | null = null

  /** 库存 / 定制的数据都在 userData/erp 下（开发与打包一致）；MOYU_ERP_DATA_DIR 用于测试隔离。 */
  get dataRoot(): string {
    const isolatedDataDir = process.env.MOYU_ERP_DATA_DIR?.trim()
    if (isolatedDataDir) return resolve(isolatedDataDir)
    return join(app.getPath('userData'), 'erp')
  }

  get dbPath(): string {
    return join(this.dataRoot, 'moyu-erp.db')
  }
  get attachmentsDir(): string {
    return join(this.dataRoot, 'attachments')
  }
  get psdAssetsDir(): string {
    return join(this.dataRoot, 'psd-assets')
  }
  /** 放在「文稿」里，便于在 Photoshop 插件里选择（插件按这个目录收发任务） */
  private get defaultPsdBridgeDir(): string {
    return join(app.getPath('documents'), '摸鱼工具箱', 'psd-bridge')
  }
  private get defaultPsdOutputDir(): string {
    return join(app.getPath('downloads'), '摸鱼工具箱')
  }
  private get psdDirectoriesPath(): string {
    return join(this.dataRoot, 'psd-directories.json')
  }
  private get psdDirectories(): { bridgeDir: string; outputDir: string } {
    if (this._psdDirectories) return this._psdDirectories
    const defaults = { bridgeDir: this.defaultPsdBridgeDir, outputDir: this.defaultPsdOutputDir }
    const settingsPath = this.psdDirectoriesPath
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Partial<typeof defaults>
      this._psdDirectories = {
        bridgeDir:
          typeof parsed.bridgeDir === 'string' && isAbsolute(parsed.bridgeDir)
            ? resolve(parsed.bridgeDir)
            : defaults.bridgeDir,
        outputDir:
          typeof parsed.outputDir === 'string' && isAbsolute(parsed.outputDir)
            ? resolve(parsed.outputDir)
            : defaults.outputDir
      }
    } catch {
      this._psdDirectories = defaults
    }
    return this._psdDirectories
  }
  get psdBridgeDir(): string {
    return this.psdDirectories.bridgeDir
  }
  get psdOutputDir(): string {
    return this.psdDirectories.outputDir
  }
  setPsdDirectory(kind: 'bridgeDir' | 'outputDir', path: string): void {
    if (!isAbsolute(path)) throw new Error('目录必须是绝对路径')
    const directories = { ...this.psdDirectories, [kind]: resolve(path) }
    mkdirSync(directories[kind], { recursive: true })
    const settingsPath = this.psdDirectoriesPath
    mkdirSync(dirname(settingsPath), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify(directories, null, 2), 'utf8')
    this._psdDirectories = directories
  }
  get trashDir(): string {
    return join(this.dataRoot, 'restore-trash')
  }
  get db(): Db {
    if (!this._db) throw new Error('数据库未打开')
    return this._db
  }

  open(): void {
    const db = openDatabase(this.dbPath)
    const ran = runMigrations(db)
    if (ran.length) console.log(`[db] applied migrations: ${ran.join(', ')}`)
    this._db = db
  }

  close(): void {
    this._db?.close()
    this._db = null
  }

  /** 恢复备份后接管新连接 */
  adopt(db: Db): void {
    this._db = db
  }
}

export const state = new AppState()

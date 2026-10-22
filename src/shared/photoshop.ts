/** 公共 Photoshop 服务的检测结果；条码「发送到 Photoshop」与「定制」共用 */
export interface PhotoshopStatus {
  /** 尚未完成首次检测时为 'checking' */
  state: 'checking' | 'ready'
  installed: boolean
  path: string | null
  /** 从安装目录名解析出的年份版本，如 2025；解析不出时为 null */
  version: number | null
  /** 版本 ≥ 2024；版本未知时为 null（不阻断，只提示） */
  supported: boolean | null
  /** 「定制」用的 moyu-psd 插件是否已安装到 Photoshop 可加载的位置 */
  pluginInstalled: boolean
  checkedAt: string | null
}

export const PHOTOSHOP_MIN_VERSION = 2024

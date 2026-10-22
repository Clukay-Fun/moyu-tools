/** 设置页的分类；命令面板也用它直接跳到某个分类 */
export const SETTINGS_SECTIONS = [
  { key: 'appearance', label: '外观', hint: '主题' },
  { key: 'channels', label: '销售渠道', hint: '添加、改名、停用渠道' },
  { key: 'photoshop', label: 'Photoshop 连接', hint: '插件安装、目录' },
  { key: 'data', label: '数据', hint: '备份、恢复、示例数据、清空' },
  { key: 'about', label: '更新与关于', hint: '检查更新、版本与数据目录' }
] as const

export type SettingsSectionKey = (typeof SETTINGS_SECTIONS)[number]['key']

export function isSettingsSection(value: string | undefined): value is SettingsSectionKey {
  return SETTINGS_SECTIONS.some((section) => section.key === value)
}

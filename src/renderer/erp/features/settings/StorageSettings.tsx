/**
 * 描述: 设置 › 存储 (StorageSettings)
 * 主要功能:
 *   - 数据位置：库存 / 定制的数据目录与数据库文件，在 Finder / 资源管理器中打开
 *   - 存储维护：恢复备份时留下的旧数据（回收目录），见 TrashSettings
 * 只展示已有能力；各工具的输出位置仍由各自的保存对话框决定。
 */

import type { ReactElement } from 'react'
import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/erp/ipc'
import { Button } from '@erp/components/ui'
import { useToast } from '@erp/components/Toast'
import { unwrap, errorMessage } from '@erp/lib/api'
import { SettingRow, SettingsGroup } from './SettingsLayout'
import { TrashSettings } from './TrashSettings'

export function StorageSettings(): ReactElement {
  const toast = useToast()
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    unwrap(window.api.erp.app.getInfo())
      .then(setInfo)
      .catch((err: unknown) => toast(errorMessage(err), 'error'))
  }, [toast])

  async function reveal(target: 'data' | 'db'): Promise<void> {
    try {
      await unwrap(window.api.erp.app.revealPath(target))
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <>
      <SettingsGroup title="数据位置">
        <SettingRow label="库存数据目录" desc="库存、定制的数据库和图片附件都在这里" path={info?.userDataPath ?? null}>
          <Button onClick={() => void reveal('data')}>打开</Button>
        </SettingRow>
        <SettingRow label="数据库文件" desc="备份时会连同附件一起打包" path={info?.dbPath ?? null}>
          <Button onClick={() => void reveal('db')}>显示位置</Button>
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="存储维护">
        <TrashSettings />
      </SettingsGroup>
    </>
  )
}

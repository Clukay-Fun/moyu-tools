/**
 * 描述: 「开单」分体按钮 (NewDocumentButton)
 * 主要功能:
 *   - 主区域直接新建出库单；右侧箭头展开菜单：出库单、入库单、库存调整、导入 CSV
 */

import React from 'react'
import { ChevronDown, Plus } from 'lucide-react'
import { Menu } from '@erp/components/ui'
import { useEntityDrawers } from '@erp/app/entityDrawers'
import styles from './NewDocumentButton.module.css'

const isMac = navigator.platform.toUpperCase().includes('MAC')

export function NewDocumentButton(): React.JSX.Element {
  const { newDocument, openAdjustment, openImport } = useEntityDrawers()
  return (
    <div className={styles.split}>
      <button
        type="button"
        className={styles.main}
        onClick={() => newDocument('outbound')}
        title={`新建出库单（${isMac ? '⌘N' : 'Ctrl+N'}）`}
      >
        <Plus size={14} /> 开单
      </button>
      <Menu
        align="end"
        trigger={
          <button type="button" className={styles.arrow} aria-label="更多开单选项">
            <ChevronDown size={14} />
          </button>
        }
        items={[
          { key: 'out', label: '出库单', shortcut: isMac ? '⌘N' : 'Ctrl+N', onClick: () => newDocument('outbound') },
          {
            key: 'in',
            label: '入库单',
            shortcut: isMac ? '⇧⌘N' : 'Ctrl+Shift+N',
            onClick: () => newDocument('inbound')
          },
          'separator',
          { key: 'adjust', label: '库存调整', onClick: () => openAdjustment() },
          { key: 'import', label: '导入 CSV', onClick: openImport }
        ]}
      />
    </div>
  )
}

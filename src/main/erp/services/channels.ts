import type { Db } from '../db/connection'
import {
  channelCreateSchema,
  channelUpdateSchema,
  type ChannelCreateInput,
  type ChannelUpdateInput
} from '@shared/erp/schemas'
import type { SalesChannel } from '@shared/erp/types'
import { ServiceError } from './errors'

interface Row {
  id: number
  name: string
  sort_order: number
  is_active: number
}

const toChannel = (r: Row): SalesChannel => ({
  id: r.id,
  name: r.name,
  sortOrder: r.sort_order,
  isActive: r.is_active === 1
})

export function listChannels(db: Db): SalesChannel[] {
  return (db.prepare(`SELECT * FROM sales_channels ORDER BY sort_order, id`).all() as unknown as Row[]).map(toChannel)
}

export function getChannel(db: Db, id: number): SalesChannel {
  const row = db.prepare(`SELECT * FROM sales_channels WHERE id = ?`).get(id) as Row | undefined
  if (!row) throw new ServiceError('NOT_FOUND', '销售渠道不存在')
  return toChannel(row)
}

export function createChannel(db: Db, raw: ChannelCreateInput): SalesChannel {
  const input = channelCreateSchema.parse(raw)
  if (db.prepare(`SELECT 1 FROM sales_channels WHERE name = ?`).get(input.name))
    throw new ServiceError('DUPLICATE_NAME', `渠道「${input.name}」已存在`)
  const { m } = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM sales_channels`).get() as { m: number }
  const { id } = db
    .prepare(`INSERT INTO sales_channels (name, sort_order) VALUES (?, ?) RETURNING id`)
    .get(input.name, m + 1) as { id: number }
  return getChannel(db, id)
}

export function updateChannel(db: Db, id: number, raw: ChannelUpdateInput): SalesChannel {
  const input = channelUpdateSchema.parse(raw)
  getChannel(db, id)
  if (db.prepare(`SELECT 1 FROM sales_channels WHERE name = ? AND id <> ?`).get(input.name, id))
    throw new ServiceError('DUPLICATE_NAME', `渠道「${input.name}」已存在`)
  db.prepare(`UPDATE sales_channels SET name = ?, is_active = ? WHERE id = ?`).run(
    input.name,
    input.isActive ? 1 : 0,
    id
  )
  return getChannel(db, id)
}

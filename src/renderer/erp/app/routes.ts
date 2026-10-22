// 库存 / 定制的页面。导航外壳由摸鱼提供：库存子菜单 概览 · 商品 · 单据，定制子菜单 生产 · 模板 · 素材库。
export type RouteKey = 'overview' | 'products' | 'documents' | 'psd'

export type PsdView = 'production' | 'templates' | 'assets'

/** 库存模块里的三页（挂在 #page-erp） */
export const INVENTORY_ROUTES: Array<Exclude<RouteKey, 'psd'>> = ['overview', 'products', 'documents']

/** 摸鱼设置页里的库存 / 定制分节 */
export type SettingsTarget = 'inventory' | 'custom'

// E0 Spike 页面：验证 React 孤岛、IPC、node:sqlite、moyu-file://。E2 换成概览 / 商品 / 单据。
import { useState } from 'react'
import type { ErpSpikeResult } from '../env'
import styles from './SpikeView.module.css'

export function SpikeView() {
  const [result, setResult] = useState<ErpSpikeResult | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    setError('')
    try {
      setResult(await window.api.erp.spike())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`glass-card ${styles.card}`} data-erp-spike>
      <h2>库存 · 预览</h2>
      <p className={styles.note}>正在并入阿卷 ERP。这一页只用来验证 React、数据库和图片协议是否接通。</p>
      <button className="gbtn" type="button" onClick={run} disabled={busy}>
        {busy ? '写入中…' : '写入一条测试记录'}
      </button>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {result && (
        <dl className={styles.result}>
          <dt>记录数</dt>
          <dd data-erp-count>{result.count}</dd>
          <dt>SQLite</dt>
          <dd>{result.sqlite}</dd>
          <dt>数据库</dt>
          <dd>{result.dbPath}</dd>
          <dt>图片</dt>
          <dd>
            <img src={result.imageUrl} alt="协议测试图" width={64} height={64} data-erp-image />
          </dd>
        </dl>
      )}
    </div>
  )
}

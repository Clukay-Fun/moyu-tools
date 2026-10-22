/** 从 ps 列表里找出 Photoshop 主进程。AdobeIPCBroker 的参数里也会带上 Photoshop 路径，不能算正在运行。 */
export function darwinPhotoshopPids(listing: string): number[] {
  const ids: number[] = []
  for (const line of listing.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.includes('AdobeIPCBroker')) continue
    const match = /^(\d+)\s+/.exec(trimmed)
    if (!match) continue
    if (/\/Contents\/MacOS\/Adobe Photoshop \d+(?:\s|$)/.test(trimmed)) ids.push(Number(match[1]))
  }
  return ids
}

export function windowsPhotoshopPids(tasklist: string): number[] {
  const ids: number[] = []
  for (const line of tasklist.split('\n')) {
    const match = /"Photoshop\.exe","(\d+)"/i.exec(line)
    if (match) ids.push(Number(match[1]))
  }
  return ids
}

/** 并发的启动请求共用同一次启动，避免连续建任务时打开多个 Photoshop。 */
export function createLaunchGate<T>(): { run: (start: () => Promise<T>) => Promise<T> } {
  let pending: Promise<T> | null = null
  return {
    run(start) {
      if (!pending) {
        pending = start().finally(() => {
          pending = null
        })
      }
      return pending
    }
  }
}

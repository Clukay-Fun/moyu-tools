import { open, rename, unlink } from 'node:fs/promises'

/**
 * 原子写：先写同目录下的临时文件，fsync 后再 rename 覆盖。
 *
 * 直接写目标文件的话，进程在写到一半时被杀（而这正是恢复功能要应对的
 * 场景）会留下半个文件，下次启动读到的是"看起来有、其实坏掉"的快照——
 * 比没有快照更糟。rename 在同一文件系统内是原子的。
 */
export async function writeFileAtomic(filePath, data) {
  const temporary = `${filePath}.${process.pid}.tmp`
  const handle = await open(temporary, 'w')
  try {
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    // 只清理这次任务自己创建的临时文件，不碰 filePath 原有内容——
    // 失败时原文件（如果本来就存在）必须原样保留。
    await unlink(temporary).catch(() => {})
    throw error
  }
  await rename(temporary, filePath)
}

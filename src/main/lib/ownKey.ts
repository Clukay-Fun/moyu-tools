/**
 * 按 IPC 传来的键查配置表：只认表里自己的键。
 * 直接 `table[key]` 时，'constructor'、'toString' 这类原型属性也会被当成一项配置。
 */
export function ownValue<T>(table: Readonly<Record<string, T>>, key: unknown): T | undefined {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined
}

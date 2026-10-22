import type { IpcResult, AppError } from '@shared/erp/types'

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** 把 IpcResult 解包成值或抛出 ApiError，页面统一 try/catch。 */
export async function unwrap<T>(p: Promise<IpcResult<T>>): Promise<T> {
  const r = await p
  if (r.ok) return r.data
  throw new ApiError(r.error.code, r.error.message)
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

export type { AppError }

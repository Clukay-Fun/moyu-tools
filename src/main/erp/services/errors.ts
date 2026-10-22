import { ZodError } from 'zod'
import type { AppError } from '@shared/erp/types'

/** 业务错误：带稳定 code，穿过 IPC 后 renderer 可按 code 处理。 */
export class ServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'ServiceError'
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof ServiceError) return { code: err.code, message: err.message }
  if (err instanceof ZodError) {
    const first = err.issues[0]
    const path = first?.path.join('.')
    return { code: 'VALIDATION', message: path ? `${path}: ${first.message}` : (first?.message ?? '输入无效') }
  }
  if (err instanceof Error) return { code: 'INTERNAL', message: err.message }
  return { code: 'INTERNAL', message: String(err) }
}

/**
 * 服务端接口客户端
 * - 门禁：/api/auth 校验 OTP 后由服务端下发 HttpOnly Cookie
 * - 同步：/api/sync/* 读写服务端全局档案
 *
 * 所有请求都走同源相对路径，不依赖任何第三方服务。
 */

export type SyncType = 'dict' | 'setting' | 'practice_word' | 'practice_article'

export type RemoteRow<T = any> = {
  type: SyncType
  data: T
  updated_at?: string
  data_version?: number
}

export type SyncMetaRow = {
  type: SyncType
  updated_at?: string
  data_version?: number
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

/** 已确认的登录态，null 表示尚未确认 */
let authed: boolean | null = null
let authInflight: Promise<boolean> | null = null

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'ApiError'
  }
}

/** 普通请求超时：网络卡住（frp 隧道、蜂窝网切换）时不能让 UI 无限等待 */
const DEFAULT_TIMEOUT = 15000
/**
 * 整份档案写入可能带几 MB 词典数据（自建词库的词表全量上传，实测 15MB 量级），
 * 给足两分钟；结算界面本身不等这么久，见练习页的 SETTLE_REMOTE_TIMEOUT。
 */
const UPLOAD_TIMEOUT = 120000

async function request<T>(path: string, init?: RequestInit & { timeout?: number }): Promise<T> {
  const { timeout = DEFAULT_TIMEOUT, ...rest } = init ?? {}
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  let res: Response
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...rest,
      signal: controller.signal,
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw new ApiError(0, 'TIMEOUT')
    throw error
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 401) {
    authed = false
    throw new ApiError(401, 'UNAUTHORIZED')
  }
  if (!res.ok) {
    let msg = String(res.status)
    try {
      const body = await res.json()
      msg = body?.error ?? msg
    } catch {
      /* 非 JSON 响应 */
    }
    throw new ApiError(res.status, msg)
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}

/** 查询（并缓存）登录态 */
export async function ensureSession(force = false): Promise<boolean> {
  if (!force && authed !== null) return authed
  if (authInflight) return authInflight
  authInflight = (async () => {
    try {
      const res = await request<{ authenticated: boolean }>('/api/auth/session')
      authed = !!res?.authenticated
    } catch {
      authed = false
    } finally {
      authInflight = null
    }
    return authed!
  })()
  return authInflight
}

/** 提交密钥；成功返回 true */
/** 门禁页：首次部署/重置后服务端返回一次 TOTP 密钥与扫码 URI，之后为 null */
export async function getGateOtp(): Promise<{
  totp: string | null
  otpauth: string | null
  digits: number
  period: number
}> {
  return request('/api/auth/gate')
}

export async function login(key: string): Promise<boolean> {
  try {
    await request<{ ok: boolean }>('/api/auth', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ key }),
    })
    authed = true
    return true
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) authed = false
    return false
  }
}

export async function logout(): Promise<void> {
  try {
    await request('/api/auth/logout', { method: 'POST' })
  } catch {
    /* 忽略 */
  }
  authed = false
}

export function isAuthed(): boolean {
  return authed === true
}

/** 读取各类型的最新时间戳，用于冲突比较 */
export async function fetchSyncMeta(types: SyncType[]): Promise<SyncMetaRow[]> {
  if (!types.length) return []
  const rows = await request<SyncMetaRow[]>(`/api/sync/meta?types=${types.join(',')}`)
  return Array.isArray(rows) ? rows : []
}

/** 读取各类型的完整数据 */
export async function fetchSyncData(types: SyncType[]): Promise<RemoteRow[]> {
  if (!types.length) return []
  const rows = await request<RemoteRow[]>(`/api/sync/data?types=${types.join(',')}`)
  return Array.isArray(rows) ? rows : []
}

/** 写入数据，updated_at 由服务端统一打点 */
export async function upsertSyncRows(rows: RemoteRow[]): Promise<boolean> {
  if (!rows.length) return true
  const res = await request<{ ok: boolean }>('/api/sync/upsert', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ rows }),
    timeout: UPLOAD_TIMEOUT,
  })
  return !!res?.ok
}


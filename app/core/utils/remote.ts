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

/**
 * 词典词表（独立于同步行）。
 * 同步行里只放词典元数据，词表按需拉取/推送，避免每次存档都搬十几 MB。
 */
export type DictWordsResult = {
  ok: boolean
  words: unknown[] | null
  updated_at: string | null
}

export async function fetchDictWords(id: string): Promise<DictWordsResult> {
  // 词表可能有好几 MB（服务端已 gzip），给足下载时间
  return request<DictWordsResult>(`/api/dict/words?id=${encodeURIComponent(id)}`, {
    timeout: UPLOAD_TIMEOUT,
  })
}

export async function pushDictWords(
  id: string,
  words: unknown[]
): Promise<{ ok: boolean; updated_at?: string; count?: number }> {
  return request<{ ok: boolean; updated_at?: string; count?: number }>('/api/dict/words', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ id, words }),
    timeout: UPLOAD_TIMEOUT,
  })
}

export async function deleteDictWords(id: string): Promise<void> {
  try {
    await request(`/api/dict/words?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
  } catch (error) {
    console.warn('[dict-words] 远端词表删除失败', error)
  }
}

export type StudyPlanParams = {
  id: string
  /** 从词典第几个词开始取新词（lastLearnIndex） */
  start: number
  /** 当次新词数量（perDayStudyNumber） */
  count: number
  /** 忽略词（内置简单词白名单） */
  ignore?: string[]
  /** fsrs 到期的单词串，服务端解析成完整词条 */
  dueWords?: string[]
  /** 无到期词时的随机复习：从 [0, end) 已学范围里随机挑 count 个 */
  randomReview?: { end: number; count: number } | null
  /** 乱序模式：在 [start, end) 区间随机挑 count 个 */
  shuffle?: { start: number; end: number; count: number } | null
  /** 单词测试：从词典里随机抽 count 个作为题库 */
  test?: { count: number; from?: number; to?: number } | null
  /** 只做词条解析（练习缓存恢复时用），不生成任务 */
  extraWords?: string[]
}

export type StudyPlanResult = {
  ok: boolean
  newWords: unknown[]
  reviewWords: unknown[]
  randomCount: number
  shuffleWords: unknown[] | null
  pool: unknown[] | null
  extraWords: unknown[]
  length: number
  remainingNew: number
}

/** 向服务端要「当次学习量」：新词 + 到期复习词，客户端不再整份下载词表 */
export async function fetchStudyPlan(params: StudyPlanParams): Promise<StudyPlanResult> {
  return request<StudyPlanResult>('/api/dict/words/plan', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(params),
    timeout: DEFAULT_TIMEOUT,
  })
}

/** 词表合并（导入/加入词典）：服务端去重后追加，返回新增数量 */
export async function mergeDictWords(
  id: string,
  words: unknown[],
  skipDuplicate = true
): Promise<{ ok: boolean; added: number; skipped: number; total: number; updated_at?: string }> {
  return request('/api/dict/words/merge', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ id, words, skipDuplicate }),
    timeout: UPLOAD_TIMEOUT,
  })
}


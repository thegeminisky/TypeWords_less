#!/usr/bin/env node
// TypeWords 应用服务器
// - 门禁：TOTP 动态码（RFC 6238，30s 滚动）。首次部署/重置后门禁页展示二维码
//   供验证器 App 扫码绑定，登录成功后二维码隐藏；重置: node server.mjs reset-otp
// - 同步：/api/sync/* 读写服务端 JSON（全局单一档案，所有浏览器共享）
// - 静态：托管 web/ 下的构建产物，未命中回退 200.html（SPA）

import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { createReadStream } from 'node:fs'

const ROOT = path.resolve(process.env.ROOT || path.join(import.meta.dirname, 'web'))
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, 'data'))
const PORT = Number(process.env.PORT || 8300)
const HOST = process.env.HOST || '127.0.0.1' // 默认只听本地回环，公网访问请走 SSH 隧道/反代
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30 // 30 天
const MAX_BODY = 32 * 1024 * 1024 // 32MB：大词典导入后的同步负载 ~20MB（该接口在登录态之后才读 body）

const STATE_FILE = path.join(DATA_DIR, 'state.json')
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json')
const GATE_FILE = path.join(DATA_DIR, 'gate.json')
/** 词典词表单独落盘：<DATA_DIR>/words/<dictId>.json
 *  同步行（state.json 里的 dict）只保留元数据，避免每次存档都搬 15MB 词表 */
const WORDS_DIR = path.join(DATA_DIR, 'words')
const SYNC_TYPES = ['dict', 'setting', 'practice_word', 'practice_article']

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
}

// ---------------- TOTP 门禁（RFC 6238：SHA1 / 6 位 / 30s，验证器 App 扫码绑定） ----------------

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const TOTP_PERIOD = 30
const TOTP_DIGITS = 6
const TOTP_WINDOW = 1 // 允许前后各 1 个步长，容忍手机时钟偏差
const TOTP_ISSUER = 'TypeWords'

function sha256(v) {
  return crypto.createHash('sha256').update(String(v), 'utf8').digest('hex')
}

function base32Encode(buf) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]
  return out
}

function base32Decode(str) {
  const clean = String(str).replace(/=+$/, '').replace(/\s/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out = []
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch)
    if (idx < 0) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

function genTotpSecret() {
  // 20 字节 = 160 位，验证器 App 的标准强度
  return base32Encode(crypto.randomBytes(20))
}

function totpUri(secret) {
  const label = encodeURIComponent(`${TOTP_ISSUER}:gate`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${TOTP_ISSUER}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`
}

function totpAt(secretBuf, step) {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(step))
  const hmac = crypto.createHmac('sha1', secretBuf).update(msg).digest()
  const off = hmac[hmac.length - 1] & 0xf
  const code = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3]
  return String(code % 1e6).padStart(TOTP_DIGITS, '0')
}

function currentStep() {
  return Math.floor(Date.now() / 1000 / TOTP_PERIOD)
}

/** 校验动态码，命中返回对应的 step，否则 -1 */
function verifyTotp(secretB32, input) {
  const clean = String(input).replace(/\D/g, '')
  if (clean.length !== TOTP_DIGITS) return -1
  const buf = base32Decode(secretB32)
  const step = currentStep()
  for (let i = -TOTP_WINDOW; i <= TOTP_WINDOW; i++) {
    if (totpAt(buf, step + i) === clean) return step + i
  }
  return -1
}

/** @type {{totp:string, createdAt:number, reveal:boolean, lastUsedStep?:number} | null} */
let gate = null
let gateLoadedAt = 0

/**
 * 读取门禁状态（带 1s 缓存，便于运行中的实例感知命令行重置）。
 * 文件缺失/损坏/是旧版静态 OTP（无 totp 字段）时生成新密钥：
 * otpauth URI 打印到日志，门禁页展示一次二维码（reveal=true）。
 */
function loadGate(force = false) {
  const now = Date.now()
  if (!force && gate && now - gateLoadedAt < 1000) return gate
  gateLoadedAt = now
  try {
    const raw = JSON.parse(fs.readFileSync(GATE_FILE, 'utf8'))
    gate = raw?.totp
      ? { totp: raw.totp, createdAt: raw.createdAt || now, reveal: !!raw.reveal, revealUntil: raw.revealUntil || 0, lastUsedStep: raw.lastUsedStep || 0 }
      : null
  } catch {
    gate = null
  }
  if (!gate) gate = createGate()
  // 展示时效：超时或旧数据没有时效字段的，一律视为已过期
  if (gate.reveal && (!gate.revealUntil || now > gate.revealUntil)) {
    gate.reveal = false
    void persistGate(gate)
  }
  return gate
}

function createGate() {
  const totp = genTotpSecret()
  // 二维码只展示 10 分钟：防止部署/重置后长时间挂在网上被他人抢先绑定
  const g = { totp, createdAt: Date.now(), reveal: true, revealUntil: Date.now() + 10 * 60 * 1000, lastUsedStep: 0 }
  void persistGate(g)
  console.log('')
  console.log('[gate] 已生成 TOTP 密钥，用验证器 App 扫门禁页二维码绑定')
  console.log(`[gate] otpauth: ${totpUri(totp)}`)
  console.log(`[gate] 手动输入密钥: ${totp}`)
  console.log('[gate] 二维码仅展示一次，登录成功后不再显示；重置请运行: node server.mjs reset-otp')
  console.log('')
  return g
}

async function persistGate(g) {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true })
    await atomicWrite(GATE_FILE, JSON.stringify(g, null, 2))
    await fsp.chmod(GATE_FILE, 0o600).catch(() => {})
  } catch (e) {
    console.error('[gate] persist failed', e)
  }
}

// 登录失败限速：10 分钟窗口内失败 8 次 → 拒绝 1 分钟
const gateFails = new Map() // ip -> { count, firstAt, blockedUntil }
const FAIL_WINDOW = 10 * 60 * 1000
const FAIL_MAX = 8
const BLOCK_MS = 60 * 1000

function gateBlocked(ip) {
  const rec = gateFails.get(ip)
  if (!rec) return 0
  if (rec.blockedUntil && rec.blockedUntil > Date.now()) return Math.ceil((rec.blockedUntil - Date.now()) / 1000)
  if (Date.now() - rec.firstAt > FAIL_WINDOW) gateFails.delete(ip)
  return 0
}

// 通用速率限制（内存桶），用于同步接口与门禁查询
const rateBuckets = new Map() // key -> { count, firstAt }
function hitRateLimit(key, max, windowMs) {
  const now = Date.now()
  const rec = rateBuckets.get(key)
  if (!rec || now - rec.firstAt > windowMs) {
    rateBuckets.set(key, { count: 1, firstAt: now })
    return true
  }
  rec.count++
  return rec.count <= max
}

function gateRecordFail(ip) {
  const rec = gateFails.get(ip)
  const now = Date.now()
  if (!rec || now - rec.firstAt > FAIL_WINDOW) {
    gateFails.set(ip, { count: 1, firstAt: now, blockedUntil: 0 })
    return
  }
  rec.count++
  if (rec.count >= FAIL_MAX) rec.blockedUntil = now + BLOCK_MS
}

// ---------------- 会话 ----------------// ---------------- 会话 ----------------

/** @type {Map<string, number>} token -> expiresAt */
let sessions = new Map()

function loadSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'))
    const now = Date.now()
    Object.entries(raw).forEach(([k, v]) => {
      if (typeof v === 'number' && v > now) sessions.set(k, v)
    })
  } catch {
    /* 首次运行无文件 */
  }
}

let sessionSaveTimer = null
function saveSessions() {
  clearTimeout(sessionSaveTimer)
  sessionSaveTimer = setTimeout(async () => {
    try {
      const obj = Object.fromEntries(sessions)
      await fsp.mkdir(DATA_DIR, { recursive: true })
      await atomicWrite(SESSION_FILE, JSON.stringify(obj))
      await fsp.chmod(SESSION_FILE, 0o600).catch(() => {})
    } catch (e) {
      console.error('[session] save failed', e)
    }
  }, 500)
}

function parseCookies(header = '') {
  const out = {}
  header.split(';').forEach(part => {
    const idx = part.indexOf('=')
    if (idx < 0) return
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim())
  })
  return out
}

function getSession(req) {
  const token = parseCookies(req.headers.cookie || '').tw_sess
  if (!token) return null
  const exp = sessions.get(token)
  if (!exp) return null
  if (exp < Date.now()) {
    sessions.delete(token)
    saveSessions()
    return null
  }
  return token
}

function setSessionCookie(res, token, maxAgeSec) {
  res.setHeader(
    'Set-Cookie',
    `tw_sess=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`
  )
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

// ---------------- 数据存储 ----------------

/** @type {Record<string, {data:any, updated_at:string, data_version:number}>} */
let state = {}

const DEFAULT_VERSION = { dict: 4, setting: 23, practice_word: 2, practice_article: 1 }

function loadState() {
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}
  } catch {
    state = {}
  }
}

async function atomicWrite(file, content) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fsp.writeFile(tmp, content, 'utf8')
  await fsp.rename(tmp, file)
}

let stateWriteChain = Promise.resolve()
function persistState() {
  const snapshot = JSON.stringify(state)
  stateWriteChain = stateWriteChain
    .then(() => atomicWrite(STATE_FILE, snapshot))
    .catch(e => console.error('[state] write failed', e))
  return stateWriteChain
}

// ---------------- 词典词表（独立文件） ----------------

/** 词典 id 只允许安全字符，避免路径穿越 */
function isSafeDictId(id) {
  return typeof id === 'string' && /^[\w-]{1,80}$/.test(id)
}

function wordsFilePath(id) {
  return path.join(WORDS_DIR, `${id}.json`)
}

async function readWordsFile(id) {
  if (!isSafeDictId(id)) return null
  try {
    const parsed = JSON.parse(await fsp.readFile(wordsFilePath(id), 'utf8'))
    if (!parsed || !Array.isArray(parsed.words)) return null
    return { words: parsed.words, updated_at: parsed.updated_at || null }
  } catch {
    return null
  }
}

async function writeWordsFile(id, words) {
  const updated_at = new Date().toISOString()
  const file = wordsFilePath(id)
  await fsp.mkdir(WORDS_DIR, { recursive: true })
  // 覆盖前留一份上一版，万一客户端推了空数组还能捞回来
  try {
    await fsp.copyFile(file, `${file}.bak`)
  } catch {
    /* 首次写入没有旧文件 */
  }
  await atomicWrite(file, JSON.stringify({ id, updated_at, words }))
  return updated_at
}

async function removeWordsFile(id) {
  if (!isSafeDictId(id)) return
  await fsp.rm(wordsFilePath(id), { force: true }).catch(() => {})
  await fsp.rm(`${wordsFilePath(id)}.bak`, { force: true }).catch(() => {})
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
}

/**
 * 启动时把历史存档里内联的词典词表拆到 words/ 目录。
 * 老版本把整份词表塞在 dict 同步行里（实测 15MB），拆完同步行只剩几十 KB。
 */
async function splitInlineDictWords() {
  const list = state?.dict?.data?.word?.bookList
  if (!Array.isArray(list)) return
  let changed = 0
  for (const dict of list) {
    if (!dict || !Array.isArray(dict.words) || !dict.words.length) continue
    const id = String(dict.id ?? '')
    if (!isSafeDictId(id)) continue
    const updated_at = await writeWordsFile(id, dict.words)
    dict.length = dict.words.length
    dict.wordsUpdatedAt = updated_at
    dict.words = []
    changed++
  }
  if (changed) {
    await persistState()
    console.log(`[typewords] 已把 ${changed} 本词典的词表拆到 ${WORDS_DIR}`)
  }
}

// ---------------- HTTP 工具 ----------------

// 全站基础安全响应头（HTTPS 上线后再补 HSTS）
const SEC_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
}

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    ...SEC_HEADERS,
  })
  res.end(buf)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) {
        // 丢弃剩余数据并正常拒绝，而不是直接断连（客户端能收到 400）
        req.removeAllListeners('data')
        req.resume()
        reject(new Error('BODY_TOO_LARGE'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const raw = await readBody(req)
  if (!raw) return {}
  return JSON.parse(raw)
}

// ---------------- 静态文件 ----------------

function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

function cacheControl(file, urlPath) {
  if (urlPath.startsWith('/_nuxt/')) return 'public, max-age=31536000, immutable'
  if (file.endsWith('.html')) return 'public, max-age=0, must-revalidate'
  if (/\.(png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|mp3|wav|ogg|mp4|webm)$/i.test(file)) {
    return 'public, max-age=604800'
  }
  return 'public, max-age=3600'
}

async function statFile(p) {
  try {
    const st = await fsp.stat(p)
    return st.isFile() ? st : null
  } catch {
    return null
  }
}

async function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0])
  const safePath = path.posix.normalize(decoded)
  if (safePath.includes('\0')) return null
  const abs = path.join(ROOT, safePath)
  if (!abs.startsWith(ROOT)) return null

  const direct = await statFile(abs)
  if (direct) return { file: abs, stat: direct }

  if (decoded.endsWith('/')) {
    const idx = path.join(abs, 'index.html')
    const st = await statFile(idx)
    return st ? { file: idx, stat: st } : null
  }

  const asDir = await statFile(path.join(abs, 'index.html'))
  if (asDir) return { file: path.join(abs, 'index.html'), stat: asDir }

  const asHtml = await statFile(`${abs}.html`)
  if (asHtml) return { file: `${abs}.html`, stat: asHtml }

  return null
}

async function resolveFallback() {
  for (const name of ['200.html', 'index.html']) {
    const p = path.join(ROOT, name)
    const st = await statFile(p)
    if (st) return { file: p, stat: st }
  }
  return null
}

function sendFile(req, res, file, st, status = 200, urlPath = req.url) {
  const headers = {
    'Content-Type': contentType(file),
    'Content-Length': st.size,
    'Cache-Control': cacheControl(file, urlPath),
    'X-Content-Type-Options': 'nosniff',
    ...SEC_HEADERS,
  }
  if (req.method === 'HEAD') {
    res.writeHead(status, headers)
    return res.end()
  }
  res.writeHead(status, headers)
  const stream = createReadStream(file)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

// ---------------- API ----------------

async function handleApi(req, res, url) {
  const p = url.pathname

  // 登录态查询（无需鉴权）
  if (p === '/api/auth/session' && req.method === 'GET') {
    return json(res, 200, { authenticated: !!getSession(req) })
  }

  // 门禁页查询：仅首次部署/重置后（reveal=true）返回 TOTP 密钥与扫码 URI，登录成功即隐藏
  if (p === '/api/auth/gate' && req.method === 'GET') {
    if (!hitRateLimit(`gate:${req.socket.remoteAddress}`, 20, 60 * 1000)) {
      return json(res, 429, { ok: false, error: 'TOO_MANY_REQUESTS' })
    }
    const g = loadGate()
    return json(res, 200, {
      totp: g.reveal ? g.totp : null,
      otpauth: g.reveal ? totpUri(g.totp) : null,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD,
    })
  }

  if (p === '/api/auth' && req.method === 'POST') {
    let body
    try {
      body = await readJson(req)
    } catch {
      return json(res, 400, { ok: false, error: 'BAD_REQUEST' })
    }
    const ip = req.socket.remoteAddress || 'unknown'
    const blocked = gateBlocked(ip)
    if (blocked) {
      return json(res, 429, { ok: false, error: 'TOO_MANY_ATTEMPTS', retryAfter: blocked })
    }
    const g = loadGate()
    const input = String(body?.key ?? '').trim()
    const usedStep = verifyTotp(g.totp, input)
    if (usedStep < 0) {
      gateRecordFail(ip)
      // 简单延时，削弱暴力尝试
      await new Promise(r => setTimeout(r, 400))
      return json(res, 401, { ok: false, error: 'INVALID_KEY' })
    }
    // 防重放：同一 30s 窗口的动态码只能用一次
    if (g.lastUsedStep && usedStep <= g.lastUsedStep) {
      return json(res, 401, { ok: false, error: 'CODE_REUSED' })
    }
    gateFails.delete(ip)
    g.lastUsedStep = usedStep
    // 首次用该密钥登录成功：门禁页不再展示二维码
    if (g.reveal) {
      g.reveal = false
      void persistGate(g)
    }
    const token = crypto.randomBytes(32).toString('hex')
    sessions.set(token, Date.now() + SESSION_TTL)
    saveSessions()
    setSessionCookie(res, token, Math.floor(SESSION_TTL / 1000))
    return json(res, 200, { ok: true })
  }

  if (p === '/api/auth/logout' && req.method === 'POST') {
    const token = getSession(req)
    if (token) {
      sessions.delete(token)
      saveSessions()
    }
    setSessionCookie(res, '', 0)
    return json(res, 200, { ok: true })
  }

  // 以下接口都需要登录
  if (!getSession(req)) return json(res, 401, { ok: false, error: 'UNAUTHORIZED' })

  // 词典词表：独立资源，按需读写，避免整份存档搬大词表
  if (p === '/api/dict/words') {
    const ip = req.socket.remoteAddress || 'unknown'
    if (!hitRateLimit(`dictwords:${ip}`, 120, 60 * 1000)) {
      return json(res, 429, { ok: false, error: 'TOO_MANY_REQUESTS' })
    }

    if (req.method === 'GET') {
      const id = url.searchParams.get('id') || ''
      if (!isSafeDictId(id)) return json(res, 400, { ok: false, error: 'BAD_ID' })
      const found = await readWordsFile(id)
      const body = JSON.stringify({ ok: true, words: found?.words ?? null, updated_at: found?.updated_at ?? null })
      // 词表动辄几 MB，浏览器都支持 gzip，压完传输量降到 1/4 左右
      const acceptsGzip = String(req.headers['accept-encoding'] || '').includes('gzip')
      if (acceptsGzip && body.length > 1024) {
        const gz = zlib.gzipSync(Buffer.from(body))
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Content-Length': gz.length,
          'Cache-Control': 'no-store',
          Vary: 'Accept-Encoding',
          ...SEC_HEADERS,
        })
        return res.end(gz)
      }
      return json(res, 200, JSON.parse(body))
    }

    if (req.method === 'POST') {
      let body
      try {
        body = await readJson(req)
      } catch {
        return json(res, 400, { ok: false, error: 'BAD_REQUEST' })
      }
      const id = String(body?.id ?? '')
      const words = body?.words
      if (!isSafeDictId(id) || !Array.isArray(words)) {
        return json(res, 400, { ok: false, error: 'BAD_REQUEST' })
      }
      const updated_at = await writeWordsFile(id, words)
      return json(res, 200, { ok: true, updated_at, count: words.length })
    }

    if (req.method === 'DELETE') {
      const id = url.searchParams.get('id') || ''
      if (!isSafeDictId(id)) return json(res, 400, { ok: false, error: 'BAD_ID' })
      await removeWordsFile(id)
      return json(res, 200, { ok: true })
    }

    return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' })
  }

  // 按当次学习量取词：客户端不再整份下载词表，由服务端算好本次要学的词
  if (p === '/api/dict/words/plan' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown'
    if (!hitRateLimit(`dictplan:${ip}`, 120, 60 * 1000)) {
      return json(res, 429, { ok: false, error: 'TOO_MANY_REQUESTS' })
    }
    let body
    try {
      body = await readJson(req)
    } catch {
      return json(res, 400, { ok: false, error: 'BAD_REQUEST' })
    }
    const id = String(body?.id ?? '')
    if (!isSafeDictId(id)) return json(res, 400, { ok: false, error: 'BAD_ID' })
    const found = await readWordsFile(id)
    const words = found?.words ?? []
    const ignore = new Set(Array.isArray(body?.ignore) ? body.ignore.map(String) : [])
    const start = Math.max(0, Math.floor(Number(body?.start) || 0))
    const count = Math.max(0, Math.floor(Number(body?.count) || 0))
    const taken = new Set()

    // 新词：从 start 往后跳过忽略词，取 count 个
    const newWords = []
    let skipped = 0
    if (!body?.shuffle && !body?.test) {
      for (let i = start; i < words.length && newWords.length < count; i++) {
        const w = words[i]
        if (!w || !w.word || ignore.has(w.word)) {
          skipped++
          continue
        }
        newWords.push(w)
        taken.add(w.word)
      }
    }

    const byWord = new Map(words.map(w => [String(w?.word ?? ''), w]))

    // 复习词：客户端把 fsrs 到期的单词串发过来，服务端解析成完整词条
    const reviewWords = []
    const dueList = Array.isArray(body?.dueWords) ? body.dueWords.map(String) : []
    for (const key of dueList) {
      if (taken.has(key) || ignore.has(key)) continue
      const w = byWord.get(key)
      if (!w) continue
      reviewWords.push(w)
      taken.add(key)
    }

    // 没有到期词时的随机复习：从已学范围 [0, end) 里随机挑
    let randomCount = 0
    if (body?.random && Number(body.random.count) > 0) {
      const end = Math.min(Math.max(0, Math.floor(Number(body.random.end) || 0)), words.length)
      const pool = words.slice(0, end).filter(w => w?.word && !taken.has(w.word) && !ignore.has(w.word))
      shuffleInPlace(pool)
      for (const w of pool.slice(0, Math.floor(Number(body.random.count)))) {
        reviewWords.push(w)
        taken.add(w.word)
        randomCount++
      }
    }

    // 随机复习/乱序模式：在指定区间里随机挑 count 个
    let shuffleWords = null
    let shuffleAvailable = 0
    if (body?.shuffle) {
      const s = Math.max(0, Math.floor(Number(body.shuffle.start) || 0))
      const e = Math.min(Math.max(0, Math.floor(Number(body.shuffle.end) || 0)), words.length)
      const c = Math.max(0, Math.floor(Number(body.shuffle.count) || 0))
      const pool = words.slice(s, e).filter(w => w?.word && !ignore.has(w.word))
      shuffleAvailable = pool.length
      shuffleInPlace(pool)
      shuffleWords = pool.slice(0, c)
    }

    // 单词测试：从词典里随机抽一批作为题库与干扰项
    let pool = null
    if (body?.test) {
      const c = Math.max(1, Math.floor(Number(body.test.count) || 100))
      const from = Math.max(0, Math.floor(Number(body.test.from) || 0))
      const to = Math.min(Math.max(0, Math.floor(Number(body.test.to) || 0)) || words.length, words.length)
      const poolArr = words.slice(from, to).filter(w => w?.word)
      shuffleInPlace(poolArr)
      pool = poolArr.slice(0, c)
    }

    // 补充解析：练习缓存恢复时只有单词串，这里换回完整词条
    const extra = Array.isArray(body?.extraWords) ? body.extraWords.map(String) : []
    const extraWords = extra.map(key => byWord.get(key)).filter(Boolean)

    return json(res, 200, {
      ok: true,
      newWords,
      reviewWords,
      randomCount,
      shuffleWords,
      shuffleAvailable,
      pool,
      extraWords,
      length: words.length,
      remainingNew: Math.max(0, words.length - start - skipped),
    })
  }

  // 词表合并（导入/收藏到词典）：服务端去重后追加，客户端不必拉整份词表
  if (p === '/api/dict/words/merge' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown'
    if (!hitRateLimit(`dictmerge:${ip}`, 60, 60 * 1000)) {
      return json(res, 429, { ok: false, error: 'TOO_MANY_REQUESTS' })
    }
    let body
    try {
      body = await readJson(req)
    } catch {
      return json(res, 400, { ok: false, error: 'BAD_REQUEST' })
    }
    const id = String(body?.id ?? '')
    const incoming = Array.isArray(body?.words) ? body.words : []
    if (!isSafeDictId(id) || !incoming.length) return json(res, 400, { ok: false, error: 'BAD_REQUEST' })
    const skipDuplicate = body?.skipDuplicate !== false
    const existing = (await readWordsFile(id))?.words ?? []
    const byWord = new Map(existing.map(w => [String(w?.word ?? '').toLowerCase(), w]))
    const added = []
    let skipped = 0
    for (const w of incoming) {
      if (!w || !w.word) continue
      const key = String(w.word).toLowerCase()
      if (skipDuplicate && byWord.has(key)) {
        skipped++
        continue
      }
      byWord.set(key, w)
      added.push(w)
    }
    const all = existing.concat(added)
    const updated_at = await writeWordsFile(id, all)
    return json(res, 200, { ok: true, added: added.length, skipped, total: all.length, updated_at })
  }

  // 同步接口整体限速：120 次/分钟/IP
  if (p.startsWith('/api/sync/') && !hitRateLimit(`sync:${req.socket.remoteAddress}`, 120, 60 * 1000)) {
    return json(res, 429, { ok: false, error: 'TOO_MANY_REQUESTS' })
  }

  if (p === '/api/sync/meta' && req.method === 'GET') {
    const types = (url.searchParams.get('types') || SYNC_TYPES.join(','))
      .split(',')
      .map(s => s.trim())
      .filter(s => SYNC_TYPES.includes(s))
    const rows = types
      .filter(t => state[t])
      .map(t => ({ type: t, updated_at: state[t].updated_at, data_version: state[t].data_version }))
    return json(res, 200, rows)
  }

  if (p === '/api/sync/data' && req.method === 'GET') {
    const types = (url.searchParams.get('types') || SYNC_TYPES.join(','))
      .split(',')
      .map(s => s.trim())
      .filter(s => SYNC_TYPES.includes(s))
    const rows = types
      .filter(t => state[t])
      .map(t => ({
        type: t,
        data: state[t].data,
        updated_at: state[t].updated_at,
        data_version: state[t].data_version,
      }))
    return json(res, 200, rows)
  }

  if (p === '/api/sync/upsert' && req.method === 'POST') {
    let body
    try {
      body = await readJson(req)
    } catch {
      return json(res, 400, { ok: false, error: 'BAD_REQUEST' })
    }
    const rows = Array.isArray(body?.rows) ? body.rows : []
    const now = new Date().toISOString()
    const applied = []
    for (const row of rows) {
      if (!row || !SYNC_TYPES.includes(row.type)) continue
      state[row.type] = {
        data: row.data ?? null,
        // updated_at 一律以服务端时间为准，避免各浏览器时钟不一致
        updated_at: now,
        data_version: Number(row.data_version ?? DEFAULT_VERSION[row.type] ?? 1),
      }
      applied.push(row.type)
    }
    if (!applied.length) return json(res, 400, { ok: false, error: 'NO_VALID_ROWS' })
    await persistState()
    return json(res, 200, { ok: true, applied, updated_at: now })
  }

  return json(res, 404, { ok: false, error: 'NOT_FOUND' })
}

// ---------------- 主服务 ----------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    if (url.pathname.startsWith('/api/')) {
      return await handleApi(req, res, url)
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('Method Not Allowed')
    }

    const urlPath = url.pathname
    const hit = await resolveFile(urlPath)
    if (hit) return sendFile(req, res, hit.file, hit.stat, 200, urlPath)

    if (path.extname(urlPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end('Not Found')
    }

    const fb = await resolveFallback()
    if (!fb) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('Not Found')
    }
    return sendFile(req, res, fb.file, fb.stat, 200, urlPath)
  } catch (err) {
    console.error('[server] error', err)
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    }
    res.end('Internal Server Error')
  }
})

server.keepAliveTimeout = 30000
server.headersTimeout = 35000

// 命令行重置：node server.mjs reset-otp
// 生成新 OTP 并打印；运行中的实例会在下一次门禁请求时自动读取（1s 缓存），无需重启
if (process.argv[2] === 'reset-otp' || process.argv[2] === '--reset-otp') {
  await (async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true })
    const totp = genTotpSecret()
    // revealUntil 必须带上：否则时效逻辑会把它当旧数据立即过期，二维码刚生成就被藏起来
    const g = { totp, createdAt: Date.now(), reveal: true, revealUntil: Date.now() + 10 * 60 * 1000, lastUsedStep: 0 }
    await atomicWrite(GATE_FILE, JSON.stringify(g, null, 2))
    console.log('[gate] 已重置 TOTP 密钥，旧绑定即刻失效')
    console.log(`[gate] 扫码 URI: ${totpUri(totp)}`)
    console.log(`[gate] 手动输入密钥: ${totp}`)
    console.log(`[gate] 当前动态码: ${totpAt(base32Decode(totp), currentStep())}（${TOTP_PERIOD}s 有效）`)
    console.log('[gate] 门禁页会展示一次二维码，登录成功后隐藏')
  })()
  process.exit(0)
}

async function main() {
  await fsp.mkdir(DATA_DIR, { recursive: true })
  loadState()
  loadSessions()
  await splitInlineDictWords()
  server.listen(PORT, HOST, () => {
    console.log(`[typewords] static ${ROOT}`)
    console.log(`[typewords] data   ${DATA_DIR}`)
    console.log(`[typewords] listen http://${HOST}:${PORT}`)
  })
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    try {
      await stateWriteChain
    } catch {
      /* ignore */
    }
    server.close(() => process.exit(0))
  })
}

main()

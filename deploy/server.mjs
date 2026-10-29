#!/usr/bin/env node
// TypeWords 应用服务器
// - 门禁：OTP 访问码。首次部署/重置后门禁页明文展示一次，登录成功即隐藏；
//   服务端只存 sha256；重置必须通过命令行: node server.mjs reset-otp
// - 同步：/api/sync/* 读写服务端 JSON（全局单一档案，所有浏览器共享）
// - 静态：托管 web/ 下的构建产物，未命中回退 200.html（SPA）

import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { createReadStream } from 'node:fs'

const ROOT = path.resolve(process.env.ROOT || path.join(import.meta.dirname, 'web'))
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, 'data'))
const PORT = Number(process.env.PORT || 8300)
const HOST = process.env.HOST || '0.0.0.0'
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30 // 30 天
const MAX_BODY = 32 * 1024 * 1024 // 32MB，词库数据可能较大

const STATE_FILE = path.join(DATA_DIR, 'state.json')
const SESSION_FILE = path.join(DATA_DIR, 'sessions.json')
const GATE_FILE = path.join(DATA_DIR, 'gate.json')
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

// ---------------- OTP 门禁 ----------------

// 去掉易混淆字符（i/l/o/0/1）的小写字母数字表，手机上好敲
const OTP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const OTP_LENGTH = 8

function sha256(v) {
  return crypto.createHash('sha256').update(String(v), 'utf8').digest('hex')
}

function genOtp() {
  const out = []
  for (let i = 0; i < OTP_LENGTH; i++) out.push(OTP_ALPHABET[crypto.randomInt(OTP_ALPHABET.length)])
  return out.join('')
}

/** @type {{otp?:string, otpHash:string, createdAt:number, reveal:boolean} | null} */
let gate = null
let gateLoadedAt = 0

/**
 * 读取门禁状态（带 1s 缓存，便于运行中的实例感知命令行重置）。
 * 文件不存在/损坏时生成新 OTP：明文打印到日志 + 门禁页展示一次（reveal=true）。
 */
function loadGate(force = false) {
  const now = Date.now()
  if (!force && gate && now - gateLoadedAt < 1000) return gate
  gateLoadedAt = now
  try {
    const raw = JSON.parse(fs.readFileSync(GATE_FILE, 'utf8'))
    gate = raw?.otpHash ? { otp: raw.otp || undefined, otpHash: raw.otpHash, createdAt: raw.createdAt || now, reveal: !!raw.reveal } : null
  } catch {
    gate = null
  }
  if (!gate) gate = createGate()
  return gate
}

function createGate() {
  const otp = genOtp()
  const g = { otp, otpHash: sha256(otp), createdAt: Date.now(), reveal: true }
  void persistGate(g)
  console.log('')
  console.log(`[gate] 本次部署的 OTP 访问码: ${otp}`)
  console.log('[gate] 门禁页会展示一次，登录成功后不再显示；忘记请运行: node server.mjs reset-otp')
  console.log('')
  return g
}

async function persistGate(g) {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true })
    await atomicWrite(GATE_FILE, JSON.stringify(g, null, 2))
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

// ---------------- 会话 ----------------

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

// ---------------- HTTP 工具 ----------------

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
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
        reject(new Error('BODY_TOO_LARGE'))
        req.destroy()
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

  // 门禁页查询：仅首次部署/重置后（reveal=true）返回明文 OTP，登录成功即隐藏
  if (p === '/api/auth/gate' && req.method === 'GET') {
    const g = loadGate()
    return json(res, 200, { otp: g.reveal && g.otp ? g.otp : null, length: OTP_LENGTH })
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
    const input = String(body?.key ?? '').trim().toLowerCase()
    if (!timingSafeEqualStr(sha256(input), g.otpHash)) {
      gateRecordFail(ip)
      // 简单延时，削弱暴力尝试
      await new Promise(r => setTimeout(r, 400))
      return json(res, 401, { ok: false, error: 'INVALID_KEY' })
    }
    gateFails.delete(ip)
    // 首次用该 OTP 登录成功：门禁页不再展示明文，磁盘上也只保留哈希
    if (g.reveal || g.otp) {
      g.reveal = false
      delete g.otp
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

  if (p === '/api/sync/reset' && req.method === 'POST') {
    state = {}
    await persistState()
    return json(res, 200, { ok: true })
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
    const otp = genOtp()
    const g = { otp, otpHash: sha256(otp), createdAt: Date.now(), reveal: true }
    await atomicWrite(GATE_FILE, JSON.stringify(g, null, 2))
    console.log(`[gate] 已重置，新 OTP 访问码: ${otp}`)
    console.log('[gate] 门禁页会展示一次，登录成功后隐藏')
  })()
  process.exit(0)
}

async function main() {
  await fsp.mkdir(DATA_DIR, { recursive: true })
  loadState()
  loadSessions()
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

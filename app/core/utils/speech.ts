/**
 * 浏览器语音合成（Web Speech API）封装
 *
 * 目标：桌面端（Edge / Chrome，含 Edge 在线自然音色）与移动端（iOS Safari、
 * Android Chrome）都能稳定发音。移动端有两个已知坑：
 *   1. getVoices() 首次可能返回空数组，要等 voiceschanged 事件；
 *   2. iOS 要求首次 speak 必须由用户手势触发，否则静默失败。
 * 所以这里做「手势预热 + 语音列表异步等待 + 长文本分片」三件事。
 */

export interface SpeakOptions {
  rate?: number
  volume?: number
  pitch?: number
  lang?: string
  /** 指定音色名，未命中则用默认英文音色 */
  voiceName?: string
  onEnd?: () => void
  onStart?: () => void
}

const isClient = () => typeof window !== 'undefined' && typeof window.speechSynthesis !== 'undefined'

let voicesCache: SpeechSynthesisVoice[] = []
let voicesReady = false
let unlocked = false
let priming = false

/** 读取当前可用语音，必要时等待 voiceschanged */
function loadVoices(timeout = 1200): Promise<SpeechSynthesisVoice[]> {
  if (!isClient()) return Promise.resolve([])
  const synth = window.speechSynthesis

  const read = () => {
    const list = synth.getVoices()
    if (list && list.length) {
      voicesCache = list
      voicesReady = true
    }
    return list || []
  }

  const immediate = read()
  if (immediate.length) return Promise.resolve(immediate)
  if (voicesReady && voicesCache.length) return Promise.resolve(voicesCache)

  return new Promise(resolve => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      synth.removeEventListener?.('voiceschanged', finish)
      resolve(read())
    }
    synth.addEventListener?.('voiceschanged', finish)
    // 安卓部分浏览器不会触发该事件，兜底轮询一次
    setTimeout(finish, timeout)
  })
}

/** 英文音色优先：本地音色靠前，Edge 的自然音色优先 */
export function getEnglishVoices(): Promise<SpeechSynthesisVoice[]> {
  return loadVoices().then(list => {
    const english = list.filter(v => v.lang?.toLowerCase().startsWith('en'))
    const score = (v: SpeechSynthesisVoice) => {
      let s = 0
      if (/natural|online/i.test(v.name)) s -= 100 // Edge 在线自然音色
      if (v.localService) s -= 10
      if (/en-US/i.test(v.lang)) s -= 5
      return s
    }
    return english.sort((a, b) => score(a) - score(b))
  })
}

/**
 * 用户手势预热：iOS 上首次 speak 必须在手势回调里发起，
 * 这里用一个静音短句把语音引擎「解锁」，后续调用就不会被拦。
 */
export function primeSpeech() {
  if (!isClient() || unlocked || priming) return
  priming = true
  try {
    const msg = new SpeechSynthesisUtterance(' ')
    msg.volume = 0
    msg.rate = 10
    msg.onend = () => {
      unlocked = true
      priming = false
    }
    msg.onerror = () => {
      unlocked = true
      priming = false
    }
    window.speechSynthesis.speak(msg)
    // 有些浏览器不给 onend，兜底
    setTimeout(() => {
      unlocked = true
      priming = false
    }, 600)
  } catch {
    unlocked = true
    priming = false
  }
  // 顺手把语音列表拉起来
  void loadVoices()
}

/** 全局注册一次手势监听，任何点击/按键都能完成预热 */
export function installSpeechUnlock() {
  if (!isClient() || typeof document === 'undefined') return
  const handler = () => {
    primeSpeech()
    document.removeEventListener('pointerdown', handler, true)
    document.removeEventListener('keydown', handler, true)
  }
  document.addEventListener('pointerdown', handler, true)
  document.addEventListener('keydown', handler, true)
}

/** 长文本分片，避免部分引擎截断 */
function splitText(text: string, max = 180): string[] {
  const trimmed = text.trim()
  if (trimmed.length <= max) return [trimmed]
  const parts: string[] = []
  let rest = trimmed
  while (rest.length > max) {
    // 优先在标点/空格处切
    let cut = -1
    for (let i = max; i > max * 0.5; i--) {
      if (/[,.!?;:，。！？；：\s]/.test(rest[i])) {
        cut = i + 1
        break
      }
    }
    if (cut < 0) cut = max
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.trim()) parts.push(rest)
  return parts
}

function pickVoice(voices: SpeechSynthesisVoice[], voiceName?: string, lang = 'en-US'): SpeechSynthesisVoice | null {
  if (voiceName) {
    const hit = voices.find(v => v.name === voiceName)
    if (hit) return hit
  }
  const english = voices.filter(v => v.lang?.toLowerCase().startsWith('en'))
  const sameLang = english.filter(v => v.lang?.toLowerCase() === lang.toLowerCase())
  const pool = sameLang.length ? sameLang : english
  if (!pool.length) return null
  return pool.find(v => /natural|online/i.test(v.name)) ?? pool[0]
}

/**
 * 朗读一段文本
 * @returns 取消函数
 */
export function speak(text: string, options: SpeakOptions = {}): () => void {
  if (!isClient() || !text?.trim()) {
    options.onEnd?.()
    return () => {}
  }
  const synth = window.speechSynthesis
  synth.cancel()

  const chunks = splitText(text)
  const rate = Math.min(Math.max(options.rate ?? 1, 0.1), 10)
  const volume = Math.min(Math.max(options.volume ?? 1, 0), 1)
  const pitch = options.pitch ?? 1
  const lang = options.lang ?? 'en-US'

  let cancelled = false
  let index = 0

  const next = () => {
    if (cancelled) return
    if (index >= chunks.length) {
      options.onEnd?.()
      return
    }
    const chunk = chunks[index++]
    const msg = new SpeechSynthesisUtterance(chunk)
    msg.rate = rate
    msg.volume = volume
    msg.pitch = pitch
    msg.lang = lang
    msg.onstart = () => {
      if (index === 1) options.onStart?.()
    }
    msg.onend = () => next()
    msg.onerror = () => next()

    // 语音列表可能还没加载好，异步补一次
    const voices = voicesCache.length ? voicesCache : synth.getVoices()
    const voice = pickVoice(voices || [], options.voiceName, lang)
    if (voice) {
      msg.voice = voice
      msg.lang = voice.lang || lang
    }
    try {
      synth.speak(msg)
    } catch {
      next()
    }
  }

  // iOS：cancel 之后立即 speak 有时会丢句子，下一帧再播
  setTimeout(next, 0)

  return () => {
    cancelled = true
    try {
      synth.cancel()
    } catch {
      /* ignore */
    }
  }
}

export function cancelSpeech() {
  if (!isClient()) return
  try {
    window.speechSynthesis.pause()
    window.speechSynthesis.cancel()
  } catch {
    /* ignore */
  }
}

export function speechSupported(): boolean {
  return isClient()
}

import {onDeactivated, onMounted, onUnmounted, watch, type WatchSource} from 'vue'
import {emitter, EventKey} from '../utils/eventBus'
import {useSettingStore} from '../stores'
import {isMobile} from '../utils'
import {Toast} from '@/base'

const CODE_TO_CHAR: Record<string, string> = {
  ...Object.fromEntries('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(c => [`Key${c}`, c.toLowerCase()])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Digit${i}`, String(i)])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Numpad${i}`, String(i)])),
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Space: ' ',
  Backspace: 'Backspace',
}

const SHIFT_CODE_TO_CHAR: Record<string, string> = {
  Digit1: '!',
  Digit2: '@',
  Digit3: '#',
  Digit4: '$',
  Digit5: '%',
  Digit6: '^',
  Digit7: '&',
  Digit8: '*',
  Digit9: '(',
  Digit0: ')',
  Minus: '_',
  Equal: '+',
  BracketLeft: '{',
  BracketRight: '}',
  Semicolon: ':',
  Quote: '"',
  Comma: '<',
  Period: '>',
  Slash: '?',
  Backslash: '|',
}

const CHAR_TO_CODE: Record<string, string> = {}
for (const [code, char] of Object.entries(CODE_TO_CHAR)) {
  CHAR_TO_CODE[char] = code
  if (code.startsWith('Key')) {
    CHAR_TO_CODE[char.toUpperCase()] = code
  }
}
for (const [code, char] of Object.entries(SHIFT_CODE_TO_CHAR)) {
  CHAR_TO_CODE[char] = code
}

function charToCode(char: string) {
  return CHAR_TO_CODE[char] ?? ''
}

function getSelectedText() {
  return window.getSelection().toString().trim()
}

export function useWindowClick(cb: (e: PointerEvent) => void) {
  const add = () => {
    emitter.on(EventKey.closeOther, cb)
    window.addEventListener('click', cb)
  }
  onMounted(add)
  // onActivated(add)

  const remove = () => {
    window.removeEventListener('click', cb)
  }
  onUnmounted(remove)
  onDeactivated(remove)
}

export function useEventListener(type: string, listener: EventListenerOrEventListenerObject) {
  const invokeListener = (event: KeyboardEvent) => {
    if (typeof listener === 'function') {
      return (listener as EventListener)(event)
    }
    if (listener && typeof (listener as EventListenerObject).handleEvent === 'function') {
      return (listener as EventListenerObject).handleEvent(event)
    }
  }

  let cleanup: (() => void) | null = null

  const add = () => {
    //chrome上，win的事件先触发，safari上input的事件先触发
    const emitWindowsKeys = new Set()
    const emitInputKeys = new Set()
    const cleanupFns: Array<() => void> = []
    const registerCleanup = (fn: () => void) => cleanupFns.push(fn)

    const performCleanup = () => {
      while (cleanupFns.length) {
        const fn = cleanupFns.pop()
        try {
          fn()
        } catch (err) {
          console.warn('[useEventListener] cleanup error', err)
        }
      }
    }

    if (type === 'keydown') {
      /**
       * 手机端键盘捕获器。
       *
       * 用不可见的 <input> 而不是 contenteditable：contenteditable 会被安卓输入法
       * 当成富文本，英文也走「组合输入」，字母全堆在候选区不提交。
       * input 上输入法仍是组合输入，但 value 里能拿到累积文本，可以逐字符消费。
       *
       * 位置固定在视口左上角（而不是原来的 50vh/50vw）：浏览器会把聚焦元素
       * 滚动到可视区域，放在屏幕中央会导致整个页面被顶上去。
       */
      const ensureMobileInput = () => {
        let input = document.querySelector('#typing-listener') as HTMLInputElement | null
        if (!input) {
          input = document.createElement('input')
          input.id = 'typing-listener'
          input.type = 'text'
          // 尽可能避开浏览器/密码管理器的自动填充条
          input.autocomplete = 'off'
          input.setAttribute('autocomplete', 'off')
          input.setAttribute('name', 'tw-typing-catcher')
          input.setAttribute('data-form-type', 'other')
          input.setAttribute('data-lpignore', 'true')
          input.setAttribute('data-1p-ignore', 'true')
          input.setAttribute('aria-autocomplete', 'none')
          input.setAttribute('autocapitalize', 'off')
          input.setAttribute('autocorrect', 'off')
          input.setAttribute('spellcheck', 'false')
          // 让输入法给出拉丁键盘，减少中文组合输入
          input.setAttribute('inputmode', 'latin')
          input.setAttribute('enterkeyhint', 'done')
          input.tabIndex = -1
          input.setAttribute('aria-hidden', 'true')
          Object.assign(input.style, {
            position: 'fixed',
            top: '0',
            left: '0',
            width: '1px',
            height: '1px',
            // 不能用 0：部分浏览器认为完全透明的元素不可聚焦
            opacity: '0.02',
            fontSize: '16px', // 小于 16px 时 iOS 会自动放大页面
            padding: '0',
            border: '0',
            outline: 'none',
            background: 'transparent',
            color: 'transparent',
            caretColor: 'transparent',
            pointerEvents: 'none',
            zIndex: '-1',
          })
        }
        if (!input.parentNode) {
          document.body.appendChild(input)
        }
        setTimeout(() => {
          input.focus({ preventScroll: true } as FocusOptions)
        }, 100)
        return input
      }

      const hiddenInput = ensureMobileInput()
      let isComposing = false

      const createSyntheticEvent = (payload: { key: string; code?: string; keyCode: number }) => {
        const base = {
          key: payload.key,
          code: payload.code ?? '',
          keyCode: payload.keyCode,
          which: payload.keyCode,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
          metaKey: false,
          repeat: false,
          isComposing: false,
          type,
          preventDefault() {},
          stopPropagation() {},
          stopImmediatePropagation() {},
        }
        return base as unknown as KeyboardEvent
      }

      const dispatchSyntheticKey = (payload: { key: string; code?: string; keyCode: number }) => {
        invokeListener(createSyntheticEvent(payload))
      }

      /** 已经派发过的文本，用于和输入框 value 求差集，避免重复计数 */
      let consumedText = ''

      const clearCatcher = () => {
        consumedText = ''
        if (hiddenInput.value !== '') hiddenInput.value = ''
      }

      const dispatchText = (text: string) => {
        for (const char of text) {
          if (emitWindowsKeys.has(char)) continue
          emitInputKeys.add(char)
          setTimeout(() => emitInputKeys.delete(char), 30)
          const keyCode = char === ' ' ? 32 : char.toUpperCase().charCodeAt(0)
          dispatchSyntheticKey({ key: char, code: charToCode(char), keyCode })
        }
      }

      /**
       * 消费输入框里的新增文本。
       *
       * 安卓输入法（含英文）会把整词累积在 value 里：输入 e→ed→edi…，
       * 所以每次取和上一次的差集逐字符派发，用户敲一个字母就能立即上屏，
       * 不必等输入法提交。
       */
      const consumeValue = () => {
        const current = hiddenInput.value || ''
        if (!current) return
        let fresh = ''
        if (current.startsWith(consumedText)) {
          fresh = current.slice(consumedText.length)
        } else {
          // 输入法做了纠正/替换：跳过公共前缀，只派发剩下的部分
          let common = 0
          const max = Math.min(current.length, consumedText.length)
          while (common < max && current[common] === consumedText[common]) common++
          fresh = current.slice(common)
        }
        consumedText = current
        if (fresh) dispatchText(fresh)
      }

      const handleCompositionStart = () => {
        isComposing = true
      }

      const handleCompositionUpdate = (event: CompositionEvent) => {
        // 只有真的在打中文/日文等非拉丁字符时才提示切换输入法，
        // 安卓上英文单词同样是「组合输入」，不能据此误报
        if (!event.data || /^[\x20-\x7e]*$/.test(event.data)) return
        Toast.warning('请切换到英文输入')
      }

      const handleCompositionEnd = (event: CompositionEvent) => {
        isComposing = false
        // 提交时补齐还没派发的部分（组合期间已经逐字符派发过，这里通常是空的）
        consumeValue()
        if (!consumedText && event.data) dispatchText(event.data)
        clearCatcher()
      }

      const handleBeforeInput = (event: InputEvent) => {
        // 组合输入期间的退格是编辑候选词，交给输入法自己处理
        if (isComposing) return
        if (event.inputType?.startsWith('delete')) {
          event.preventDefault()
          if (!emitWindowsKeys.has('Backspace')) {
            emitInputKeys.add('Backspace')
            setTimeout(() => emitInputKeys.delete('Backspace'), 30)
            dispatchSyntheticKey({ key: 'Backspace', code: 'Backspace', keyCode: 8 })
          }
          clearCatcher()
        }
      }

      const handleInput = () => {
        // 组合输入中也照样消费：字母立刻上屏，不会全堆在候选区
        consumeValue()
        // 非组合状态（直接输入、粘贴、退格）消费完就清空，避免 value 无限增长
        if (!isComposing) clearCatcher()
      }

      const handleFocusRequest = (event: MouseEvent | TouchEvent) => {
        const target = event.target as HTMLElement | null
        if (!target) return
        if (!window.location.pathname.includes('/practice')) return
        const typingWord = target.closest('#PracticeArea')
        if (!typingWord) return
        if (target.closest('input, textarea, select, [contenteditable="true"]')) return false
        if (!getSelectedText()) {
          window.setTimeout(() => {
            hiddenInput.focus({ preventScroll: true } as FocusOptions)
            // 手机上聚焦后浏览器可能把页面滚走，这里再兜一次
            if (window.scrollY !== 0) window.scrollTo(0, 0)
          }, 160)
        }
      }

      const windowListener = (e: KeyboardEvent) => {
        // if (e.code in CODE_TO_CHAR && !e.ctrlKey && !e.metaKey) return
        // return
        // console.log('windowListener', Date.now(), e)
        if (e.key === 'Process') {
          // @ts-ignore
          // e.key = CODE_TO_CHAR[e.code]
          //todo 这里不能直接设置值，会报错，后续可以用合成事件优化
          return
        }
        if (emitInputKeys.has(e.key)) return
        // console.log('windowListener', Date.now(), emitInputKeys)
        invokeListener(e)
        emitWindowsKeys.add(e.key)
        setTimeout(() => emitWindowsKeys.delete(e.key), 30)
      }

      hiddenInput.addEventListener('compositionstart', handleCompositionStart)
      registerCleanup(() => hiddenInput.removeEventListener('compositionstart', handleCompositionStart))

      hiddenInput.addEventListener('compositionupdate', handleCompositionUpdate)
      registerCleanup(() => hiddenInput.removeEventListener('compositionupdate', handleCompositionUpdate))

      hiddenInput.addEventListener('compositionend', handleCompositionEnd)
      registerCleanup(() => hiddenInput.removeEventListener('compositionend', handleCompositionEnd))

      hiddenInput.addEventListener('beforeinput', handleBeforeInput as any, { capture: true })
      registerCleanup(() => hiddenInput.removeEventListener('beforeinput', handleBeforeInput as any, { capture: true }))

      hiddenInput.addEventListener('input', handleInput, { capture: true })
      registerCleanup(() => hiddenInput.removeEventListener('input', handleInput, { capture: true }))

      window.addEventListener('click', handleFocusRequest)
      registerCleanup(() => window.removeEventListener('click', handleFocusRequest))

      window.addEventListener('touchstart', handleFocusRequest)
      registerCleanup(() => window.removeEventListener('touchstart', handleFocusRequest))

      window.addEventListener(type, windowListener, { capture: true })
      registerCleanup(() => window.removeEventListener(type, windowListener, { capture: true }))

      registerCleanup(() => hiddenInput.remove())
    } else {
      const windowListener = (event: Event) => invokeListener(event as KeyboardEvent)
      window.addEventListener(type, windowListener, { capture: true })
      registerCleanup(() => window.removeEventListener(type, windowListener, { capture: true }))
    }

    cleanup = () => {
      performCleanup()
      cleanup = null
    }
  }
  onMounted(add)

  const remove = () => {
    if (cleanup) cleanup()
  }

  onUnmounted(remove)
  onDeactivated(remove)
}

export function getShortcutKey(e: KeyboardEvent) {
  let shortcutKey = ''
  if (e.ctrlKey || e.metaKey) shortcutKey += 'Ctrl+'
  if (e.altKey) shortcutKey += 'Alt+'
  if (e.shiftKey) shortcutKey += 'Shift+'
  if (e.key !== 'Control' && e.key !== 'Alt' && e.key !== 'Shift') {
    if (e.keyCode >= 65 && e.keyCode <= 90) {
      shortcutKey += e.key.toUpperCase()
    } else {
      if (e.key === 'ArrowRight') {
        shortcutKey += '➡'
      } else if (e.key === 'ArrowLeft') {
        shortcutKey += '⬅'
      } else if (e.key === 'ArrowUp') {
        shortcutKey += '⬆'
      } else if (e.key === 'ArrowDown') {
        shortcutKey += '⬇'
      } else {
        //当空格为快捷键时，key为一个空字符，而代码里面写的快捷键是Space，导致匹配不上
        shortcutKey += e.key.trim() || e.code
      }
    }
  }
  shortcutKey = shortcutKey.trim()

  // console.log('key', shortcutKey)
  return shortcutKey
}

export function useStartKeyboardEventListener() {
  const settingStore = useSettingStore()

  useEventListener('keydown', (e: KeyboardEvent) => {
    // console.log('keydown', e)
    // debugger
    //解决无法复制、全选的问题
    if ((e.ctrlKey || e.metaKey) && ['KeyC', 'KeyA', 'KeyD'].includes(e.code)) return
    if (!window?.disableEventListener) {
      let shortcutKey = getShortcutKey(e)
      // console.log('shortcutKey', shortcutKey)

      let shortcutEvent = []
      for (let [k, v] of Object.entries(settingStore.shortcutKeyMap)) {
        if (v === shortcutKey) {
          // console.log('快捷键', k,emitter.all.has(k))
          //必须是已监听的事件，才拦截并触发
          //因为在自测时，才会监听 1234 四个键，平时如果也拦截会导致无法输入1234
          if (emitter.all.has(k) && emitter.all.get(k)?.length) {
            shortcutEvent.push(k)
          }
        }
      }
      // console.log('shortcutEvent', shortcutEvent, settingStore.shortcutKeyMap, emitter.all)
      if (shortcutEvent.length > 0) {
        e.preventDefault()
        shortcutEvent.map(s => emitter.emit(s, e))
      } else {
        // 非英文模式下，输入区域的 keyCode 均为 229时，
        if (
          ((e.keyCode >= 65 && e.keyCode <= 90) ||
            (e.keyCode >= 48 && e.keyCode <= 57) ||
            (e.keyCode >= 96 && e.keyCode <= 105) ||
            // 空格键已经在上面处理过了
            e.code === 'Slash' ||
            e.code === 'Quote' ||
            e.code === 'Comma' ||
            e.code === 'BracketLeft' ||
            e.code === 'BracketRight' ||
            e.code === 'Period' ||
            e.code === 'Minus' ||
            e.code === 'Equal' ||
            e.code === 'Semicolon' ||
            e.code === 'Backspace' ||
            e.code === 'Space' ||
            // || e.code === 'Backquote'
            e.keyCode === 229) &&
          //当按下功能键时，不阻止事件传播
          !e.ctrlKey &&
          !e.altKey
        ) {
          if (isMobile() && e.keyCode === 229 && e.key === 'Unidentified') {
            // 安卓软键盘在keydown阶段不会提供字符，等待input/composition事件来派发实际输入
            return
          }
          e.preventDefault()
          emitter.emit(EventKey.onTyping, e)
        } else {
          emitter.emit(EventKey.keydown, e)
        }
      }
    }
  })
  useEventListener('keyup', (e: KeyboardEvent) => {
    if (!window?.disableEventListener) {
      emitter.emit(EventKey.keyup, e)
    }
  })
}

export function useOnKeyboardEventListener(onKeyDown: (e: KeyboardEvent) => void, onKeyUp: (e: KeyboardEvent) => void) {
  const add = () => {
    emitter.on(EventKey.keydown, onKeyDown)
    emitter.on(EventKey.keyup, onKeyUp)
  }
  onMounted(add)
  // onActivated(add)

  const remove = () => {
    emitter.off(EventKey.keydown, onKeyDown)
    emitter.off(EventKey.keyup, onKeyUp)
  }
  onUnmounted(remove)
  onDeactivated(remove)
}

//因为如果用useStartKeyboardEventListener局部变量控制，当出现多个hooks时就不行了，所以用全局变量来控制
export function useDisableEventListener(watchVal: WatchSource<unknown>) {
  if (typeof window === 'undefined') return
  watch(
    watchVal,
    n => {
      window.disableEventListener = Boolean(n)
    },
    { immediate: true }
  )

  onUnmounted(() => {
    window.disableEventListener = false
  })
}

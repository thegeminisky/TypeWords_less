import { onMounted, onUnmounted, ref } from 'vue'

/**
 * 判断软键盘是否弹出。
 *
 * 思路：用 visualViewport.height 与我们见过的最大高度比较。
 * 注意不能拿 window.innerHeight 对比——配上 `interactive-widget=resizes-content`
 * 之后布局视口会一起收缩，两者差值始终接近 0，判断不出来。
 */
export function useVirtualKeyboard() {
  const keyboardOpen = ref(false)
  let baseline = 0

  const reset = () => {
    baseline = 0
    update()
  }

  function update() {
    if (typeof window === 'undefined') return
    const vv = window.visualViewport
    const height = vv ? vv.height : window.innerHeight

    // 记录见过的最大高度作为「没有键盘」的基准
    if (height > baseline) baseline = height
    // 键盘占地通常远超 140px；阈值太小会被地址栏收缩误判
    keyboardOpen.value = baseline - height > 140
  }

  onMounted(() => {
    update()
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    window.addEventListener('orientationchange', reset)
  })

  onUnmounted(() => {
    window.visualViewport?.removeEventListener('resize', update)
    window.visualViewport?.removeEventListener('scroll', update)
    window.removeEventListener('orientationchange', reset)
  })

  return { keyboardOpen }
}

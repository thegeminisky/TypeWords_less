import { onMounted, onUnmounted, ref } from 'vue'

/**
 * 软键盘 / 可视视口尺寸。
 *
 * 只用 visualViewport.height：配上 `interactive-widget=resizes-content` 之后
 * 布局视口会一起收缩，拿 window.innerHeight 对比是判断不出键盘的。
 * 这里直接暴露「可视高度」，布局拿它当容器高度，底部工具岛就始终贴在键盘上沿。
 */
export function useVirtualKeyboard() {
  const viewportHeight = ref(0)
  const keyboardOpen = ref(false)
  let baseline = 0

  const reset = () => {
    baseline = 0
    update()
  }

  function update() {
    if (typeof window === 'undefined') return
    const vv = window.visualViewport
    const height = Math.round(vv ? vv.height : window.innerHeight)
    viewportHeight.value = height

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
    window.addEventListener('resize', update)
  })

  onUnmounted(() => {
    window.visualViewport?.removeEventListener('resize', update)
    window.visualViewport?.removeEventListener('scroll', update)
    window.removeEventListener('orientationchange', reset)
    window.removeEventListener('resize', update)
  })

  return { viewportHeight, keyboardOpen }
}

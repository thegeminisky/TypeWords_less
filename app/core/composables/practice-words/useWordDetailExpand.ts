import { ref } from 'vue'

/**
 * 练习页「例句/扩展信息」的展开状态。
 *
 * 默认收起（只显示第 1 条例句），用户点「展开全部」后才显示剩余例句、
 * 短语、近义词、词源等。练习页据此决定手机端是否锁定页面滚动。
 */
const expanded = ref(false)

export function useWordDetailExpand() {
  function reset() {
    expanded.value = false
  }

  function collapse() {
    expanded.value = false
  }

  function toggle() {
    expanded.value = !expanded.value
  }

  return { expanded, reset, collapse, toggle }
}

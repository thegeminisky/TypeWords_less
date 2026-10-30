<script setup lang="ts">
import { computed } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { useVirtualKeyboard } from '@/core/composables/useVirtualKeyboard.ts'

defineProps<{}>()

const isNarrowScreen = useMediaQuery('(max-width: 768px)')
const { viewportHeight, keyboardOpen } = useVirtualKeyboard()

/**
 * 手机端把整个练习区固定成「可视视口高度」的纵向 flex：
 * 内容区 flex:1，工具岛在流内贴底。
 * 键盘弹出时容器跟着变矮，工具岛自然落在键盘上沿，不会被压到键盘后面。
 */
const rootStyle = computed(() => {
  if (!isNarrowScreen.value || !viewportHeight.value) return {}
  return { height: `${viewportHeight.value}px` }
})
</script>

<template>
  <div class="practice-layout" :class="{ 'keyboard-open': keyboardOpen }" :style="rootStyle">
    <div class="wrap" id="PracticeArea">
      <slot name="practice"></slot>
    </div>
    <div class="footer-wrap">
      <slot name="footer"></slot>
    </div>
  </div>
</template>

<style scoped lang="scss">
.practice-layout {
  display: flex;
  justify-content: center;
  position: relative;
}

.wrap {
  transition: all var(--anim-time);
}

.footer-wrap {
  position: fixed;
  bottom: calc(env(safe-area-inset-bottom, 0px));
  transition: all var(--anim-time);
  z-index: 999;
}

@media (max-width: 768px) {
  .practice-layout {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    flex-direction: column;
    // 行内 height 会覆盖成 visualViewport 高度，这里的 dvh 只是兜底
    height: 100vh;
    height: 100dvh;
  }

  .wrap {
    flex: 1 1 auto;
    min-height: 0;
    width: 100%;
    padding: 0;
    box-sizing: border-box;
    overflow-y: auto;
    overflow-x: hidden; // 内容再宽也不出横向滚动条
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    // 按需求隐藏滚动条（保留滚动能力）
    scrollbar-width: none;
    -ms-overflow-style: none;

    &::-webkit-scrollbar {
      display: none;
    }
  }

  .footer-wrap {
    position: static;
    flex: 0 0 auto;
    padding: 0 0.5rem calc(0.6rem + env(safe-area-inset-bottom, 0px));
  }

  /**
   * 软键盘弹出时页脚贴住键盘上沿。
   *
   * 容器高度已经等于 visualViewport 高度（键盘上沿），但底部安全区
   * （env(safe-area-inset-bottom)）在键盘弹出后仍然返回系统手势条的
   * 高度（本机实测约 35px），再叠加 0.6rem 留白，就会在进度条和键盘
   * 上沿之间露出一条网页背景色空隙。键盘已经盖住那块区域，这里直接
   * 把留白清零，进度条紧贴可视范围最底部。
   */
  .practice-layout.keyboard-open .footer-wrap {
    padding-bottom: 0;
  }
}

// 超小屏幕适配
@media (max-width: 480px) {
  .wrap {
    padding: 0 0.5rem;
  }

  .footer-wrap {
    padding: 0 0.3rem calc(0.5rem + env(safe-area-inset-bottom, 0px));
  }
}
</style>

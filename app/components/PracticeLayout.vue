<script setup lang="ts">
import { computed } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { useVirtualKeyboard } from '@/core/composables/useVirtualKeyboard.ts'

defineProps<{}>()

const isNarrowScreen = useMediaQuery('(max-width: 768px)')
const { viewportHeight } = useVirtualKeyboard()

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
  <div class="practice-layout" :style="rootStyle">
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

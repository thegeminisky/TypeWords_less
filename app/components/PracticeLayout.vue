<script setup lang="ts">
defineProps<{
  /** 手机端未展开详情时锁定内容区滚动 */
  locked?: boolean
  /** 软键盘弹出：内容区占满可视高度，底部工具岛会被隐藏 */
  compact?: boolean
}>()
</script>

<template>
  <div class="flex justify-center relative" :class="{ compact: compact }">
    <div class="wrap" id="PracticeArea" :class="{ locked: locked }">
      <slot name="practice"></slot>
    </div>
    <div class="footer-wrap">
      <slot name="footer"></slot>
    </div>
  </div>
</template>

<style scoped lang="scss">
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
  .wrap {
    // dvh 会随软键盘收缩，vh 不会；不支持 dvh 的浏览器退回 vh
    height: calc(100vh - 6rem);
    height: calc(100dvh - 6rem);
    width: 100vw;
    padding: 0 1rem;
    box-sizing: border-box;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;

    &.locked {
      overflow: hidden;
    }
  }

  .compact .wrap {
    height: calc(100vh - 0.5rem);
    height: calc(100dvh - 0.5rem);
  }

  .footer-wrap {
    bottom: calc(0.5rem + env(safe-area-inset-bottom, 0px));
    left: 0.5rem;
    right: 0.5rem;
    width: auto;
  }
}

// 超小屏幕适配
@media (max-width: 480px) {
  .wrap {
    height: calc(100vh - 5.4rem);
    height: calc(100dvh - 5.4rem);
    padding: 0 0.5rem;
  }

  .compact .wrap {
    height: calc(100vh - 0.5rem);
    height: calc(100dvh - 0.5rem);
  }

  .footer-wrap {
    bottom: calc(0.3rem + env(safe-area-inset-bottom, 0px));
    left: 0.3rem;
    right: 0.3rem;
  }
}
</style>

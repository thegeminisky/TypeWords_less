<script setup lang="ts">
import { BaseIcon, ToastComponent } from '@/base'
import Logo from '@/components/Logo.vue'
import IeDialog from '@/components/dialog/IeDialog.vue'
import useTheme from '@/core/hooks/theme.ts'
import { useRuntimeStore } from '@/core/stores/runtime.ts'
import { useSettingStore } from '@/core/stores/setting.ts'
import { ShortcutKey } from '@/core/types/enum.ts'
import { onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import { useInit } from '@/core/composables/useInit.ts'
import { useI18n } from 'vue-i18n'
import WordCollectPopover from '@/components/word/WordCollectPopover.vue'

const { toggleTheme, getTheme, setTheme } = useTheme()
const runtimeStore = useRuntimeStore()
const settingStore = useSettingStore()
const init = useInit()

watch(
  () => settingStore.load,
  n => {
    if (!n) return
    setTheme(settingStore.theme)
  }
)

watch(
  () => settingStore.theme,
  n => {
    setTheme(n)
  }
)

const { locales, setLocale } = useI18n()
const route = useRoute()

// 仅在功能页展示右上角工具组
const showIcon = $computed(() => {
  return ['/words', '/setting', '/dict', '/dict-list'].some(p => route.path === p || route.path?.startsWith(`${p}/`))
})

onMounted(() => {
  init()
})
</script>

<template>
  <div class="layout anim">
    <!-- 产品图标：左上角，点击回到单词页 -->
    <div class="brand-fab">
      <Logo />
    </div>

    <IeDialog />

    <div class="flex-1 z-1 relative main-content overflow-x-hidden">
      <div
        class="mt-3 center relative z-9999 pointer-events-none"
        v-if="runtimeStore.isError"
        @click="runtimeStore.isError = false"
      >
        <ToastComponent type="error" :duration="0" :shadow="false" :showClose="false" :message="$t('sync_failed_toast')" />
      </div>

      <router-view></router-view>

      <div class="absolute right-4 top-4 flex z-1 gap-2" v-if="showIcon">
        <div class="relative group">
          <BaseIcon>
            <IconPhTranslate />
          </BaseIcon>
          <div
            class="space-y-2 pt-2 absolute z-2 right-0 opacity-0 scale-95 group-hover:opacity-100 group-hover:scale-100 transition-all duration-150 pointer-events-none group-hover:pointer-events-auto"
          >
            <div class="card mb-2 py-4 px-6 space-y-3">
              <div v-for="locale in locales" @click="setLocale(locale.code)" class="w-full cp break-keep black-link">
                {{ locale.name }}
              </div>
            </div>
          </div>
        </div>

        <BaseIcon
          :title="`${$t('toggle_theme')}(${settingStore.shortcutKeyMap[ShortcutKey.ToggleTheme]})`"
          @click="toggleTheme"
        >
          <IconFluentWeatherMoon16Regular v-if="getTheme() === 'light'" />
          <IconFluentWeatherSunny16Regular v-else />
        </BaseIcon>

        <!-- 设置入口：右上角工具组的最后一个 -->
        <BaseIcon class="relative" :title="$t('setting')" @click="$router.push('/setting')">
          <IconFluentSettings20Regular />
          <span class="red-point" v-if="runtimeStore.isError"></span>
        </BaseIcon>
      </div>
    </div>

    <WordCollectPopover />
  </div>
</template>

<style scoped lang="scss">
.layout {
  width: 100%;
  height: 100%;
  display: flex;
  background: var(--color-primary);
}

/* 左上角产品图标：浮在内容之上，不占布局空间、无背景板 */
.brand-fab {
  position: fixed;
  top: 0.75rem;
  left: 0.75rem;
  z-index: 20;
}

/* 设置图标上的同步错误提示点 */
.red-point {
  position: absolute;
  top: 0.15rem;
  right: 0.15rem;
  width: 0.35rem;
  height: 0.35rem;
  border-radius: 50%;
  background: #ef4444;
  pointer-events: none;
}

// 移动端内容满宽，图标会压住卡片标题，这里隐藏产品图标（页面标题与返回按钮已足够）
@media (max-width: 768px) {
  .brand-fab {
    display: none;
  }
}
</style>

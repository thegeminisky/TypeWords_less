<script setup lang="ts">
/**
 * ToolIsland — 练习页底部工具条
 *
 * 桌面端：一块常驻的小面板（阶段进度 + 进度/计时 + 可选按钮）。
 * 手机端：只有一行进度信息（状态 · 阶段进度 · 进度/错误/单词数），透明无背景，
 *        和早期「收起模式」的观感一致；只有用户在设置里打开了「下一组 / 随机默写」
 *        才会在行尾追加这两个按钮。
 *
 * 设置入口已挪到主界面右上角的设置页，这里不再提供。
 */
import { usePracticeStore } from '@/core/stores/practice.ts'
import { useSettingStore } from '@/core/stores/setting.ts'
import type { PracticeData } from '@/core/composables/practice-words/practice-word-session.ts'
import { ShortcutKey } from '@/core/types/enum.ts'
import type { PracticeFlowConfig, PracticeFlowCursor } from '@/core/composables/practice-words/practice-flow-types.ts'
import { BaseIcon, Tooltip } from '@/base'
import StageProgress from '@/components/StageProgress.vue'
import { useI18n } from 'vue-i18n'
import { computed, inject, type Ref } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { getPracticeFlowDisplayState } from '@/core/composables/practice-words/practice-flow-display.ts'

const props = defineProps<{
  /** 是否还有下一组可学 */
  hasNextGroup?: boolean
}>()

const emit = defineEmits<{
  nextGroup: []
  randomWrite: []
}>()

const statStore = usePracticeStore()
const settingStore = useSettingStore()
const { t: $t } = useI18n()
const isNarrowScreen = useMediaQuery('(max-width: 768px)')

const practiceData = inject<PracticeData>('practiceData')!
const activeCursor = inject<Ref<PracticeFlowCursor>>('practiceFlowCursor')!
const activeFlowConfig = inject<Ref<PracticeFlowConfig>>('practiceFlowConfig')!
const bumpPracticeTimerActivity = inject<(() => void) | undefined>('bumpPracticeTimerActivity', undefined)

const showNextGroup = computed(() => settingStore.showBtnNextGroup && !!props.hasNextGroup)
const showRandomWrite = computed(() => settingStore.showBtnRandomWrite)

function onTimerRowClick() {
  if (statStore.timerPaused) {
    statStore.resumeTimer()
    bumpPracticeTimerActivity?.()
  } else {
    statStore.pauseTimer('manual')
  }
}

function format(val: number, suffix: string = '', check: number = -1) {
  return val === check ? '-' : val + suffix
}

const flowDisplay = computed(() =>
  getPracticeFlowDisplayState({
    config: activeFlowConfig.value,
    cursor: activeCursor.value,
    wordIndex: practiceData.index,
    wordCount: practiceData.words.length,
    translate: $t,
  })
)
const status = computed(() => flowDisplay.value.status)
const stages = computed(() => flowDisplay.value.stages)
</script>

<template>
  <!-- 手机端：一行进度，透明底 -->
  <div class="island minimal" v-if="isNarrowScreen">
    <span class="status">{{ status }}</span>
    <StageProgress class="stage-line" :stages="stages" />
    <Tooltip title="进度 / 错误数 / 单词数">
      <span class="counts">
        <span>{{ practiceData.index + 1 }}</span>
        <span class="sep">/</span>
        <span class="wrong">{{ format(practiceData.wrongWords.length, '', 0) }}</span>
        <span class="sep">/</span>
        <span>{{ practiceData.words.length }}</span>
      </span>
    </Tooltip>
    <span class="mini-actions" v-if="showNextGroup || showRandomWrite">
      <BaseIcon
        v-if="showNextGroup"
        :title="`下一组(${settingStore.shortcutKeyMap[ShortcutKey.NextChapter]})`"
        @click="emit('nextGroup')"
      >
        <IconFluentArrowRight16Regular width="18" />
      </BaseIcon>
      <BaseIcon
        v-if="showRandomWrite"
        :title="`随机默写(${settingStore.shortcutKeyMap[ShortcutKey.RandomWrite]})`"
        @click="emit('randomWrite')"
      >
        <IconFluentArrowShuffle16Regular width="18" />
      </BaseIcon>
    </span>
  </div>

  <!-- 桌面端：完整小面板 -->
  <div class="island" v-else>
    <StageProgress class="stage" :stages="stages" />

    <div class="content">
      <div class="stat">
        <Tooltip title="进度 / 错误数 / 单词数">
          <div class="item">
            <span class="num">{{ practiceData.index + 1 }}</span>
            <span class="sep">/</span>
            <span class="num wrong">{{ format(practiceData.wrongWords.length, '', 0) }}</span>
            <span class="sep">/</span>
            <span class="num">{{ practiceData.words.length }}</span>
          </div>
        </Tooltip>
        <Tooltip :title="`${status}｜点击可暂停或恢复计时`">
          <div class="item cp" @click="onTimerRowClick">
            <IconFluentPause20Regular v-if="statStore.timerPaused" width="16" height="16" />
            <template v-else>
              <span class="num">{{ Math.floor(statStore.spend / 1000 / 60) }}</span>
              <span class="unit">{{ $t('minutes') }}</span>
            </template>
          </div>
        </Tooltip>
      </div>

      <div class="actions" v-if="showNextGroup || showRandomWrite">
        <BaseIcon
          v-if="showNextGroup"
          :title="`下一组(${settingStore.shortcutKeyMap[ShortcutKey.NextChapter]})`"
          @click="emit('nextGroup')"
        >
          <IconFluentArrowRight16Regular width="20" />
        </BaseIcon>

        <BaseIcon
          v-if="showRandomWrite"
          :title="`随机默写(${settingStore.shortcutKeyMap[ShortcutKey.RandomWrite]})`"
          @click="emit('randomWrite')"
        >
          <IconFluentArrowShuffle16Regular width="20" />
        </BaseIcon>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.island {
  width: var(--toolbar-width);
  box-sizing: border-box;
  margin-bottom: 0.8rem;
  padding: 0.15rem var(--space) 0.35rem;
  border-radius: 0.9rem;
  background: var(--color-second);
  box-shadow: 0 6px 20px rgb(0 0 0 / 12%);

  .stage {
    display: block;
    margin: 0.1rem 0 0.25rem;
  }

  .content {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
  }

  .stat {
    display: flex;
    align-items: center;
    gap: 0.9rem;
    color: var(--color-sub-gray);
    font-size: 0.8rem;
    min-width: 0;

    .item {
      display: inline-flex;
      align-items: baseline;
      gap: 0.15rem;
      white-space: nowrap;
    }

    .num {
      font-weight: 600;
      color: var(--color-main-text);
    }

    .num.wrong {
      color: #ef4444;
    }

    .sep,
    .unit {
      opacity: 0.6;
    }
  }

  .actions {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    flex-shrink: 0;
  }
}

/* 手机端：只有一行，透明底，不挡内容 */
@media (max-width: 768px) {
  .island.minimal {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    margin-bottom: 0;
    padding: 0.15rem 0.2rem;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    // 注意：--color-sub-gray 在暗色主题下是深灰（#383737），当文字色会看不见
    color: var(--color-main-text);
    font-size: 0.72rem;
    line-height: 1.2;

    .status {
      flex: 0 0 auto;
      opacity: 0.6;
    }

    .stage-line {
      flex: 1 1 auto;
      min-width: 2rem;
    }

    .counts {
      flex: 0 0 auto;
      white-space: nowrap;
      color: var(--color-main-text);
      opacity: 0.95;

      .wrong {
        color: #ef4444;
      }

      .sep {
        margin: 0 0.1rem;
        opacity: 0.5;
      }
    }

    .mini-actions {
      display: inline-flex;
      align-items: center;
      gap: 0.1rem;
      flex: 0 0 auto;
    }
  }
}
</style>

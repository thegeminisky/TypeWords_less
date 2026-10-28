<script setup lang="ts">
/**
 * ToolIsland — 练习页底部常驻工具岛
 *
 * 只保留：练习进度 / 计时 / 阶段进度 / 设置入口 / 下一组 / 随机默写。
 * 已移除：收起逻辑、音效快捷设置、词表按钮、跳到下一阶段、释义与默写开关
 * （后两者已挪到单词输入框下方的功能栏）。
 */
import { usePracticeStore } from '@/core/stores/practice.ts'
import { useSettingStore } from '@/core/stores/setting.ts'
import type { PracticeData } from '@/core/composables/practice-words/practice-word-session.ts'
import { ShortcutKey } from '@/core/types/enum.ts'
import type { PracticeFlowConfig, PracticeFlowCursor } from '@/core/composables/practice-words/practice-flow-types.ts'
import { BaseIcon, Tooltip } from '@/base'
import SettingDialog from '@/components/setting/SettingDialog.vue'
import StageProgress from '@/components/StageProgress.vue'
import { useI18n } from 'vue-i18n'
import { computed, inject, type Ref } from 'vue'
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

const practiceData = inject<PracticeData>('practiceData')!
const activeCursor = inject<Ref<PracticeFlowCursor>>('practiceFlowCursor')!
const activeFlowConfig = inject<Ref<PracticeFlowConfig>>('practiceFlowConfig')!
const bumpPracticeTimerActivity = inject<(() => void) | undefined>('bumpPracticeTimerActivity', undefined)

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
  <div class="island">
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

      <div class="actions">
        <BaseIcon
          v-if="props.hasNextGroup"
          :title="`下一组(${settingStore.shortcutKeyMap[ShortcutKey.NextChapter]})`"
          @click="emit('nextGroup')"
        >
          <IconFluentArrowRight16Regular width="20" />
        </BaseIcon>

        <BaseIcon :title="`随机默写(${settingStore.shortcutKeyMap[ShortcutKey.RandomWrite]})`" @click="emit('randomWrite')">
          <IconFluentArrowShuffle16Regular width="20" />
        </BaseIcon>

        <SettingDialog type="word" />
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

/* 手机端：半透明浮层，弱化对内容的遮挡 */
@media (max-width: 768px) {
  .island {
    width: 100%;
    margin-bottom: 0;
    padding: 0.2rem 0.6rem calc(0.25rem + env(safe-area-inset-bottom, 0px));
    border-radius: 0.7rem;
    background: color-mix(in srgb, var(--color-second) 72%, transparent);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
    box-shadow: none;

    .stage {
      display: none;
    }

    .content {
      justify-content: space-between;
    }

    .stat {
      gap: 0.6rem;
      font-size: 0.75rem;
    }
  }
}
</style>

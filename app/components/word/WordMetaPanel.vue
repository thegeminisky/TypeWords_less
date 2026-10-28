<script setup lang="ts">
/**
 * WordMetaPanel — 只读元信息面板
 *
 * 从 TypeWord 拆出，负责纯展示（不承载输入逻辑）：
 * - 音标行（phonetic0/phonetic1 + 发音 VolumeIcon）
 * - 翻译区（TranslationList）
 * - 例句列表（ClickableEnglishText + VolumeIcon 只读展示）
 * - 短语列表
 * - 近义词 / 词源 / 关联词
 */
import type { Word } from '@/core/types/types.ts'
import { getDefaultWord } from '@/core/types/func.ts'
import { useSettingStore } from '@/core/stores/setting.ts'
import ClickableEnglishText from '@/components/word/ClickableEnglishText.vue'
import ClickableWord from '@/components/word/ClickableWord.vue'
import { VolumeIcon } from '@/base'
import { useI18n } from 'vue-i18n'
import TranslationList from '@/components/word/TranslationList.vue'
import TypingSentence from '~/components/practice-sentences/TypingSentence.vue'
import type { PracticeViewState } from '@/core/composables/practice-words/practice-flow-types.ts'
import { useEventsByWatch } from '@/core/utils/eventBus.ts'
import { SENTENCE_PLAY_SHORTCUT_KEYS, ShortcutKey } from '@/core'
import { WordPracticeType } from '@/core/types/enum.ts'
import { computed } from 'vue'
import { watch } from 'vue'
import { useTTsPlayAudio } from '@/core/hooks/sound.ts'
import { useWordDetailExpand } from '@/core/composables/practice-words/useWordDetailExpand.ts'

const { t: $t } = useI18n()

interface IProps {
  word: Word
  effective: PracticeViewState
}

const props = withDefaults(defineProps<IProps>(), {
  word: () => getDefaultWord(),
})

const emit = defineEmits<{
  complete: []
  wrong: []
}>()

const settingStore = useSettingStore()
const ttsPlayAudio = useTTsPlayAudio()
let highlightedSentenceIndex = $ref(-1)
const showDetails = computed(
  () =>
    props.effective.revealAll ||
    [WordPracticeType.FollowWrite, WordPracticeType.Spell].includes(props.effective.practiceType)
)
const showTranslation = computed(() => props.effective.revealAll || props.effective.isShowTranslate)
const showEtymology = computed(
  () =>
    props.effective.revealAll ||
    (props.effective.practiceType === WordPracticeType.FollowWrite &&
      !props.effective.isWordMasked &&
      props.effective.isShowTranslate)
)
let activeSentenceIndex = $ref(-1)

// 例句默认只展示第一条，其余内容折叠
const { expanded } = useWordDetailExpand()
const allSentences = computed(() => props.word.sentences ?? [])
const visibleSentences = computed(() => (expanded.value ? allSentences.value : allSentences.value.slice(0, 1)))
const hiddenSentenceCount = computed(() => Math.max(allSentences.value.length - 1, 0))

const hasExtraSections = computed(() => {
  if (props.word.phrases?.length) return true
  if (props.word.synos?.length) return true
  if (settingStore.showEtymologyAndRelWords) {
    if (props.word.etymology?.length) return true
    if (props.word.relWords?.root) return true
  }
  return false
})

const canExpand = computed(() => hiddenSentenceCount.value > 0 || hasExtraSections.value)

/** 展开按钮上的补充说明，例如「还有 2 条例句 · 短语 · 近义词」 */
const expandHint = computed(() => {
  const parts: string[] = []
  if (hiddenSentenceCount.value > 0) parts.push(`${hiddenSentenceCount.value} 条例句`)
  if (props.word.phrases?.length) parts.push('短语')
  if (props.word.synos?.length) parts.push('近义词')
  if (settingStore.showEtymologyAndRelWords && (props.word.etymology?.length || props.word.relWords?.root)) {
    parts.push('词源')
  }
  return parts.join(' · ')
})
let sentenceRefMap = new Map()
function setRef(index, el) {
  if (el) {
    sentenceRefMap.set(index, el)
  }
}

useEventsByWatch(
  SENTENCE_PLAY_SHORTCUT_KEYS.map((key, index) => [key, () => noticePlaySentence(index)]),
  () => (props.word.sentences?.length ?? 0) > 0
)

function noticePlaySentence(index: number) {
  if (index < 0 || index >= props.word.sentences.length) return
  sentenceRefMap.get(index)?.play?.()
}

function playTtsWithGuide(text: string, onEnd?: () => void) {
  // 不再弹「请去设置音色」的大提示框：手机上它会盖住单词。
  // 音色在「设置 → 音效设置」里配置，这里静默播放即可。
  ttsPlayAudio(text, {
    onEnd,
    volume: settingStore.sentenceSoundVolume / 100,
    rate: settingStore.sentenceSoundSpeed,
  })
}

function playSentence(index: number, options?: { highlight?: boolean }) {
  const text = props.word.sentences?.[index]?.c
  if (!text) return
  const wordKey = props.word.word
  const highlight = options?.highlight ?? false
  if (highlight) highlightedSentenceIndex = index
  playTtsWithGuide(text, () => {
    if (props.word.word === wordKey && highlight && highlightedSentenceIndex === index) {
      highlightedSentenceIndex = -1
    }
  })
}

watch(
  () => props.word.word,
  () => {
    highlightedSentenceIndex = -1
    sentenceRefMap = new Map<any, any>()
    expanded.value = false
  }
)

// 例句跟打进行到第二条时自动展开，否则用户看不到正在跟打的句子
watch(activeSentenceIndex, index => {
  if (index > 0) expanded.value = true
})

function onCompleteSentence(text: string) {
  //简单比对，句子里面是否有当前单词，没有则为错
  if (!text.includes(props.word.word)) emit('wrong')
  if (activeSentenceIndex < props.word.sentences.length - 1) {
    activeSentenceIndex++
  } else {
    activeSentenceIndex = -1
    emit('complete')
    // Toast.success('句子练习完成')
  }
}

function startPracticeSentence() {
  activeSentenceIndex = 0
}

defineExpose({ startPracticeSentence, playSentence })
</script>

<template>
  <div class="word-meta">
    <!-- 翻译区 -->
    <template v-if="word?.trans?.length">
      <div class="translate flex flex-col items-center gap-2 my-2" v-opacity:noAnim="showTranslation">
        <TranslationList :word="word" :showFull="!effective.isWordMasked" />
      </div>
    </template>

    <!-- 例句列表 -->
    <template v-if="word?.sentences?.length">
      <div v-opacity="showDetails">
        <div class="line-white my-2"></div>
        <div
          class="sentence-typing"
          :class="{
            'sentence-highlight': highlightedSentenceIndex === j || activeSentenceIndex === j,
          }"
          v-for="(i, j) in visibleSentences"
          :key="i.c"
        >
          <TypingSentence
            :ref="el => setRef(j, el)"
            :key="i.c"
            :index="j"
            :sentence="i"
            :isHighlightWordsMask="effective.isWordMasked"
            :showSentenceTranslation="showTranslation"
            :active="activeSentenceIndex === j"
            :highlight-words="[word.word.toLowerCase()]"
            @complete="onCompleteSentence"
            @play="playSentence(j, { highlight: true })"
          />
        </div>
      </div>
    </template>

    <!-- 展开 / 收起：默认只显示第一条例句，其余内容按需展开 -->
    <div class="expand-row" v-if="canExpand && showDetails">
      <button class="expand-btn" type="button" @click="expanded = !expanded">
        <span>{{ expanded ? '收起' : '展开全部' }}</span>
        <span class="hint" v-if="!expanded && expandHint">（{{ expandHint }}）</span>
        <IconFluentChevronDown20Regular class="chevron" :class="{ up: expanded }" />
      </button>
    </div>

    <!-- 短语列表 -->
    <template v-if="expanded && word?.phrases?.length">
      <div v-opacity="showDetails">
        <div class="line-white my-2"></div>
        <div class="flex">
          <div class="label">{{ $t('phrases') }}</div>
          <div class="flex flex-col">
            <div class="flex items-center gap-4" v-for="(item, index) in word.phrases" :key="index">
              <div class="flex gap-space items-center">
                <ClickableEnglishText class="en" :text="item.c" :word="word.word" :dictation="effective.isWordMasked" />
                <VolumeIcon :simple="false" title="发音" @click.stop="() => playTtsWithGuide(item.c)" />
              </div>
              <div class="anim" v-opacity="showTranslation">
                {{ item.cn }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 近义词 -->
    <template v-if="expanded && word?.synos?.length">
      <div v-opacity="showDetails">
        <div class="line-white my-2"></div>
        <div class="flex">
          <div class="label">{{ $t('synonyms') }}</div>
          <div class="flex flex-col gap-3">
            <div class="flex" v-for="item in word.synos">
              <div class="pos en">{{ item.pos }}</div>
              <div>
                <div v-opacity="showTranslation">
                  {{ item.cn }}
                </div>
                <div>
                  <template v-for="(i, j) in item.ws" :key="j">
                    <ClickableWord class="en" :word="i" />
                    <span v-if="j !== item.ws.length - 1"> / </span>
                  </template>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 词源 / 关联词 -->
    <template v-if="expanded && settingStore.showEtymologyAndRelWords">
      <template v-if="word?.etymology?.length">
        <div v-opacity="showEtymology">
          <div class="line-white my-2"></div>
          <div class="flex">
            <div class="label">{{ $t('etymology') }}</div>
            <div>
              <div v-for="item in word.etymology">
                <div>{{ item.t }}</div>
                <div>{{ item.d }}</div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <template v-if="word?.relWords?.root">
        <div v-opacity="showEtymology">
          <div class="line-white my-2"></div>
          <div class="flex">
            <div class="label">{{ $t('related_words') }}</div>
            <div class="flex flex-col">
              <div v-if="word.relWords.root">
                {{ $t('word_root') }}：
                <ClickableWord class="en" :word="word.relWords.root" />
              </div>
              <div class="flex" v-for="item in word.relWords.rels">
                <div class="pos">{{ item.pos }}</div>
                <div>
                  <div class="flex items-center gap-4" v-for="itemj in item.words">
                    <ClickableWord class="en" :word="itemj.c" />
                    <div class="cn">{{ itemj.cn }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped lang="scss">
.word-meta {
  width: 100%;

  .expand-row {
    display: flex;
    justify-content: center;
    margin: 0.6rem 0 0.2rem;
  }

  .expand-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem 0.7rem;
    border-radius: 999px;
    min-height: 2rem;
    border: 1px solid var(--color-item-border);
    background: transparent;
    color: var(--color-main-text);
    opacity: 0.62;
    font-size: 0.82rem;
    cursor: pointer;
    transition:
      opacity 0.2s,
      border-color 0.2s,
      background 0.2s;

    .hint {
      opacity: 0.8;
    }

    .chevron {
      transition: transform 0.2s;
      font-size: 0.9rem;

      &.up {
        transform: rotate(180deg);
      }
    }

    &:hover {
      opacity: 1;
      border-color: var(--color-main-text);
      background: var(--color-fourth);
    }
  }

  .label {
    width: 7rem;
    padding-top: 0.2rem;
    flex-shrink: 0;
  }

  .sentence {
    @apply rounded-lg px-3 py-2 -mx-3;
    background: transparent;
    transition:
      background-color 0.3s ease,
      box-shadow 0.3s ease;
  }

  .sentence-typing {
    @apply rounded-lg px-3 py-1 -mx-3;
    background: transparent;
    transition:
      background-color 0.3s ease,
      box-shadow 0.3s ease;
  }

  .sentence-highlight {
    background: color-mix(in srgb, var(--color-link) 10%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-link) 25%, transparent);
  }
}

@media (max-width: 768px) {
  .word-meta {
    .label {
      @apply w-unset mr-2;
    }

    :deep(.pos) {
      @apply w-unset mr-2 min-w-unset;
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .word-meta .sentence,
  .word-meta .sentence-typing {
    transition-duration: 0.01ms;
  }
}
</style>

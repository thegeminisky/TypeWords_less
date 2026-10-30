import { getCurrentStudyWord } from '@/core/hooks/dict.ts'
import { useBaseStore } from '@/core/stores/base.ts'
import { useSettingStore } from '@/core/stores/setting.ts'
import type { TaskWords, Word } from '@/core/types/types.ts'
import { shuffle } from '@/core/utils'
import * as remote from '@/core/utils/remote.ts'
import dayjs from 'dayjs'
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore'

dayjs.extend(isSameOrBefore)

export interface StudyTaskResult {
  taskWords: TaskWords
  dueReviewCount: number
  randomReviewCount: number
}

interface AddRandomReviewOptions {
  words: Word[]
  lastLearnIndex: number
  perDayStudyNumber: number
  wordReviewRatio: number
  ignoreSet: Set<string>
  enabled: boolean
}

export function addRandomReviewWhenNoDue(taskWords: TaskWords, options: AddRandomReviewOptions): StudyTaskResult {
  const dueReviewCount = taskWords.review.length
  if (!options.enabled || dueReviewCount > 0) {
    return { taskWords, dueReviewCount, randomReviewCount: 0 }
  }

  const totalNeed = Math.max(0, Math.floor(options.perDayStudyNumber * options.wordReviewRatio))
  if (!totalNeed) {
    return { taskWords, dueReviewCount, randomReviewCount: 0 }
  }

  const excludedWords = new Set([
    ...options.ignoreSet,
    ...taskWords.new.map(item => item.word),
    ...taskWords.review.map(item => item.word),
  ])
  const learnedEnd = Math.min(options.lastLearnIndex, options.words.length)
  const randomReviewWords = shuffle(
    options.words.slice(0, learnedEnd).filter(item => !excludedWords.has(item.word))
  ).slice(0, totalNeed)

  taskWords.review = taskWords.review.concat(randomReviewWords)
  return {
    taskWords,
    dueReviewCount,
    randomReviewCount: randomReviewWords.length,
  }
}

/**
 * 生成当次学习任务。
 *
 * - 官方词典：静态词表已在本地，沿用本地计算
 * - 自建词典 / 收藏：词表在服务端，由服务端按「当次学习量」取词
 *   （新词从 lastLearnIndex 往后取 perDay 个 + fsrs 到期复习词 + 可选随机复习），
 *   客户端不再整份下载词表
 */
export async function createStudyTask(): Promise<StudyTaskResult> {
  const store = useBaseStore()
  const settingStore = useSettingStore()
  const dict = store.sdict
  const ignoreSet = store.getIgnoreWordsSet()

  // 官方词典：词表来自静态资源，已在本地
  if (!dict.custom && !dict.system) {
    return addRandomReviewWhenNoDue(getCurrentStudyWord(), {
      words: dict.words,
      lastLearnIndex: dict.lastLearnIndex,
      perDayStudyNumber: dict.perDayStudyNumber,
      wordReviewRatio: settingStore.wordReviewRatio,
      ignoreSet,
      enabled: settingStore.autoAddRandomReviewWhenNoDue,
    })
  }

  // 自建词典 / 收藏：服务端取词
  const dueAll = Object.entries(store.fsrsData)
    .filter(([, card]) => dayjs(card.due).isSameOrBefore(dayjs(), 'day'))
    .map(([word]) => word)
  const dueWords = dueAll.filter(word => !ignoreSet.has(word))
  // 已忽略的到期卡直接清掉，避免反复参与比较
  dueAll.filter(word => ignoreSet.has(word)).forEach(word => {
    delete store.fsrsData[word]
  })

  const noDue = dueWords.length === 0
  const useRandomReview = settingStore.autoAddRandomReviewWhenNoDue && noDue
  const res = await remote.fetchStudyPlan({
    id: String(dict.id),
    start: dict.lastLearnIndex,
    count: dict.perDayStudyNumber,
    ignore: Array.from(ignoreSet),
    dueWords,
    randomReview: useRandomReview
      ? { end: dict.lastLearnIndex, count: Math.floor(dict.perDayStudyNumber * settingStore.wordReviewRatio) }
      : null,
  })

  const taskWords: TaskWords = {
    new: (res?.newWords ?? []) as Word[],
    review: (res?.reviewWords ?? []) as Word[],
  }
  return {
    taskWords,
    dueReviewCount: dueWords.length,
    randomReviewCount: res?.randomCount ?? 0,
  }
}

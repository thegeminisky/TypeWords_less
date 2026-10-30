import { computed } from 'vue'
import { createEmptyCard, Rating } from 'ts-fsrs'
import { useBaseStore } from '@/core/stores/base.ts'
import { usePracticeStore } from '@/core/stores/practice.ts'
import { useSettingStore } from '@/core/stores/setting.ts'
import { useRuntimeStore } from '@/core/stores/runtime.ts'
import type { TaskWords, Word } from '@/core/types/types.ts'
import { WordPracticeMode } from '@/core/types/enum.ts'
import { getDefaultWord } from '@/core/types/func.ts'
import { cloneDeep, getShufflePracticeWords, shuffle } from '@/core/utils'
import { useGetGradeByWrongTimes, useNextCard } from '@/core/hooks/fsrs.ts'
import { flushStatToStore } from '@/core/composables/usePracticePersistence.ts'
import {
  addWrongWordKey,
  getDefaultPracticeData,
  type PracticeData,
  type PracticeWordCache,
} from './practice-word-session.ts'
import { resolvePracticeQuestion } from './practice-question.ts'
import { normalizePracticeTimer } from './usePracticeIdleTimer.ts'
import { createPracticeWordNavigator } from './usePracticeWordNavigator.ts'
import { usePracticeDisplayPolicy } from './usePracticeDisplayPolicy.ts'
import * as remote from '@/core/utils/remote.ts'
import type { PracticeNotifier } from './practice-flow-types.ts'
import { createStudyTask } from './study-task.ts'

export interface PracticeWordSessionOptions {
  getPracticeData: () => PracticeData
  setPracticeData: (data: PracticeData) => void
  getTaskWords: () => TaskWords
  getAllWords: () => Word[]
  complete: () => void
  scheduleSave: () => void
  notify?: PracticeNotifier
  /** 平台可按运行能力提供有效模式，不会回写用户的持久设置。 */
  getPracticeMode?: () => WordPracticeMode
}

export interface PracticeWordMarkPickResult {
  know: Word[]
  unknown: Word[]
}

/**
 * 单词练习的平台无关会话控制器。
 *
 * 页面只负责词典加载、页面生命周期和 UI；Flow、缓存恢复、题目、错词与
 * 当前会话内的单词操作统一由该控制器维护。
 */
export function usePracticeWordSession(options: PracticeWordSessionOptions) {
  const store = useBaseStore()
  const statStore = usePracticeStore()
  const settingStore = useSettingStore()
  const runtimeStore = useRuntimeStore()
  const { getGradeByWrongTimes } = useGetGradeByWrongTimes()
  const { nextCard } = useNextCard()
  const getPracticeMode = () => options.getPracticeMode?.() ?? settingStore.wordPracticeMode

  const currentWord = computed(() => {
    const data = options.getPracticeData()
    return data.words[data.index] ?? getDefaultWord()
  })

  function reconcilePracticeTimer() {
    const normalized = normalizePracticeTimer(statStore.segments, statStore.spend)
    statStore.segments = normalized.segments
    statStore.spend = normalized.spend
  }

  const nav = createPracticeWordNavigator({
    getPracticeData: options.getPracticeData,
    getTaskWords: options.getTaskWords,
    getCurrentWord: () => currentWord.value,
    checkWordIsNeedNext(word) {
      if (!word.word) return false
      const data = options.getPracticeData()
      return data.excludeWords.includes(word.word)
    },
    complete: options.complete,
    notify: options.notify,
  })

  const { activeFlowConfig, activeCursor, currentPhase, currentPracticeType, currentPhaseKey } = nav
  const display = usePracticeDisplayPolicy(currentPracticeType, currentPhaseKey)

  function updateQuestion() {
    const data = options.getPracticeData()
    data.question = resolvePracticeQuestion(currentPracticeType.value, currentWord.value, options.getAllWords())
  }

  function restorePracticeSession(cache: Pick<PracticeWordCache, 'sessionSnapshot'>): boolean {
    return !!cache.sessionSnapshot && nav.restoreSessionSnapshot(cache.sessionSnapshot)
  }

  function applyPracticeCache(cache: PracticeWordCache): boolean {
    if (!cache.practiceData || !cache.statStoreData) return false

    const taskWords = options.getTaskWords()
    const previousTaskWords = cloneDeep(taskWords)
    const previousData = cloneDeep(options.getPracticeData())
    const previousStatStoreData = cloneDeep(statStore.$state)
    const previousSessionSnapshot = nav.buildSessionSnapshot()

    Object.assign(taskWords, cache.taskWords)
    options.setPracticeData(getDefaultPracticeData(options.getPracticeData(), cache.practiceData))
    statStore.$patch(cache.statStoreData)
    reconcilePracticeTimer()

    if (!restorePracticeSession(cache)) {
      Object.assign(taskWords, previousTaskWords)
      options.setPracticeData(getDefaultPracticeData(options.getPracticeData(), previousData))
      statStore.$patch(previousStatStoreData)
      nav.restoreSessionSnapshot(previousSessionSnapshot)
      return false
    }

    if (!statStore.timerPaused) {
      const now = Date.now()
      statStore.segments.push([now, now])
    }
    updateQuestion()
    return true
  }

  function initializeTask(taskWords: TaskWords): boolean {
    Object.assign(options.getTaskWords(), taskWords)
    try {
      const start = nav.resolveFlowStart(getPracticeMode(), options.getTaskWords())
      options.setPracticeData(getDefaultPracticeData(options.getPracticeData(), { words: start.words }))
      statStore.total = start.total
      statStore.newWordNumber = start.newWordNumber
      statStore.reviewWordNumber = start.reviewWordNumber
      activeCursor.value = { ...start.cursor }
      nav.initializeNodeWords(start.words)
    } catch {
      return false
    }

    statStore.startDate = Date.now()
    statStore.inputWordNumber = 0
    statStore.wrong = 0
    statStore.spend = 0
    statStore.segments = []
    statStore.resumeTimer()
    updateQuestion()
    return true
  }

  function addExcludeWord() {
    const data = options.getPracticeData()
    const key = currentWord.value.word
    if (key && !data.excludeWords.includes(key)) data.excludeWords.push(key)
  }

  function onTypeWrong() {
    const data = options.getPracticeData()
    const word = currentWord.value
    if (!word.word) return

    data.wrongTimes++
    addWrongWordKey(data.allWrongWords, word.word)
    if (!data.wrongWords.some(item => item.word === word.word)) data.wrongWords.push(word)
    const excludeIndex = data.excludeWords.findIndex(key => key === word.word)
    if (excludeIndex >= 0) data.excludeWords.splice(excludeIndex, 1)
    options.scheduleSave()
  }

  function resolveIdentifyCorrect() {
    const data = options.getPracticeData()
    const word = currentWord.value
    const wrongIndex = data.wrongWords.findIndex(item => item.word === word.word)
    if (wrongIndex >= 0) {
      options.notify?.('info', `${word.word} 已从错词列表移除，原因：用户已认识`)
      data.wrongWords.splice(wrongIndex, 1)
    }
    data.allWrongWords = data.allWrongWords.filter(key => key !== word.word)
    data.wrongTimes = 0
    addExcludeWord()
    options.scheduleSave()
  }

  function onWordKnow() {
    options.getPracticeData().ratingMap[currentWord.value.word] = Rating.Good
    resolveIdentifyCorrect()
  }

  function skip() {
    addExcludeWord()
    nav.next(false)
  }

  function randomWrite() {
    const data = options.getPracticeData()
    data.words = shuffle(data.words)
    data.index = 0
    display.setWordMasked(true)
  }

  function onWordMarkPickComplete(result: PracticeWordMarkPickResult) {
    const data = options.getPracticeData()
    result.know.forEach(word => {
      data.ratingMap[word.word] = Rating.Good
      if (!data.excludeWords.includes(word.word)) data.excludeWords.push(word.word)
    })
    data.wrongWords = cloneDeep(result.unknown)
    result.unknown.forEach(word => {
      addWrongWordKey(data.allWrongWords, word.word)
      data.wrongTimesMap[word.word] = Rating.Good
    })
    nav.completeCurrentList()
  }

  function updateCompletedDictProgress(ignoreScope: 'remaining' | 'all') {
    if (getPracticeMode() === WordPracticeMode.Shuffle) return
    store.sdict.lastLearnIndex += statStore.newWordNumber
    // 词表在服务端，本地数不到「剩余全是忽略词」的情况，
    // 学到最后一个词即视为完成
    if (store.sdict.lastLearnIndex >= store.sdict.length) {
      store.sdict.complete = true
      store.sdict.lastLearnIndex = store.sdict.length
    }
  }

  function settleLocalPractice() {
    const data = options.getPracticeData()
    statStore.wrong = data.allWrongWords.length
    updateCompletedDictProgress('remaining')
    if (!statStore.timerPaused && statStore.segments.length > 0) {
      statStore.segments[statStore.segments.length - 1][1] = Date.now()
    }
    reconcilePracticeTimer()
    flushStatToStore(statStore.$state)

    for (const [word, wrongTimes] of Object.entries(data.wrongTimesMap)) {
      const rating = data.ratingMap[word] ?? getGradeByWrongTimes(wrongTimes)
      const card = store.fsrsData[word] ?? createEmptyCard()
      store.fsrsData[word] = nextCard(card, rating)
    }
  }

  function createRepeatTask(): TaskWords {
    const taskWords = cloneDeep(options.getTaskWords())
    const ignoreSet = store.getIgnoreWordsSet()
    if (getPracticeMode() === WordPracticeMode.Shuffle) {
      taskWords.review = shuffle(taskWords.review.filter(word => !ignoreSet.has(word.word)))
    } else {
      store.sdict.lastLearnIndex -= statStore.newWordNumber
      taskWords.new = taskWords.new.filter(word => !ignoreSet.has(word.word))
      taskWords.review = taskWords.review.filter(word => !ignoreSet.has(word.word))
    }
    return taskWords
  }

  async function createNextTask(wasComplete: boolean): Promise<TaskWords> {
    if (getPracticeMode() === WordPracticeMode.Shuffle) {
      // 乱序模式：区间选词交给服务端，客户端只拿当次要练的词
      const range = runtimeStore.routeData?.shuffleRange ?? { start: 0, end: store.sdict.lastLearnIndex }
      const total = runtimeStore.routeData?.total ?? options.getTaskWords().review.length
      const res = await remote.fetchStudyPlan({
        id: String(store.sdict.id),
        start: store.sdict.lastLearnIndex,
        count: 0,
        ignore: Array.from(store.getIgnoreWordsSet()),
        shuffle: { start: range.start, end: range.end, count: total },
      })
      return { new: [], review: (res?.shuffleWords ?? []) as Word[] }
    }

    if (!wasComplete) updateCompletedDictProgress('all')
    return (await createStudyTask()).taskWords
  }

  async function createTaskFromGroup(group: number): Promise<TaskWords> {
    store.sdict.lastLearnIndex = (group - 1) * store.sdict.perDayStudyNumber
    return (await createStudyTask()).taskWords
  }

  return {
    nav,
    currentWord,
    activeFlowConfig,
    activeCursor,
    currentPhase,
    currentPracticeType,
    currentPhaseKey,
    ...display,
    reconcilePracticeTimer,
    updateQuestion,
    applyPracticeCache,
    initializeTask,
    onTypeWrong,
    onWordKnow,
    skip,
    randomWrite,
    onWordMarkPickComplete,
    settleLocalPractice,
    createRepeatTask,
    createNextTask,
    createTaskFromGroup,
  }
}

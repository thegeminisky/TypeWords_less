import type { Dict, TaskWords, Word } from '../types'
import { getDefaultDict, getDefaultWord } from '../types'
import { useBaseStore } from '../stores/base.ts'
import { useSettingStore } from '../stores/setting.ts'
import { cloneDeep, shuffle } from '../utils'
import { markDictWordsDirty, useDictWords } from '../composables/useDictWords.ts'
import { DictId } from '../config/env.ts'
import dayjs from 'dayjs'
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore'

dayjs.extend(isSameOrBefore)

export function useWordOptions() {
  const store = useBaseStore()
  const { ensureWords } = useDictWords()

  function isWordCollect(val: Word) {
    return !!store.collectWord.words.find(v => v.word.toLowerCase() === val.word.toLowerCase())
  }

  async function toggleWordCollect(val: Word) {
    // 词表按需拉取：先确保收藏词典的词已就位，否则会把远端整份收藏覆盖成一条
    await ensureWords(store.collectWord)
    let rIndex = store.collectWord.words.findIndex(v => v.word.toLowerCase() === val.word.toLowerCase())
    if (rIndex > -1) {
      store.collectWord.words.splice(rIndex, 1)
    } else {
      store.collectWord.words.push(val)
    }
    store.collectWord.length = store.collectWord.words.length
    markDictWordsDirty(store.collectWord.id)
  }

  function getCollectibleDicts(excludeDictId?: string) {
    return store.word.bookList.filter(dict => {
      if (dict.id !== DictId.wordCollect && !dict.custom) return false
      if (excludeDictId && isDictIdMatch(dict, excludeDictId)) return false
      return true
    })
  }

  function resolveDictInBookList(dict: Dict) {
    return store.word.bookList.find(d => isDictIdMatch(d, dict.id)) ?? dict
  }

  async function addWordToDict(val: Word, dict: Dict): Promise<{ ok: boolean }> {
    const target = resolveDictInBookList(dict)
    await ensureWords(target)
    const rIndex = target.words.findIndex(v => v.word.toLowerCase() === val.word.toLowerCase())
    if (rIndex > -1) return { ok: false }
    target.words.push(val)
    target.length = target.words.length
    markDictWordsDirty(target.id)
    return { ok: true }
  }

  async function createCustomDict(
    name: string
  ): Promise<{ ok: true; dict: Dict } | { ok: false; reason: 'empty' | 'duplicate' | 'api' }> {
    const trimmed = name.trim()
    if (!trimmed) return { ok: false, reason: 'empty' }
    if (store.word.bookList.find(v => v.name === trimmed)) {
      return { ok: false, reason: 'duplicate' }
    }
    let data: Dict = getDefaultDict({
      name: trimmed,
      id: 'custom-dict-' + Date.now(),
      custom: true,
    })
    data.type = DictType.word
    store.word.bookList.push(cloneDeep(data))
    return { ok: true, dict: data }
  }

  return {
    isWordCollect,
    toggleWordCollect,
    getCollectibleDicts,
    addWordToDict,
    createCustomDict,
  }
}

export function getCurrentStudyWord(): TaskWords {
  const store = useBaseStore()
  let data: TaskWords = { new: [], review: [] }
  let dict = store.sdict
  let isTest = false
  let words = dict.words.slice()
  if (isTest) {
    words = Array.from({ length: 10 }).map((v, i) => {
      return getDefaultWord({ word: String(i) })
    })
  }

  if (words?.length) {
    const settingStore = useSettingStore()
    //忽略列表：内置简单词（可在设置里选择是否跳过）
    const ignoreSet = store.getIgnoreWordsSet()
    const perDay = dict.perDayStudyNumber
    const start = isTest ? 1 : dict.lastLearnIndex
    const complete = isTest ? true : dict.complete
    const isEnd = start >= dict.length - 1 && dict.length !== 1
    const reviewRatio = settingStore.wordReviewRatio

    let end = start
    if (!isEnd) {
      //从start往后取perDay个单词，作为新词
      for (let i = start; i < words.length; i++) {
        let item = words[i]
        if (data.new.length >= perDay) break
        if (!ignoreSet.has(item.word)) {
          data.new.push(item)
        }
        end++
      }
    }

    //如果复习比大于等于1，或者已完成，才生成复习词
    if (reviewRatio >= 1 || complete || isEnd) {
      //Map建立索引，用于查找、包含
      const wordMap = new Map(words.map(s => [s.word, s]))
      //复习总数量;如果已结束那么复习比最小是1
      const totalNeed = perDay * (isEnd ? reviewRatio || 1 : reviewRatio)
      const now = dayjs()
      let waitRemoveFromFsrsData = []
      //取 due 到期的单词
      let reviewWordStrList = Object.entries(store.fsrsData)
        .filter(([word, card]) => {
          //1、这里的due字段被json序列化之后又恢复是字符串了，所以要用dayjs比较
          //2、要在当前学习这本词典里面
          //3、不在新词里面
          //4、到自然日就算到期
          // console.log(`单词：${word},到期时间：${dayjs(card.due).format('YYYY-MM-DD HH:mm:ss')}`)
          let isMastered = ignoreSet.has(word)
          if (isMastered) {
            waitRemoveFromFsrsData.push(word)
          }
          return (
            !isMastered &&
            dayjs(card.due).isSameOrBefore(now, 'day') &&
            wordMap.has(word) &&
            !data.new.find(v => v.word === word)
          )
        })
        .sort((a, b) => dayjs(a[1].due).valueOf() - dayjs(b[1].due).valueOf())
        .map(([word]) => word)

      waitRemoveFromFsrsData.map(word => {
        delete store.fsrsData[word]
      })
      // console.log('fsrs 里 due 到期单词', reviewWordStrList)

      data.review = shuffle(
        reviewWordStrList
          .slice(0, totalNeed)
          .map(word => wordMap.get(word))
          .filter(obj => obj)
      )
      //如果数量不够再填充
      // if (data.review.length < totalNeed) {
      //   // 固定填充逻辑
      //   let list = words.slice(0, start).reverse()
      //   if (complete) list = list.concat(words.slice(end).reverse())
      //   // 固定填充复习词需要过滤掉有FSRS记录的
      //   let set = new Set(
      //     Array.from(ignoreSet)
      //       .concat(Object.keys(store.fsrsData))
      //       .concat(data.new.map(v => v.word))
      //   )
      //   list = list.filter(item => !set.has(item.word))
      //   data.review = data.review.concat(list.slice(0, totalNeed - data.review.length))
      // }
    }
  }
  return data
}

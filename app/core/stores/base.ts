import { defineStore } from 'pinia'
import { type Dict, getDefaultDict, type SaveData, type Word } from '../types'
import { _getStudyProgress, checkAndUpgradeSaveDict, isSameDictResource, parseJsonStr } from '../utils'
import { shallowReactive } from 'vue'
import { get } from 'idb-keyval'
import { DictId, IS_DEV, SAVE_DICT_KEY } from '../config/env'
import type { Card } from 'ts-fsrs'
import { useSettingStore } from './setting.ts'

export interface BaseState {
  simpleWords: string[]
  load: boolean
  word: {
    studyIndex: number
    bookList: Dict[]
  }
  dictListVersion: number
  fsrsData: Record<string, Card>
  noteData: Record<string, string> // 集中存储单词笔记，key 为单词字符串
  _ignoreWatch: boolean //忽略监听，避免重复保存和上传
}

export const getDefaultBaseState = (): BaseState => ({
  simpleWords: [
    'a',
    'an',
    'i',
    'my',
    'me',
    'you',
    'your',
    'he',
    'his',
    'she',
    'her',
    'it',
    'what',
    'who',
    'where',
    'how',
    'when',
    'which',
    'be',
    'am',
    'is',
    'was',
    'are',
    'were',
    'do',
    'did',
    'can',
    'could',
    'will',
    'would',
    'the',
    'that',
    'this',
    'and',
    'not',
    'no',
    'yes',
    'to',
    'of',
    'for',
    'at',
    'in',
  ],
  load: false,
  word: {
    bookList: [
      getDefaultDict({ id: DictId.wordCollect, enName: DictId.wordCollect, name: '收藏', system: true }),
      getDefaultDict({ id: DictId.wordWrong, enName: DictId.wordWrong, name: '错词', system: true }),
      getDefaultDict({
        id: DictId.wordKnown,
        enName: DictId.wordKnown,
        name: '已掌握',
        description: '已掌握后的单词不会出现在练习中',
        system: true,
      }),
    ],
    studyIndex: -1,
  },
  dictListVersion: 1,
  fsrsData: {},
  noteData: {},
  _ignoreWatch: false,
})

export const useBaseStore = defineStore('base', {
  state: (): BaseState => {
    return getDefaultBaseState()
  },
  getters: {
    collectWord(): Dict {
      let res = this.word.bookList.find(v => [v.enName, v.id].includes(DictId.wordCollect))
      return res ?? getDefaultDict()
    },
    wrong(): Dict {
      let res = this.word.bookList.find(v => [v.enName, v.id].includes(DictId.wordWrong))
      return res ?? getDefaultDict()
    },
    known(): Dict {
      let res = this.word.bookList.find(v => [v.enName, v.id].includes(DictId.wordKnown))
      return res ?? getDefaultDict()
    },
    knownWords(): string[] {
      return this.known.words.map((v: Word) => v.word.toLowerCase())
    },
    allIgnoreWords(): string[] {
      return this.known.words
        .map((v: Word) => v.word.toLowerCase())
        .concat(this.simpleWords.map((v: string) => v.toLowerCase()))
    },
    knownWordsSet(): Set<string> {
      return new Set<string>(this.known.words.map((v: Word) => v.word))
    },
    allIgnoreWordsSet(): Set<string> {
      return new Set<string>(this.known.words.map((v: Word) => v.word).concat(this.simpleWords.map((v: string) => v)))
    },
    sdict(): Dict {
      if (this.word.studyIndex >= 0) {
        return this.word.bookList[this.word.studyIndex] ?? getDefaultDict()
      }
      return getDefaultDict()
    },
    groupLength(): number {
      return Math.ceil(this.sdict.length / this.sdict.perDayStudyNumber)
    },
    currentGroup(): number {
      //当能除尽时，应该加1
      let s = this.sdict.lastLearnIndex % this.sdict.perDayStudyNumber
      let d = this.sdict.lastLearnIndex / this.sdict.perDayStudyNumber
      return Math.floor(s === 0 ? d + 1 : d)
    },
    currentStudyProgress(): number {
      if (!this.sdict.length) return 0
      return _getStudyProgress(this.sdict.lastLearnIndex, this.sdict.length)
    },
  },
  actions: {
    getIgnoreWordsSet(): Set<string> {
      let settingStore = useSettingStore()
      return [this.allIgnoreWordsSet, this.knownWordsSet][settingStore.ignoreSimpleWord ? 0 : 1]
    },
    setState(obj: BaseState) {
      obj.word.bookList.map(book => {
        book.words = shallowReactive(book.words)
        book.statistics = shallowReactive(book.statistics)
      })
      //必须先 reset, 只 $patch 无法将 state 恢复到默认值
      this.$reset()
      console.time('$patch')
      if (IS_DEV) {
        this.$state = obj
      } else {
        this.$patch(obj)
      }
      console.timeEnd('$patch')
    },
    async init(): Promise<SaveData | null> {
      return new Promise(async resolve => {
        try {
          let jsonStr: string = await get(SAVE_DICT_KEY.key)
          if (jsonStr) {
            let result = await parseJsonStr(jsonStr, checkAndUpgradeSaveDict)
            // console.log('data', data)
            this.setState(result.val)
            resolve(result)
          }
          resolve(null)
        } catch (e) {
          console.error('读取本地dict数据失败', e)
          resolve(null)
        }
      })
    },
    //改变词典
    async changeDict(val: Dict) {
      //把其他的词典的单词数据都删掉，全保存在内存里太卡了
      this.word.bookList.slice(3).map(v => {
        if (!v.custom) {
          v.words = shallowReactive([])
        }
      })
      if (val.words?.length) {
        val.length = val.words.length
      }
      let rIndex = this.word.bookList.findIndex((v: Dict) => isSameDictResource(v, val))
      if (val.perDayStudyNumber > val.length) {
        val.perDayStudyNumber = val.length
      }
      if (val.lastLearnIndex > val.length) {
        val.lastLearnIndex = val.length
        val.complete = true
      }
      if (rIndex > -1) {
        this.word.studyIndex = rIndex
        this.word.bookList[this.word.studyIndex].words = shallowReactive(val.words)
        this.word.bookList[this.word.studyIndex].id = val.id
        this.word.bookList[this.word.studyIndex].enName = val.enName
        this.word.bookList[this.word.studyIndex].length = val.length
        this.word.bookList[this.word.studyIndex].perDayStudyNumber = val.perDayStudyNumber
        this.word.bookList[this.word.studyIndex].lastLearnIndex = val.lastLearnIndex
        this.word.bookList[this.word.studyIndex].userDictId = val.userDictId
        this.word.bookList[this.word.studyIndex].complete = val.complete
      } else {
        this.word.bookList.push(getDefaultDict(val))
        this.word.studyIndex = this.word.bookList.length - 1
      }
    },
  },
})

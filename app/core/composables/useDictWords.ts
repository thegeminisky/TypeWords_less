import type { Dict, Word } from '@/core/types/types.ts'
import { useBaseStore } from '@/core/stores/base.ts'
import { delDictWordsLocal, getDictWordsLocal, setDictWordsLocal } from '@/core/utils/cache'
import * as remote from '@/core/utils/remote'
import { Toast } from '@/base'

/**
 * 词典词表的按需加载 / 回写。
 *
 * 背景：以前整份 BaseState（含自建词典的全部词条）作为一个同步行上云，
 * 一本 IELTS 词典就能让存档涨到 15MB，每次存档、每个新浏览器都要搬一遍。
 * 现在同步行里只留词典元数据（长度、进度、统计），词表单独存在服务端
 * `words/<dictId>.json`，用到哪本词典才拉哪本，本地再缓存一份。
 *
 * 词表改动（收藏/新增/编辑/删除/导入）只需调用 markDictWordsDirty(id)，
 * 真正推送发生在下一次存档（saveDictState）之前，失败会留到下次重试。
 */

/** 待推送的词表；value 为真表示"用户改过，必须上传" */
const dirtyDictIds = new Set<string>()

export function markDictWordsDirty(id?: string | number | null) {
  const key = id === undefined || id === null ? '' : String(id)
  if (key) dirtyDictIds.add(key)
}

export function hasDirtyDictWords(): boolean {
  return dirtyDictIds.size > 0
}

export function clearDirtyDictWords(ids: string[] = Array.from(dirtyDictIds)) {
  ids.forEach(id => dirtyDictIds.delete(id))
}

export function useDictWords() {
  const store = useBaseStore()

  function findDict(id: string): Dict | undefined {
    return store.word.bookList.find(dict => String(dict.id) === id)
  }

  /**
   * 保证这本词典的 words 已经就位：
   * 内存里已有 → 直接用；本地缓存且版本一致 → 用缓存；否则向服务端要。
   * 官方词典不走这里（它们从静态资源按需拉取）。
   */
  async function ensureWords(dict?: Dict | null): Promise<Dict | null> {
    if (!dict?.id) return dict ?? null
    if (dict.words?.length) return dict

    const id = String(dict.id)
    const cached = await getDictWordsLocal(id)
    if (cached?.words?.length && cached.updated_at && cached.updated_at === dict.wordsUpdatedAt) {
      dict.words = cached.words as Word[]
      return dict
    }

    try {
      const res = await remote.fetchDictWords(id)
      if (res?.words?.length) {
        dict.words = res.words as Word[]
        dict.wordsUpdatedAt = res.updated_at ?? dict.wordsUpdatedAt
        void setDictWordsLocal(id, res.words, res.updated_at ?? undefined)
        return dict
      }
    } catch (error) {
      console.warn('[dict-words] 拉取词表失败，改用本地缓存', error)
    }

    if (cached?.words?.length) {
      dict.words = cached.words as Word[]
      return dict
    }
    // 词表没拿到就等于没法学：明确告知，别让用户对着 0 词的词典发呆
    if ((dict.length ?? 0) > 0) {
      Toast.warning('词表拉取失败，请检查网络后重试')
    }
    return dict
  }

  /** 把标记为 dirty 的词表推到服务端；返回是否全部成功 */
  async function flushDirtyWords(): Promise<boolean> {
    if (!dirtyDictIds.size) return true
    let allOk = true
    for (const id of Array.from(dirtyDictIds)) {
      const dict = findDict(id)
      if (!dict) {
        dirtyDictIds.delete(id)
        continue
      }
      const words = Array.from(dict.words ?? [])
      try {
        const res = await remote.pushDictWords(id, words)
        if (res?.updated_at) dict.wordsUpdatedAt = res.updated_at
        await setDictWordsLocal(id, words, res?.updated_at)
        dirtyDictIds.delete(id)
      } catch (error) {
        allOk = false
        console.warn('[dict-words] 词表上传失败，下次存档再试', id, error)
      }
    }
    return allOk
  }

  /** 词典被删除时清掉服务端与本地词表 */
  async function dropWords(id?: string | number | null) {
    const key = id === undefined || id === null ? '' : String(id)
    if (!key) return
    dirtyDictIds.delete(key)
    await delDictWordsLocal(key)
    await remote.deleteDictWords(key)
  }

  return { ensureWords, flushDirtyWords, dropWords }
}

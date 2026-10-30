import {
  _getDictDataByUrl,
  checkAndUpgradeSaveDict,
  checkAndUpgradeSaveSetting,
  shakeCommonDict,
  shouldFetchRemote,
} from '../utils'
import { useDictWords } from './useDictWords'
import {
  getPracticeWordCacheLocal,
  getPracticeWordCacheLocalWithMeta,
  PRACTICE_WORD_CACHE,
  type PracticeWordCacheStored,
  setPracticeWordCacheLocal,
} from '../utils/cache'
import { APP_VERSION, BACKUP_INDEX_KEY, BACKUP_KEY, SAVE_DICT_KEY, SAVE_SETTING_KEY, WEBSITE_VERSION_HASH } from '../config/env'
import { type BaseState, getDefaultBaseState, getDefaultSettingState, useBaseStore, useSettingStore } from '../stores'
import type { BackupData, SaveData, Snapshot } from '../types/types.ts'
import { SyncDataType, CompareResult } from '../types/enum'
import { del, get, set } from 'idb-keyval'
import { Toast } from '@/base'
import { useRuntimeStore } from '../stores/runtime'
import * as remote from '../utils/remote'

type RemoteMetaRow = {
  type: remote.SyncType
  updated_at?: string
  data_version?: number
}

type RemoteDataRow = RemoteMetaRow & {
  data: any
}

type LocalPersistMeta = {
  updated_at?: string
  version?: number
}

type SaveLocalAndSyncOptions = {
  pullWhenRemoteNewer?: boolean
  pushWhenLocalNewer?: boolean
  canSyncRemote?: boolean
}

/** 需要与服务端同步的数据类型（文章功能已移除，practice_article 不再使用） */
const ALL_SYNC_TYPES: remote.SyncType[] = [SyncDataType.dict, SyncDataType.setting, SyncDataType.practice_word]

function getDataVersion(type: remote.SyncType): number {
  switch (type) {
    case SyncDataType.dict:
      return SAVE_DICT_KEY.version
    case SyncDataType.setting:
      return SAVE_SETTING_KEY.version
    case SyncDataType.practice_word:
      return PRACTICE_WORD_CACHE.version
    default:
      return 1
  }
}

function getPersistKey(type: remote.SyncType): string {
  return type === SyncDataType.dict ? SAVE_DICT_KEY.key : SAVE_SETTING_KEY.key
}

async function getLocalPersistMeta(type: remote.SyncType): Promise<LocalPersistMeta | null> {
  if (type === SyncDataType.practice_word) {
    return await getPracticeWordCacheLocalWithMeta()
  }
  const raw = await get(getPersistKey(type))
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function persistLocalState(type: remote.SyncType, val: unknown, updated_at?: string): Promise<void> {
  if (type === SyncDataType.practice_word) {
    await setPracticeWordCacheLocal(val as PracticeWordCacheStored, updated_at)
    return
  }
  await set(
    getPersistKey(type),
    JSON.stringify({
      val,
      version: getDataVersion(type),
      updated_at,
    })
  )
}

function applyDictData(store: ReturnType<typeof useBaseStore>, data: unknown) {
  store.setState(data as any)
  // studyIndex 有效且当前不是系统词典（收藏）时，才需要按需补拉官方词典词表
  if (store.word.studyIndex >= 0 && !store.sdict.system) {
    if (!store.sdict.custom && !store.sdict.system && !store.sdict.words.length) {
      _getDictDataByUrl(store.sdict).then(r => {
        store.word.bookList[store.word.studyIndex] = r
      })
    }
  }
}

// ---------------- 同步状态提示 ----------------
let lastSyncErrorAt = 0

function reportSyncError(message: string) {
  console.error('[sync]', message)
  try {
    useRuntimeStore().isError = true
  } catch {
    /* store 尚未初始化 */
  }
  const now = Date.now()
  if (now - lastSyncErrorAt < 30000) return
  lastSyncErrorAt = now
  Toast.error('进度同步失败，稍后重试')
}

function markSyncOk() {
  try {
    useRuntimeStore().isError = false
  } catch {
    /* ignore */
  }
}

async function fetchServerMeta(types: remote.SyncType[]): Promise<RemoteMetaRow[] | null> {
  try {
    return await remote.fetchSyncMeta(types)
  } catch (error) {
    reportSyncError((error as Error)?.message ?? String(error))
    return null
  }
}

async function fetchServerDatas(types: remote.SyncType[]): Promise<RemoteDataRow[] | null> {
  try {
    return await remote.fetchSyncData(types)
  } catch (error) {
    reportSyncError((error as Error)?.message ?? String(error))
    return null
  }
}

async function compareResultByType(
  type: remote.SyncType,
  remoteMetaMap: Map<string, RemoteMetaRow>,
  localMeta?: LocalPersistMeta
): Promise<CompareResult> {
  const remoteMeta = remoteMetaMap.get(type)
  if (!remoteMeta) return CompareResult.NoRemote
  if (localMeta == null) {
    localMeta = await getLocalPersistMeta(type)
  }
  if (!localMeta) {
    //本地没数据，但服务端有版本号，则服务端新
    return remoteMeta.data_version == null ? CompareResult.NoRemote : CompareResult.RemoteNewer
  }
  //本地没有更新日期，视为刚升级版本写入，以本地为准
  if (!localMeta?.updated_at) return CompareResult.LocalNewer
  const currentVersion = getDataVersion(type)
  return shouldFetchRemote(localMeta.updated_at, remoteMeta.updated_at, remoteMeta.data_version, currentVersion)
}

async function upsertServerDatas(rows: RemoteDataRow[]): Promise<boolean> {
  try {
    await remote.upsertSyncRows(rows.map(r => ({ type: r.type, data: r.data, data_version: r.data_version })))
    return true
  } catch (error) {
    reportSyncError((error as Error)?.message ?? String(error))
    return false
  }
}

async function applyRemoteDataByType(
  type: remote.SyncType,
  row: RemoteDataRow | null | undefined,
  store: ReturnType<typeof useBaseStore>,
  settingStore: ReturnType<typeof useSettingStore>
): Promise<void> {
  if (!row) return
  const now = new Date().toISOString()
  if (type === SyncDataType.setting) {
    const normalized = await checkAndUpgradeSaveSetting({
      val: row.data,
      version: row.data_version,
    })
    normalized.load = true
    normalized._ignoreWatch = true
    settingStore.setState(normalized)
    await persistLocalState(SyncDataType.setting, normalized, row.updated_at ?? now)
    return
  }
  if (type === SyncDataType.dict) {
    const normalized = await checkAndUpgradeSaveDict({
      val: row.data,
      version: row.data_version,
    })
    normalized.load = true
    normalized._ignoreWatch = true
    applyDictData(store, normalized)
    await persistLocalState(SyncDataType.dict, normalized, row.updated_at ?? now)
    return
  }
  await persistLocalState(type, row.data, row.updated_at ?? now)
}

type HashBackupIndexItem = {
  hash: string
  key: string
  createdAt: number
}

function normalizeHash(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim()
  return v.length > 0 ? v : null
}

export async function ensureHashGuardBeforeInit() {
  //@ts-ignore
  const runtimeConfig = useRuntimeConfig()

  try {
    const currentHash = normalizeHash(runtimeConfig?.public?.latestCommitHash)
    if (!currentHash) return

    const localHash = normalizeHash(await get(WEBSITE_VERSION_HASH))
    let res = true
    if (localHash !== currentHash) {
      res = await saveHashSnapshot(localHash ?? currentHash, '')
    }
    res && (await set(WEBSITE_VERSION_HASH, currentHash))
  } catch (e) {
    console.warn('init hash guard failed', e)
  }
}

export async function saveHashSnapshot(currentHash: string, previousHash: string | null): Promise<boolean> {
  const backupKey = `${BACKUP_KEY}${currentHash}`
  const createdAt = Date.now()

  const snapshot: Snapshot = {
    meta: {
      currentHash,
      previousHash,
      createdAt,
    },
    data: {
      dict: await get(SAVE_DICT_KEY.key),
      setting: await get(SAVE_SETTING_KEY.key),
      [PRACTICE_WORD_CACHE.key]: (await get(PRACTICE_WORD_CACHE.key)) ?? null,
    },
  }
  if (!snapshot.data.dict) {
    return false
  }
  await set(backupKey, snapshot)

  const rawIndex = (await get(BACKUP_INDEX_KEY)) as HashBackupIndexItem[] | undefined
  const index = Array.isArray(rawIndex)
    ? rawIndex.filter(item => item && typeof item.hash === 'string' && typeof item.key === 'string')
    : []

  let rIndex = index.findIndex(item => item.hash === currentHash)
  if (rIndex === -1) {
    index.push({ hash: currentHash, key: backupKey, createdAt })
  } else {
    index[rIndex] = { hash: currentHash, key: backupKey, createdAt }
  }

  if (index.length > 15) {
    index.sort((a, b) => a.createdAt - b.createdAt)
    const removed = index.splice(0, index.length - 10)
    for (const item of removed) {
      await del(item.key)
    }
  }
  await set(BACKUP_INDEX_KEY, index)
  return true
}

export function useDataSyncPersistence() {
  const store = useBaseStore()
  const { flushDirtyWords, dropWords } = useDictWords()
  const settingStore = useSettingStore()

  /** 仅在服务端数据更新时拉取 */
  async function pullIfRemoteNewer(type: remote.SyncType): Promise<RemoteDataRow | null> {
    const remoteMetas = await fetchServerMeta([type])
    if (!remoteMetas) return null
    const remoteMetaMap = new Map(remoteMetas.map(item => [item.type as string, item]))
    const compareResult = await compareResultByType(type, remoteMetaMap)
    if (compareResult === CompareResult.RemoteNewer) {
      const remoteData = await fetchServerDatas([type])
      if (remoteData?.length) {
        await applyRemoteDataByType(type, remoteData[0], store, settingStore)
        return remoteData[0]
      }
    }
    return null
  }

  /** 初始化时对齐本地与服务端：服务端较新则拉取，本地较新则推送 */
  async function syncData(
    localData: Partial<Record<remote.SyncType, SaveData | null>>,
    options?: SaveLocalAndSyncOptions
  ) {
    try {
      const types = Object.keys(localData) as remote.SyncType[]
      const remoteMetas = await fetchServerMeta(types)
      if (!remoteMetas) return

      const remoteMetaMap = new Map(remoteMetas.map(item => [item.type as string, item]))
      const pull: remote.SyncType[] = []
      const push: remote.SyncType[] = []

      for (const type of types) {
        const compareResult = await compareResultByType(type, remoteMetaMap)
        if (compareResult === CompareResult.RemoteNewer) pull.push(type)
        if ([CompareResult.LocalNewer, CompareResult.NoRemote].includes(compareResult)) push.push(type)
      }

      if (pull.length) {
        const rows = await fetchServerDatas(pull)
        for (const item of rows ?? []) {
          await applyRemoteDataByType(item.type as remote.SyncType, item, store, settingStore)
        }
      }

      if (push.length && options?.pushWhenLocalNewer !== false) {
        const rows: RemoteDataRow[] = []
        for (const type of push) {
          const item = localData[type]
          if (!item) continue
          rows.push({ type, data: item.val, data_version: item.version, updated_at: item.updated_at })
        }
        await upsertServerDatas(rows)
      }

      markSyncOk()
    } catch (error) {
      reportSyncError((error as Error)?.message ?? String(error))
    }
  }

  /** 本地先落盘，再推送到服务端 */
  async function saveLocalAndSync(
    type: remote.SyncType,
    data: unknown,
    options?: SaveLocalAndSyncOptions
  ): Promise<void> {
    try {
      const localMeta = await getLocalPersistMeta(type)
      const updated_at = new Date().toISOString()
      await persistLocalState(type, data, updated_at)

      if (options?.canSyncRemote === false) return

      // 需要时先确认服务端是否已被其他浏览器改得更晚
      if (options?.pullWhenRemoteNewer) {
        const remoteMetas = await fetchServerMeta([type])
        if (!remoteMetas) return
        const remoteMetaMap = new Map(remoteMetas.map(item => [item.type as string, item]))
        const compareResult = await compareResultByType(type, remoteMetaMap, localMeta)
        if (compareResult === CompareResult.RemoteNewer) {
          const remoteData = await fetchServerDatas([type])
          if (remoteData?.length) {
            await applyRemoteDataByType(type, remoteData[0], store, settingStore)
          }
          return
        }
      }

      const ok = await upsertServerDatas([{ type, data, data_version: getDataVersion(type), updated_at }])
      if (ok) markSyncOk()
    } catch (error) {
      reportSyncError((error as Error)?.message ?? String(error))
    }
  }

  async function getRemoteData(type: remote.SyncType): Promise<RemoteDataRow | null> {
    const rows = await fetchServerDatas([type])
    return rows?.[0] ?? null
  }

  async function getRemoteMeta(type: remote.SyncType): Promise<RemoteMetaRow | null> {
    const rows = await fetchServerMeta([type])
    return rows?.[0] ?? null
  }

  /** 把整份备份数据强推到服务端（导入 / 恢复历史版本时用） */
  async function forcePushLocalDataToRemote(data: BackupData['val']): Promise<boolean> {
    const updated_at = new Date().toISOString()
    const rows: RemoteDataRow[] = [
      { type: SyncDataType.dict, data: data.dict.val, data_version: SAVE_DICT_KEY.version, updated_at },
      { type: SyncDataType.setting, data: data.setting.val, data_version: SAVE_SETTING_KEY.version, updated_at },
      {
        type: SyncDataType.practice_word,
        //@ts-ignore
        data: data?.[PRACTICE_WORD_CACHE.key]?.val ?? null,
        data_version: PRACTICE_WORD_CACHE.version,
        updated_at,
      },
    ]
    const ok = await upsertServerDatas(rows)

    await persistLocalState(SyncDataType.dict, data.dict.val, updated_at)
    await persistLocalState(SyncDataType.setting, data.setting.val, updated_at)
    //@ts-ignore
    await persistLocalState(SyncDataType.practice_word, data?.[PRACTICE_WORD_CACHE.key]?.val ?? null, updated_at)
    if (ok) markSyncOk()
    return ok
  }

  /** 把服务端数据全部拉到本地 */
  async function pullAllRemoteToLocal(): Promise<boolean> {
    const rows = await fetchServerDatas(ALL_SYNC_TYPES)
    if (!rows) return false
    const map = new Map(rows.map(item => [item.type as string, item]))
    for (const type of ALL_SYNC_TYPES) {
      await applyRemoteDataByType(type, map.get(type), store, settingStore)
    }
    markSyncOk()
    return true
  }

  async function saveDictState(state: BaseState = store.$state, options?: SaveLocalAndSyncOptions) {
    // 先把改动过的词表单独推到 /api/dict/words，同步行里只带元数据
    await flushDirtyWords()
    const data = shakeCommonDict(state)
    await saveLocalAndSync(SyncDataType.dict, data, options)
  }

  async function getLocalCompactDataByType(type: remote.SyncType) {
    if (type === SyncDataType.practice_word) return await getPracticeWordCacheLocal()
    if (type === SyncDataType.dict) return shakeCommonDict(store.$state)
    if (type === SyncDataType.setting) return settingStore.$state
  }

  /** 清空全部进度：本地 + 服务端 */
  async function clear() {
    const wordDictIds = store.word.bookList.map(dict => String(dict.id)).filter(Boolean)
    const d = getDefaultBaseState()
    d.load = true
    const d1 = getDefaultSettingState()
    d1.load = true
    const data: any = {
      dict: { val: d },
      setting: { val: d1 },
      [PRACTICE_WORD_CACHE.key]: null,
      // @deprecated 大版本5废弃
      [APP_VERSION.key]: null,
    }
    store.setState(d)
    settingStore.setState(d1)
    // 词表单独存放在服务端 words/ 目录，整份重置时一并清掉
    for (const id of wordDictIds) await dropWords(id)
    return await forcePushLocalDataToRemote(data)
  }

  return {
    pullIfRemoteNewer,
    saveLocalAndSync,
    getRemoteData,
    getRemoteMeta,
    saveDictState,
    forcePushLocalDataToRemote,
    pullAllRemoteToLocal,
    getLocalCompactDataByType,
    syncData,
    clear,
  }
}

<script setup lang="ts">
import { defineAsyncComponent, nextTick, ref, watch } from 'vue'
import { useSettingStore } from '@/core/stores/setting'
import { getShortcutKey, useEventListener } from '@/core/hooks/event'
import { checkAndUpgradeSaveDict, checkAndUpgradeSaveSetting, cloneDeep, isEmpty, loadJsLib } from '@/core/utils'
import { BaseButton, BaseInput, BasePage, PopConfirm, Toast, UploadButton } from '@/base'
import { useBaseStore } from '@/core/stores/base'
import {
  APP_NAME,
  APP_VERSION,
  BACKUP_INDEX_KEY,
  DefaultShortcutKeyMap,
  LIB_JS_URL,
  LOCAL_FILE_KEY,
} from '@/core/config/env'
import { get, set } from 'idb-keyval'
import { useRuntimeStore } from '@/core/stores/runtime'
import { useExport } from '@/core/hooks/export'
import Log from '@/components/setting/Log.vue'
import About from '@/components/About.vue'
import CommonSetting from '@/components/setting/CommonSetting.vue'
import FsrsSetting from '@/components/setting/FsrsSetting.vue'
import WordSetting from '@/components/setting/WordSetting.vue'
import SoundSetting from '@/components/setting/SoundSetting.vue'
import { checkAndUpgradePracticeWordCache, PRACTICE_WORD_CACHE } from '@/core/utils/cache'
import { useDataSyncPersistence } from '@/core/composables/useDataSyncPersistence'
import SettingItem from '@/components/setting/SettingItem.vue'
import BackupGateDialog from '@/components/dialog/BackupGateDialog.vue'
import { useRoute } from 'vue-router'
import type { BackupData, Snapshot } from '@/core'

const Dialog = defineAsyncComponent(() => import('@/base/dialog/Dialog.vue'))

type HistoryBackupIndexItem = {
  hash: string
  key: string
  createdAt: number
}

type HistoryBackupMeta = HistoryBackupIndexItem & {
  previousHash?: string | null
}

let route = useRoute()
const { t } = useI18n()

// 标签页：0 通用 / 1 FSRS / 2 单词 / 3 音效 / 4 数据管理 / 5 快捷键 / 6 更新日志 / 7 关于
let tabIndex = $ref(Number(route?.query?.index ?? 0))

const settingStore = useSettingStore()
const runtimeStore = useRuntimeStore()
const store = useBaseStore()
const dataSyncPersistence = useDataSyncPersistence()

const config = useRuntimeConfig()
const gitLastCommitHash = ref(config?.public?.latestCommitHash)
const gitLastCommitTime = ref(config?.public?.latestCommitTime)

let editShortcutKey = $ref('')

const disabledDefaultKeyboardEvent = $computed(() => {
  return editShortcutKey && tabIndex === 5
})

// 监听编辑快捷键状态变化，自动聚焦输入框
watch(
  () => editShortcutKey,
  newVal => {
    if (newVal) {
      nextTick(() => {
        focusShortcutInput()
      })
    }
  }
)

useEventListener('keydown', (e: KeyboardEvent) => {
  if (!disabledDefaultKeyboardEvent) return

  e.preventDefault()
  e.stopPropagation()

  let shortcutKey = getShortcutKey(e)

  if (editShortcutKey) {
    if (shortcutKey === 'Delete') {
      settingStore.shortcutKeyMap[editShortcutKey] = ''
    } else {
      // 忽略单独的修饰键
      if (
        shortcutKey === 'Ctrl+' ||
        shortcutKey === 'Alt+' ||
        shortcutKey === 'Shift+' ||
        e.key === 'Control' ||
        e.key === 'Alt' ||
        e.key === 'Shift'
      ) {
        return
      }

      for (const [k, v] of Object.entries(settingStore.shortcutKeyMap)) {
        if (v === shortcutKey && k !== editShortcutKey) {
          settingStore.shortcutKeyMap[editShortcutKey] = DefaultShortcutKeyMap[editShortcutKey]
          return Toast.warning(t('shortcut_key_duplicate'))
        }
      }
      settingStore.shortcutKeyMap[editShortcutKey] = shortcutKey
    }
  }
})

function handleInputBlur() {
  editShortcutKey = ''
}

function focusShortcutInput() {
  const inputElements = document.querySelectorAll('.set-key input')
  if (inputElements && inputElements.length > 0) {
    const inputElement = inputElements[0] as HTMLInputElement
    inputElement.focus()
  }
}

// 快捷键中文名称映射
function getShortcutKeyName(key: string): string {
  const shortcutKeyNameMap: Record<string, string> = {
    ShowWord: t('shortcut_show_word'),
    Next: t('shortcut_next'),
    Previous: t('shortcut_previous'),
    Ignore: t('shortcut_ignore'),
    ToggleCollect: t('shortcut_toggle_collect'),
    CollectToDict: t('collect_to_dict'),
    NextChapter: t('shortcut_next_chapter'),
    PreviousChapter: t('shortcut_previous_chapter'),
    RepeatChapter: t('shortcut_repeat_chapter'),
    DictationChapter: t('shortcut_dictation_chapter'),
    PlayWordPronunciation: t('shortcut_play_word_pronunciation'),
    ToggleShowTranslate: t('shortcut_show_translate'),
    ToggleDictation: t('shortcut_toggle_dictation'),
    ToggleTheme: t('shortcut_toggle_theme'),
    RandomWrite: t('shortcut_random_write'),
    KnowWord: t('shortcut_know_word'),
    UnknownWord: t('shortcut_unknown_word'),
    ChooseA: t('shortcut_choose_a'),
    ChooseB: t('shortcut_choose_b'),
    ChooseC: t('shortcut_choose_c'),
    ChooseD: t('shortcut_choose_d'),
    WordTestingNext: '单词测试下一个',
    SelfTestingChooseA: t('shortcut_self_testing_choose_a'),
    SelfTestingChooseB: t('shortcut_self_testing_choose_b'),
    SelfTestingChooseC: t('shortcut_self_testing_choose_c'),
    SelfTestingChooseD: t('shortcut_self_testing_choose_d'),
    PlaySentence1: t('shortcut_play_sentence_1'),
    PlaySentence2: t('shortcut_play_sentence_2'),
    PlaySentence3: t('shortcut_play_sentence_3'),
    PlaySentence4: t('shortcut_play_sentence_4'),
    PlaySentence5: t('shortcut_play_sentence_5'),
    PlaySentence6: t('shortcut_play_sentence_6'),
    PlaySentence7: t('shortcut_play_sentence_7'),
    PlaySentence8: t('shortcut_play_sentence_8'),
    PlaySentence9: t('shortcut_play_sentence_9'),
  }

  return shortcutKeyNameMap[key] || key
}

function resetShortcutKeyMap() {
  editShortcutKey = ''
  settingStore.shortcutKeyMap = cloneDeep(DefaultShortcutKeyMap)
  Toast.success(t('restore_success'))
}

let importLoading = $ref(false)

const { loading: exportLoading, exportData } = useExport()

function upgradeImportedPracticeWordCache(data: BackupData['val']) {
  data[PRACTICE_WORD_CACHE.key] = checkAndUpgradePracticeWordCache(data[PRACTICE_WORD_CACHE.key], data.setting.val)
}

async function applyImportedData(data: BackupData['val']) {
  data.dict.val = await checkAndUpgradeSaveDict(data.dict)
  data.setting.val = await checkAndUpgradeSaveSetting(data.setting)
  upgradeImportedPracticeWordCache(data)

  runtimeStore.globalLoading = true
  const pushOk = await dataSyncPersistence.forcePushLocalDataToRemote(data)
  runtimeStore.globalLoading = false

  runtimeStore.isNew = APP_VERSION.version > Number(data.setting?.val?.webAppVersion ?? APP_VERSION.version)
  data.setting.val.load = true
  settingStore.setState(data.setting.val)
  data.dict.val.load = true
  store.setState(data.dict.val)
  return pushOk
}

async function importJson(str: string) {
  importLoading = true
  try {
    const obj: BackupData = JSON.parse(str)
    //老版本兼容逻辑
    if (obj.version === 4 && !isEmpty(obj.val?.[APP_VERSION.key])) {
      obj.val.setting.val.webAppVersion = obj.val[APP_VERSION.key]
    }
    const pushOk = await applyImportedData(obj.val)
    Toast.success(pushOk ? t('import_success_overwrite_remote') : t('import_success_push_failed'))
    showBackupGate = false
  } catch (err) {
    return Toast.error(t('import_failed'))
  } finally {
    importLoading = false
  }
}

async function importData(e) {
  importLoading = true
  let file = e.target.files[0]
  if (!file) return (importLoading = false)
  if (file.name.endsWith('.json')) {
    let reader = new FileReader()
    reader.onload = function (v) {
      let str: any = v.target.result
      if (str) {
        importJson(str)
      }
    }
    reader.readAsText(file)
  } else if (file.name.endsWith('.zip')) {
    try {
      const JSZip = await loadJsLib('JSZip', LIB_JS_URL.JSZIP)
      const zip = await JSZip.loadAsync(file)

      const dataFile = zip.file('data.json')
      if (!dataFile) {
        return Toast.error(t('missing_data_json'))
      }

      const mp3Folder = zip.folder('mp3')
      if (mp3Folder) {
        const records: { id: string; file: Blob }[] = []
        for (const filename in zip.files) {
          if (filename.startsWith('mp3/') && filename.endsWith('.mp3')) {
            const entry = zip.file(filename)
            if (!entry) continue
            const blob = await entry.async('blob')
            const id = filename.replace(/^mp3\//, '').replace(/\.mp3$/, '')
            records.push({ id, file: blob })
          }
        }
        await set(LOCAL_FILE_KEY, records)
      }

      const str = await dataFile.async('string')
      await importJson(str)
    } catch (e) {
      Toast.error(e?.message || e || t('import_failed'))
    } finally {
      importLoading = false
    }
  } else {
    Toast.error(t('unsupported_file_type'))
  }
  importLoading = false
}

let showBackupGate = $ref(false)
let showHistoryDialog = $ref(false)
let pendingNextAction = $ref<'import' | 'restore_history' | ''>('')
let historyBackups = $ref<HistoryBackupMeta[]>([])
let restoreTarget = $ref<HistoryBackupMeta | null>(null)
let restoreLoading = $ref(false)

function openGate(type) {
  pendingNextAction = type
  showBackupGate = true
}

async function openHistoryDialog() {
  const raw = (await get(BACKUP_INDEX_KEY)) as HistoryBackupIndexItem[] | undefined
  const index = Array.isArray(raw)
    ? raw.filter(item => item && typeof item.hash === 'string' && typeof item.key === 'string')
    : []
  const items: HistoryBackupMeta[] = []
  for (const item of index) {
    const snapshot = (await get(item.key)) as { meta?: { previousHash?: string | null } } | undefined
    items.push({
      ...item,
      previousHash: snapshot?.meta?.previousHash ?? null,
    })
  }
  historyBackups = items.sort((a, b) => b.createdAt - a.createdAt)
  showHistoryDialog = true
}

function formatHistoryTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}

function openHistoryRestoreGate(item: HistoryBackupMeta) {
  restoreTarget = item
  openGate('restore_history')
}

async function restoreHistoryData() {
  if (!restoreTarget) return
  if (restoreLoading) return
  restoreLoading = true
  try {
    const { data: val }: Snapshot = await get(restoreTarget.key)
    const data: BackupData['val'] = {
      setting: JSON.parse(val.setting),
      dict: JSON.parse(val.dict),
      [PRACTICE_WORD_CACHE.key]: JSON.parse(val[PRACTICE_WORD_CACHE.key]),
    }
    const pushOk = await applyImportedData(data)
    Toast.success(pushOk ? t('history_restore_success_overwrite_remote') : t('history_restore_success_push_failed'))
    showBackupGate = false
    showHistoryDialog = false
  } catch (error) {
    Toast.error(t('restore_failed') + ((error as Error)?.message ?? String(error)))
  } finally {
    restoreLoading = false
  }
}

async function clearAllData() {
  await dataSyncPersistence.clear()
  Toast.success(t('clear_success'))
}

function disable360() {
  let disabled = localStorage.getItem('disable360')
  if (disabled) {
    localStorage.removeItem('disable360')
    Toast.success('已清除')
  } else {
    localStorage.setItem('disable360', '1')
    Toast.success('已设置')
  }
}
</script>

<template>
  <BasePage>
    <div class="setting text-md card flex flex-col" style="height: calc(100vh - 3rem)">
      <div class="page-title text-align-center">{{ $t('setting') }}</div>
      <div class="flex flex-1 overflow-hidden gap-4">
        <div class="left">
          <div class="tabs">
            <div class="tab" :class="tabIndex === 0 && 'active'" @click="tabIndex = 0">
              <IconFluentSettings20Regular />
              <span>{{ $t('general_settings') }}</span>
            </div>
            <div class="tab" :class="tabIndex === 1 && 'active'" @click="tabIndex = 1">
              <IconFluentBot20Regular />
              <span>{{ $t('fsrs_settings') }}</span>
            </div>
            <div class="tab" :class="tabIndex === 2 && 'active'" @click="tabIndex = 2">
              <IconFluentTextUnderlineDouble20Regular />
              <span>{{ $t('word_settings') }}</span>
            </div>
            <div class="tab" :class="tabIndex === 3 && 'active'" @click="tabIndex = 3">
              <IconClarityVolumeUpLine />
              <span>{{ $t('sound_settings') }}</span>
            </div>
            <div class="tab" :class="tabIndex === 4 && 'active'" @click="tabIndex = 4">
              <IconFluentDatabasePerson20Regular />
              <span>{{ $t('data_management') }}</span>
            </div>
            <div class="tab" :class="tabIndex === 5 && 'active'" @click="tabIndex = 5">
              <IconFluentKeyboardLayoutFloat20Regular />
              <span>{{ $t('shortcut_settings') }}</span>
            </div>
            <div class="tab" :class="tabIndex === 6 && 'active'" @click="tabIndex = 6">
              <IconFluentTextBulletListSquare20Regular />
              <span>{{ $t('update_log') }}</span>
            </div>
            <div class="tab" :class="tabIndex === 7 && 'active'" @click="tabIndex = 7">
              <IconFluentPerson20Regular />
              <span>{{ $t('about') }}</span>
            </div>
          </div>
        </div>
        <div class="col-line"></div>
        <div class="flex-1 overflow-y-auto overflow-x-hidden pr-4 content">
          <CommonSetting v-if="tabIndex === 0" />
          <FsrsSetting v-if="tabIndex === 1" />
          <WordSetting v-if="tabIndex === 2" />
          <SoundSetting v-if="tabIndex === 3" />

          <div v-if="tabIndex === 4">
            <!-- 导出数据 -->
            <SettingItem
              :title="$t('export_data_title')"
              :desc="$t('data_saved_locally') + $t('export_data_desc_suffix', { appName: APP_NAME })"
            >
              <BaseButton size="large" :loading="exportLoading" @click="exportData()">{{
                $t('export_data_backup')
              }}</BaseButton>
            </SettingItem>
            <div class="text-gray text-sm">💾 {{ $t('export_zip_hint') }}</div>
            <div class="line my-3"></div>

            <!-- 导入数据 -->
            <SettingItem :title="$t('import_data_title')">
              <BaseButton size="large" @click="openGate('import')" :loading="importLoading">{{
                $t('import_data_restore')
              }}</BaseButton>
            </SettingItem>
            <i18n-t keypath="import_overwrite_warning" tag="span">
              <strong class="color-red">{{ $t('complete_overflow') }}</strong>
            </i18n-t>

            <div class="line my-3"></div>
            <SettingItem :title="$t('other')"></SettingItem>
            <div class="flex gap-space">
              <BaseButton size="large" @click="openHistoryDialog">{{ $t('history_data') }}</BaseButton>
              <PopConfirm :title="$t('clear_all_data_confirm')" @confirm="clearAllData">
                <BaseButton size="large">{{ $t('clear_all_data') }}</BaseButton>
              </PopConfirm>
              <PopConfirm
                title="不要乱点，点击后会使导出功能失效，仅适用于： Mac 版本 360 极速浏览器"
                @confirm="disable360"
              >
                <BaseButton size="large" type="info">跳过导出</BaseButton>
              </PopConfirm>
            </div>
          </div>

          <div class="body" v-if="tabIndex === 5">
            <div class="row">
              <label class="main-title">{{ $t('function') }}</label>
              <div class="wrapper">{{ $t('shortcut_key') }}</div>
            </div>
            <div class="scroll">
              <div class="row" v-for="item of Object.entries(settingStore.shortcutKeyMap)">
                <label class="item-title">{{ getShortcutKeyName(item[0]) }}</label>
                <div class="wrapper" @click="editShortcutKey = item[0]">
                  <div class="set-key" v-if="editShortcutKey === item[0]">
                    <input
                      ref="shortcutInput"
                      :value="item[1] ? item[1] : $t('no_shortcut_set')"
                      readonly
                      type="text"
                      @blur="handleInputBlur"
                    />
                    <span @click.stop="editShortcutKey = ''"
                      >{{ $t('press_key_to_set') }}，<span class="text-red!">{{
                        $t('click_here_when_done')
                      }}</span></span
                    >
                  </div>
                  <div v-else>
                    <div v-if="item[1]">{{ item[1] }}</div>
                    <span v-else>{{ $t('no_shortcut_set') }}</span>
                  </div>
                </div>
              </div>
            </div>
            <div class="row">
              <label class="item-title"></label>
              <div class="wrapper">
                <BaseButton size="large" @click="resetShortcutKeyMap">{{ $t('restore_default') }}</BaseButton>
              </div>
            </div>
          </div>

          <!-- 日志 -->
          <Log v-if="tabIndex === 6" />

          <div v-if="tabIndex === 7" class="center flex-col">
            <About />
            <div class="text-md color-gray mt-10">Build {{ gitLastCommitHash }} {{ gitLastCommitTime }}</div>
          </div>
        </div>
      </div>
    </div>
  </BasePage>

  <BackupGateDialog v-model="showBackupGate">
    <template v-slot="{ disabled }">
      <BaseButton
        v-if="pendingNextAction === 'restore_history'"
        size="large"
        @click="restoreHistoryData"
        :disabled="disabled"
        :loading="restoreLoading"
      >
        {{ $t('restore_history_data') }}
      </BaseButton>

      <UploadButton
        @change="importData"
        :disabled="disabled"
        :loading="importLoading"
        accept="application/json,.zip,application/zip"
        v-else
      >
        {{ $t('import_data_restore') }}
      </UploadButton>
    </template>
  </BackupGateDialog>

  <Dialog v-model="showHistoryDialog" :title="$t('history_data_dialog_title')">
    <div class="p-4 w-120 max-h-100 overflow-auto">
      <div v-if="!historyBackups.length" class="color-gray">{{ $t('no_history_data') }}</div>
      <div v-else class="flex flex-col gap-3">
        <div>{{ $t('history_data_desc', { appName: APP_NAME }) }}</div>
        <div v-for="(item, i) in historyBackups" :key="item.key" class="border rounded-md flex justify-between">
          <div>
            <div class="">{{ i + 1 }}{{ $t('index_version_label') }}{{ item.hash }}</div>
            <div class="color-gray">{{ $t('auto_backup_time') }}{{ formatHistoryTime(item.createdAt) }}</div>
          </div>
          <div class="mt-2">
            <BaseButton size="large" @click="openHistoryRestoreGate(item)" :disabled="restoreLoading">{{
              $t('restore_this_version')
            }}</BaseButton>
          </div>
        </div>
      </div>
    </div>
  </Dialog>
</template>

<style scoped lang="scss">
.col-line {
  border-right: 2px solid var(--color-line);
}

.setting {
  .left {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: center;

    .tabs {
      padding: 0.6rem 0;
      display: flex;
      flex-direction: column;
      gap: 0.6rem;

      .tab {
        @apply cursor-pointer flex items-center relative;
        border-radius: 0.5rem;
        @apply w-auto p-1 lg:w-40 lg:p-2;
        gap: 0.6rem;
        transition: all 0.5s;

        svg {
          @apply text-lg shrink-0;
        }

        &:hover {
          background: var(--color-fourth);
        }

        &.active {
          background: var(--color-fourth);
        }
      }
    }
  }

  .content {
    .row {
      min-height: 2.6rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: calc(var(--space) * 5);

      .wrapper {
        height: 2rem;
        flex: 1;
        display: flex;
        justify-content: flex-end;
        gap: var(--space);

        span {
          text-align: right;
          color: gray;
        }

        .set-key {
          align-items: center;

          input {
            width: 9rem;
            box-sizing: border-box;
            margin-right: 0.6rem;
            height: 1.8rem;
            outline: none;
            font-size: 1rem;
            border: 1px solid gray;
            border-radius: 0.2rem;
            padding: 0 0.3rem;
            background: var(--color-second);
            color: var(--color-font-1);
          }
        }
      }

      .main-title {
        font-size: 1.1rem;
        font-weight: bold;
      }

      .item-title {
        font-size: 1rem;
      }

      .sub-title {
        font-size: 0.9rem;
      }
    }

    .body {
      height: 100%;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .scroll {
      flex: 1;
      padding-right: 0.6rem;
      overflow: auto;
    }

    .line {
      border-bottom: 1px solid #c4c3c3;
    }
  }
}
</style>

<script setup lang="ts">
/**
 * /import — 词典 JSON 批量导入
 *
 * - 从词典详情页「导入」进入，query 携带 targetId（目标词典）
 * - 接受两种结构：Word 数组（与「导出 JSON」一致，兼容 IELTS 乱序完整版等词库 JSON）
 *   或 { words: [...] } 包裹结构
 * - 解析时只保留应用支持的字段并做类型收敛，缺 word 的条目记为无效
 * - 按 word 忽略大小写去重（文件内 + 与目标词典已有词条）
 * - 写入走 base.word.bookList，持久化由全局数据同步接管
 */
import { BaseButton, BasePage, Toast } from '@/base'
import { useBaseStore } from '@/core/stores/base.ts'
import { useRuntimeStore } from '@/core/stores/runtime.ts'
import { getDefaultDict, getDefaultWord } from '@/core/types/func.ts'
import type { Dict, Word, WordSubContent } from '@/core/types/types.ts'
import { useNav } from '@/core/utils'
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

definePageMeta({ layout: 'default' })

const base = useBaseStore()
const runtimeStore = useRuntimeStore()
const route = useRoute()
const router = useRouter()
const { nav } = useNav()

const target = ref<Dict | null>(null)
const fileRef = ref<HTMLInputElement>()
const fileName = ref('')
const parsing = ref(false)
const importing = ref(false)

const preview = ref<{ total: number; valid: number; invalid: number; words: Word[] } | null>(null)
const result = ref<{ added: number; skipped: number; failed: string[] } | null>(null)
const failedSamples = ref<string[]>([])
const skipDuplicate = ref(true)

onMounted(() => {
  const targetId = String(route.query?.targetId ?? '')
  const found = base.word.bookList.find(v => v.id === targetId)
  if (!found) {
    Toast.warning('未找到目标词典，请从词典详情页进入导入')
    router.replace('/dict-list')
    return
  }
  if (!found.custom && !found.system) {
    Toast.warning('官方词典不可直接导入，请先在词典详情页创建副本')
    router.replace('/dict-list')
    return
  }
  target.value = found
})

function pickFile() {
  fileRef.value?.click()
}

function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  fileName.value = file.name
  parsing.value = true
  preview.value = null
  result.value = null
  const reader = new FileReader()
  reader.onload = () => {
    try {
      const raw = JSON.parse(String(reader.result))
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.words) ? raw.words : null
      if (!list) {
        Toast.error('JSON 结构不识别：需要词条数组或 { words: [...] }')
        parsing.value = false
        return
      }
      const words: Word[] = []
      let invalid = 0
      for (const item of list) {
        const w = normalizeImportedWord(item)
        if (w) words.push(w)
        else invalid++
      }
      preview.value = { total: list.length, valid: words.length, invalid, words }
    } catch (err: any) {
      Toast.error('JSON 解析失败：' + (err?.message ?? '文件格式错误'))
    } finally {
      parsing.value = false
      input.value = ''
    }
  }
  reader.onerror = () => {
    Toast.error('文件读取失败')
    parsing.value = false
  }
  reader.readAsText(file, 'utf-8')
}

/** 只保留应用支持的字段，缺 word 视为无效 */
function normalizeImportedWord(raw: any): Word | null {
  const word = String(raw?.word ?? '').trim()
  if (!word) return null
  const sub = (v: any): WordSubContent | null =>
    v && (v.c ?? v.cn) ? { c: String(v.c ?? ''), cn: String(v.cn ?? '') } : null
  return getDefaultWord({
    word,
    custom: true,
    phonetic0: String(raw?.phonetic0 ?? ''),
    phonetic1: String(raw?.phonetic1 ?? raw?.phonetic0 ?? ''),
    trans: Array.isArray(raw?.trans)
      ? raw.trans.filter((v: any) => v?.cn).map((v: any) => ({ pos: String(v.pos ?? ''), cn: String(v.cn) }))
      : [],
    sentences: Array.isArray(raw?.sentences)
      ? raw.sentences.map(sub).filter(Boolean)
      : [],
    phrases: Array.isArray(raw?.phrases) ? raw.phrases.map(sub).filter(Boolean) : [],
    synos: Array.isArray(raw?.synos)
      ? raw.synos
          .filter((v: any) => v?.cn)
          .map((v: any) => ({
            pos: String(v.pos ?? ''),
            cn: String(v.cn),
            ws: Array.isArray(v.ws) ? v.ws.map(String) : [],
          }))
      : [],
    relWords: {
      root: String(raw?.relWords?.root ?? ''),
      rels: Array.isArray(raw?.relWords?.rels)
        ? raw.relWords.rels.map((r: any) => ({
            pos: String(r?.pos ?? ''),
            words: Array.isArray(r?.words) ? r.words.map(sub).filter(Boolean) : [],
          }))
        : [],
    },
    etymology: Array.isArray(raw?.etymology)
      ? raw.etymology.filter((v: any) => v?.t || v?.d).map((v: any) => ({ t: String(v.t ?? ''), d: String(v.d ?? '') }))
      : [],
  })
}

async function doImport() {
  if (importing.value || !target.value || !preview.value) return
  importing.value = true
  try {
    const existing = new Set(target.value.words.map(w => w.word.toLowerCase()))
    const seen = new Set<string>()
    const added: Word[] = []
    let skipped = 0
    const failed: string[] = []

    for (const w of preview.value.words) {
      const key = w.word.toLowerCase()
      if (skipDuplicate.value && (existing.has(key) || seen.has(key))) {
        skipped++
        continue
      }
      seen.add(key)
      existing.add(key)
      added.push(w)
    }

    if (added.length) {
      // 克隆词典配置（保留 id/名称/学习进度），仅替换 words；走 bookList 让全局同步接管持久化
      const next: Dict = getDefaultDict(target.value)
      next.words = [...target.value.words, ...added]
      next.length = next.words.length
      const idx = base.word.bookList.findIndex(v => v.id === next.id)
      if (idx > -1) base.word.bookList[idx] = next
      else base.word.bookList.push(next)
      // 同步到当前编辑上下文，供「查看词典」直接打开
      runtimeStore.editDict = next
    }

    failedSamples.value = failed.slice(0, 20)
    result.value = { added: added.length, skipped, failed: [] }
    if (added.length) Toast.success(`导入完成：新增 ${added.length} 个单词`)
    else Toast.warning('没有可导入的新单词')
  } finally {
    importing.value = false
  }
}

function viewDict() {
  if (runtimeStore.editDict.id) nav('/dict')
  else router.replace('/dict-list')
}


</script>

<template>
  <BasePage>
    <div class="max-w-170 mx-auto">
      <div class="text-2xl font-bold">导入词典 JSON</div>

      <div v-if="target" class="mt-2 text-sm" style="color: var(--color-font-3)">
        目标词典：{{ target.name }}（当前 {{ target.words.length }} 词）
      </div>

      <div class="card p-4 mt-4">
        <input
          ref="fileRef"
          type="file"
          accept=".json,application/json"
          class="hidden"
          @change="onFileChange"
        />
        <div
          class="drop-hint center flex-col gap-2 cursor-pointer"
          @click="pickFile"
        >
          <div class="text-lg">{{ fileName || '点击选择 JSON 文件' }}</div>
          <div class="text-xs" style="color: var(--color-font-3)">
            支持词条数组或 { words: [...] } 结构，字段与「导出 JSON」一致
          </div>
        </div>

        <div v-if="preview" class="mt-4 text-sm space-y-1">
          <div>解析完成：共 {{ preview.total }} 条 · 有效 {{ preview.valid }} 条 · 无效 {{ preview.invalid }} 条</div>
          <div class="flex items-center gap-2">
            <input id="skip-dup" v-model="skipDuplicate" type="checkbox" />
            <label for="skip-dup">跳过重复单词（与目标词典及文件内部重复，按单词忽略大小写）</label>
          </div>
          <BaseButton
            class="w-full mt-2"
            size="large"
            :loading="importing"
            :disabled="!preview.valid"
            @click="doImport"
          >
            开始导入
          </BaseButton>
        </div>
      </div>

      <div v-if="result" class="card p-4 mt-4">
        <div class="text-lg font-bold">导入完成</div>
        <div class="mt-2">新增 {{ result.added }} 个单词 · 跳过重复 {{ result.skipped }} 个</div>
        <ul v-if="failedSamples.length" class="mt-2 text-sm list-disc pl-6">
          <li v-for="(f, i) in failedSamples" :key="i">{{ f }}</li>
        </ul>
        <BaseButton class="mt-4" type="primary" @click="viewDict">查看词典</BaseButton>
      </div>
    </div>
  </BasePage>
</template>

<style scoped lang="scss">
.drop-hint {
  min-height: 7rem;
  border: 1px dashed var(--color-item-border, #bbb);
  border-radius: 0.6rem;
  transition: border-color 0.15s, background 0.15s;

  &:hover {
    border-color: #8b5cf6;
    background: rgba(139, 92, 246, 0.05);
  }
}
</style>

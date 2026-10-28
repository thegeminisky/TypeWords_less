<script setup lang="ts">
import { BaseButton, BaseInput, Textarea, Toast } from '@/base'
import { useBaseStore } from '@/core/stores/base'
import { useRuntimeStore } from '@/core/stores/runtime'
import { getDefaultDict, type Dict } from '@/core/types'

const props = defineProps<{
  isAdd: boolean
  initialData?: Dict | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'submit'): void
}>()

const store = useBaseStore()
const runtimeStore = useRuntimeStore()

const source = props.initialData ?? runtimeStore.editDict
const name = ref(source?.name ?? '')
const description = ref(source?.description ?? '')

function close() {
  emit('close')
}

function save() {
  const trimmedName = name.value.trim()
  if (!trimmedName) {
    Toast.warning('请输入词典名称')
    return
  }

  const duplicated = store.word.bookList.some(
    v => v.name === trimmedName && v.id !== (props.initialData ?? runtimeStore.editDict)?.id
  )
  if (duplicated) {
    Toast.warning('已存在同名词典')
    return
  }

  if (props.isAdd) {
    const dict = getDefaultDict({
      ...(source ?? {}),
      id: source?.id || `custom-dict-${Date.now()}`,
      name: trimmedName,
      description: description.value.trim(),
      custom: true,
    })
    store.changeDict(dict)
    runtimeStore.editDict = store.sdict
  } else {
    // 编辑已有自定义词典：只改元信息，不影响学习进度
    const target = runtimeStore.editDict
    target.name = trimmedName
    target.description = description.value.trim()
    runtimeStore.editDict = target
  }

  emit('submit')
}
</script>

<template>
  <div class="edit-dict w-full max-w-140">
    <div class="row">
      <span class="label">名称</span>
      <BaseInput v-model="name" size="large" placeholder="给词典起个名字" :max-length="30" />
    </div>

    <div class="row">
      <span class="label">描述</span>
      <Textarea v-model="description" placeholder="可选，简单说明这个词典" :rows="3" />
    </div>

    <div class="actions">
      <BaseButton size="large" type="info" @click="close">取消</BaseButton>
      <BaseButton size="large" @click="save">保存</BaseButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
.edit-dict {
  padding: 1rem 0.5rem;

  .row {
    display: flex;
    align-items: flex-start;
    gap: 1rem;
    margin-bottom: 1rem;

    .label {
      width: 4rem;
      flex-shrink: 0;
      padding-top: 0.4rem;
      color: var(--color-main-text);
    }

    > :last-child {
      flex: 1;
    }
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.8rem;
    margin-top: 1.5rem;
  }
}
</style>

<script setup lang="ts">
import { Switch, Textarea } from '@/base'
import SettingItem from './SettingItem.vue'
import { useSettingStore } from '@/core/stores/setting.ts'
import { useBaseStore } from '@/core/stores/base.ts'
import { ShortcutKey } from '@/core/types'

const settingStore = useSettingStore()
const store = useBaseStore()

const simpleWords = $computed({
  get: () => store.simpleWords.join(','),
  set: v => {
    try {
      store.simpleWords = v.split(',')
    } catch (e) {}
  },
})
</script>

<template>
  <div>
    <SettingItem :title="$t('ignore_case')" desc="开启后，输入时不区分大小写，如输入“hello”和“Hello”都会被认为是正确的">
      <Switch v-model="settingStore.ignoreCase" />
    </SettingItem>

    <div class="line"></div>
    <SettingItem :title="$t('simple_word_filter')" :desc="$t('simple_word_filter_desc')">
      <Switch v-model="settingStore.ignoreSimpleWord" />
    </SettingItem>

    <SettingItem :title="$t('simple_word_list')" class="items-start!" v-if="settingStore.ignoreSimpleWord">
      <Textarea
        :placeholder="$t('words_comma_separated')"
        v-model="simpleWords"
        :autosize="{ minRows: 6, maxRows: 10 }"
      />
    </SettingItem>

    <div class="line"></div>
    <SettingItem :mainTitle="`练习页按钮`" desc="练习页默认只保留单词和例句，需要哪些按钮在这里打开" />

    <SettingItem title="开关默写模式" desc="隐藏单词与例句中的目标词，凭记忆默写">
      <Switch v-model="settingStore.showBtnDictation" />
    </SettingItem>

    <SettingItem title="显示 / 隐藏释义" desc="一键切换翻译的显示状态">
      <Switch v-model="settingStore.showBtnTranslate" />
    </SettingItem>

    <SettingItem title="收藏单词">
      <Switch v-model="settingStore.showBtnCollect" />
    </SettingItem>

    <SettingItem title="收藏到词典" desc="把当前单词加入自建词典">
      <Switch v-model="settingStore.showBtnCollectToDict" />
    </SettingItem>

    <SettingItem title="跳过单词">
      <Switch v-model="settingStore.showBtnSkip" />
    </SettingItem>

    <SettingItem title="添加笔记">
      <Switch v-model="settingStore.showBtnNote" />
    </SettingItem>

    <SettingItem title="下一组" desc="练习页底部工具条上的「下一组」按钮">
      <Switch v-model="settingStore.showBtnNextGroup" />
    </SettingItem>

    <SettingItem title="随机默写" desc="练习页底部工具条上的「随机默写」按钮">
      <Switch v-model="settingStore.showBtnRandomWrite" />
    </SettingItem>
  </div>
</template>

<style scoped lang="scss"></style>

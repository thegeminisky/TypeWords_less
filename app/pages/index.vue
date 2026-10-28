<script setup lang="ts">
/**
 * 站点入口 = 门禁页
 * 原欢迎页已移除；未通过密钥校验的访问都停留在这里。
 */
import { BaseButton, BaseInput } from '@/base'
import { ensureSession, login } from '@/core/utils/remote'

definePageMeta({ layout: 'empty' })

useSeoMeta({
  title: '访问验证｜Type Words',
  robots: 'noindex, nofollow',
})

const key = ref('')
const loading = ref(false)
const error = ref('')
const shake = ref(false)
const checking = ref(true)
let cooldown = 0

onMounted(async () => {
  // 已登录过就直接进站
  if (await ensureSession()) {
    await navigateTo('/words', { replace: true })
    return
  }
  checking.value = false
})

async function submit() {
  if (loading.value) return
  if (cooldown > Date.now()) {
    error.value = '尝试过于频繁，请稍候再试'
    return
  }
  const value = key.value.trim()
  if (!value) {
    error.value = '请输入访问密钥'
    return
  }

  loading.value = true
  error.value = ''
  try {
    const ok = await login(value)
    if (ok) {
      await navigateTo('/words', { replace: true })
      return
    }
    cooldown = Date.now() + 1500
    error.value = '密钥不正确'
    shake.value = true
    setTimeout(() => (shake.value = false), 400)
  } catch {
    error.value = '无法连接服务端，请稍后重试'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="gate">
    <div class="gate-card" :class="{ shake }" :style="{ opacity: checking ? 0 : 1 }">
      <div class="brand">
        <span class="brand-main">Type</span><span class="brand-accent">Words</span>
      </div>
      <div class="hint">本站为私有部署，请输入访问密钥</div>

      <div class="field">
        <BaseInput v-model="key" type="password" size="large" autofocus placeholder="访问密钥" @enter="submit" />
      </div>

      <div class="error">{{ error }}</div>

      <BaseButton size="large" :loading="loading" class="w-full" @click="submit">进 入</BaseButton>
    </div>
  </div>
</template>

<style scoped lang="scss">
.gate {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-primary);
  background-image: radial-gradient(circle at 30% 20%, rgba(139, 92, 246, 0.13), transparent 45%),
    radial-gradient(circle at 75% 75%, rgba(59, 130, 246, 0.12), transparent 45%);
}

.gate-card {
  width: 21rem;
  padding: 2.4rem 2rem 2rem;
  border-radius: 1rem;
  background: var(--color-second);
  box-shadow: 0 12px 40px rgb(0 0 0 / 12%);
  box-sizing: border-box;
  transition: opacity 0.15s;
}

.shake {
  animation: shake 0.4s;
}

@keyframes shake {
  0%,
  100% {
    transform: translateX(0);
  }
  25% {
    transform: translateX(-7px);
  }
  50% {
    transform: translateX(6px);
  }
  75% {
    transform: translateX(-3px);
  }
}

.brand {
  text-align: center;
  font-size: 1.7rem;
  font-weight: 700;
  letter-spacing: 0.5px;

  .brand-main {
    color: #8b5cf6;
  }

  .brand-accent {
    color: #3b82f6;
    margin-left: 0.35rem;
  }
}

.hint {
  margin: 0.6rem 0 1.6rem;
  text-align: center;
  font-size: 0.85rem;
  color: var(--color-tips, #8a8a8a);
}

.field {
  margin-bottom: 0.4rem;
}

.error {
  height: 1.4rem;
  line-height: 1.4rem;
  font-size: 0.8rem;
  color: #ef4444;
  margin-bottom: 0.6rem;
}
</style>

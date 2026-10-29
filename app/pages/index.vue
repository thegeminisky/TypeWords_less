<script setup lang="ts">
/**
 * 站点入口 = 门禁页
 * 原欢迎页已移除；未通过密钥校验的访问都停留在这里。
 */
import { BaseButton, BaseInput } from '@/base'
import { ensureSession, getGateOtp, login } from '@/core/utils/remote'

definePageMeta({ layout: 'empty' })

useSeoMeta({
  title: '访问验证｜Type Words',
  robots: 'noindex, nofollow',
})

const otp = ref('')
const revealOtp = ref('')
const copied = ref(false)
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
  // 首次部署 / 命令行重置后，服务端会把 OTP 明文返回一次
  try {
    const gate = await getGateOtp()
    revealOtp.value = gate?.otp ?? ''
  } catch {
    /* 服务端不可达时只展示输入框 */
  }
  checking.value = false
})

async function copyOtp() {
  if (!revealOtp.value) return
  try {
    await navigator.clipboard.writeText(revealOtp.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    error.value = '复制失败，请手动记录'
  }
}

async function submit() {
  if (loading.value) return
  if (cooldown > Date.now()) {
    error.value = '尝试过于频繁，请稍候再试'
    return
  }
  const value = otp.value.trim()
  if (!value) {
    error.value = '请输入 OTP 访问码'
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
    error.value = 'OTP 不正确'
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
      <template v-if="revealOtp">
        <div class="otp-reveal">
          <div class="otp-title">本次部署的 OTP 访问码</div>
          <button class="otp-code" type="button" @click="copyOtp">{{ revealOtp }}</button>
          <div class="otp-tip">{{ copied ? '已复制到剪贴板' : '点击复制，仅展示这一次，请立即保存' }}</div>
        </div>
        <div class="hint">输入上方 OTP 码完成首次登录，之后该码不再显示</div>
      </template>
      <div v-else class="hint">本站为私有部署，请输入 OTP 访问码</div>

      <div class="field">
        <BaseInput v-model="otp" size="large" autofocus placeholder="OTP 访问码" @enter="submit" />
      </div>

      <div class="error">{{ error }}</div>

      <BaseButton size="large" :loading="loading" class="w-full" @click="submit">进 入</BaseButton>

      <div class="reset-tip">忘记 OTP？需在服务器命令行执行 node server.mjs reset-otp 重置</div>
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

.otp-reveal {
  margin: 0.6rem 0 1.2rem;
  padding: 1rem 0.8rem;
  border-radius: 0.6rem;
  border: 1px dashed rgba(139, 92, 246, 0.55);
  background: rgba(139, 92, 246, 0.08);
  text-align: center;

  .otp-title {
    font-size: 0.8rem;
    color: var(--color-tips, #8a8a8a);
    margin-bottom: 0.5rem;
  }

  .otp-code {
    font-family: var(--en-article-family, monospace);
    font-size: 1.8rem;
    font-weight: 700;
    letter-spacing: 0.35rem;
    color: #8b5cf6;
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 0 0.35rem 0 0.35rem;

    &:hover {
      opacity: 0.85;
    }
  }

  .otp-tip {
    margin-top: 0.5rem;
    font-size: 0.72rem;
    color: var(--color-tips, #8a8a8a);
  }
}

.reset-tip {
  margin-top: 1.2rem;
  text-align: center;
  font-size: 0.68rem;
  color: var(--color-tips, #8a8a8a);
  opacity: 0.7;
}
</style>

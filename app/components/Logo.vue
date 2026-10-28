<script setup lang="ts">
import { useRouter } from 'vue-router'

const router = useRouter()

function goHome() {
  router.push('/words')
}
</script>

<template>
  <div class="logo center" title="Type Words" @click="goHome">
    <span class="mark">TW</span>
  </div>
</template>

<style scoped lang="scss">
.logo {
  display: inline-flex;
  align-items: center;
}

.mark {
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.2rem;
  height: 2.2rem;
  border-radius: 0.6rem;
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  color: #fff;
  background: linear-gradient(135deg, #8b5cf6 0%, #3b82f6 100%);
  user-select: none;
  transition: transform 0.2s;

  &:hover {
    transform: scale(1.06);
  }
}
</style>

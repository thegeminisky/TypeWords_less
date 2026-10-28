import { ensureSession } from '@/core/utils/remote'

/**
 * 全局门禁守卫
 * 站点入口 `/` 就是门禁页，其余路由未通过密钥校验一律送回 `/`。
 * 服务端渲染（构建期预渲染）时跳过，避免把静态产物定型成跳转页。
 */
export default defineNuxtRouteMiddleware(async to => {
  if (import.meta.server) return

  // 门禁页本身放行
  if (to.path === '/') return

  const ok = await ensureSession()
  if (!ok) {
    return navigateTo('/', { replace: true })
  }
})

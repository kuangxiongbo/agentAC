/**
 * 与 `/api/auth/callback` 等价的浏览器回调入口（推荐在 Zitadel 登记此路径，避免部分环境下对 `/api/*` 的客户端 fetch 干扰）。
 * 段配置（如 `dynamic`）须在本文件字面量导出，不可从其它 route 再导出（Next / Turbopack 静态解析要求）。
 */
export const dynamic = 'force-dynamic'

export { GET } from '@/app/api/auth/callback/route'

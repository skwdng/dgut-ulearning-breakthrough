/**
 * 多租户配置 —— 由「当前站点」派生（**不再写死东莞理工**）。
 *
 * ══════════════ ★★★ 改造说明（2026-10）══════════════
 *
 * 用户需求：
 *   「现在有一个优学院走的中国站点不是东莞理工站点的，怎么改」
 *   「我的意思是直接在上面加一个中国站点的登陆方式」
 *
 * 原先这里：
 *   · `TENANTS` 只有一项 `dgut`
 *   · 域名全部来自 `BUILD_CONFIG.hosts`（写死的 dgut 域名）
 *   → 换句话说「多租户」只是**结构上留了位置**，实际只支持一所学校。
 *
 * 现在：
 *   · 站点定义搬进 `src/config/sites.ts`（含域名、API 模式、登录入口）
 *   · 这里根据**用户当前选的站点**（`getCurrentSite()`）实时派生 TenantConfig
 *   · 于是登录页、cookie 回写、CAS 都能跟着走
 *
 * ⚠️ 为什么保留这一层而不是直接用 SiteConfig：
 *    登录页/绑定页用的是 `schoolName` / `entryUrl` / `casServicePath` 这套词，
 *    改成 SiteConfig 会牵连更多文件。派生一层最省事，语义也更贴"一台设备一个租户"。
 */
import { getCurrentSite } from './currentSite';
import type { SiteConfig } from './sites';

export interface TenantConfig {
  code: string;
  schoolName: string;
  /** 优学院本体（LMS） */
  lmsHost: string;
  /** 应用中心（信任中介，DGUT 必需；全国站没有） */
  appHost?: string;
  /**
   * 中央认证（CAS）。
   * ⚠️ **可选** —— 优学院全国站是普通账号密码登录，没有 CAS。
   */
  authHost?: string;
  /** 应用中心 CAS 回调地址（用作 service 参数）；没有 CAS 时为空串 */
  casServicePath: string;
  /** 学生入口（绑定页 WebView 打开它） */
  entryUrl: string;
}

/** 由 SiteConfig 派生 TenantConfig */
export function tenantOfSite(site: SiteConfig): TenantConfig {
  return {
    code: site.code,
    schoolName: site.label,
    lmsHost: site.services.lms,
    appHost: site.appHost,
    authHost: site.services.auth,
    casServicePath: site.casServicePath ?? '',
    entryUrl: site.portalUrl,
  };
}

/**
 * 取租户配置。
 *
 * ⚠️ 参数保留是为了兼容旧调用（`getTenant(account?.tenant ?? ...)`）。
 *    但**实际返回的永远是"当前站点"的配置** —— 因为一台手机上
 *    同时只可能登录一个优学院站点，而站点是全局设置。
 *
 *    如果传入的 code 与当前站点不一致，说明账号是旧站点登录的：
 *    这时仍按当前站点返回，并让上层（登录页）去处理"需要重新登录"。
 */
export function getTenant(code?: string): TenantConfig {
  const site = getCurrentSite();
  /**
   * 传了 code 且与当前站点不同 → 仍然按当前站点给。
   * 调用方拿到的 lmsHost 才是**真实可用的**，比返回一个不存在的域名好。
   */
  void code;
  return tenantOfSite(site);
}

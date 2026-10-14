/**
 * 多租户配置。
 * 优学院是 SaaS：每所学校的优学院域名、认证域名、入口都不同，
 * 所以这里必须是配置而不是常量（tech-spec §2.1）。
 */
import { BUILD_CONFIG } from './buildConfig';

export interface TenantConfig {
  code: string;
  schoolName: string;
  /** 优学院本体（LMS） */
  lmsHost: string;
  /** 应用中心（信任中介，DGUT 必需） */
  appHost?: string;
  /** 中央认证（CAS） */
  authHost: string;
  /** 应用中心 CAS 回调地址（用作 service 参数） */
  casServicePath: string;
  /** 学生入口（绑定页 WebView 打开它） */
  entryUrl: string;
}

const env = {
  lms: BUILD_CONFIG.hosts.lms,
  app: BUILD_CONFIG.hosts.app,
  auth: BUILD_CONFIG.hosts.auth,
};

export const TENANTS: Record<string, TenantConfig> = {
  dgut: {
    code: 'dgut',
    schoolName: '东莞理工学院',
    lmsHost: env.lms,
    appHost: env.app,
    authHost: env.auth,
    casServicePath: '/appapi/cas/fromcas',
    entryUrl: env.app,
  },
};

export function getTenant(code: string): TenantConfig {
  const t = TENANTS[code];
  if (!t) throw new Error(`未知租户：${code}（需在 src/config/tenants.ts 中新增配置）`);
  return t;
}

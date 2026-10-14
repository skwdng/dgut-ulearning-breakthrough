/**
 * 适配器解析器。
 *
 * ⚠️ 不再用 `process.env.EXPO_PUBLIC_YOUXUE_ADAPTER` ——
 * 实测在 release 构建里它不会被内联，运行时退化成 undefined，
 * 于是永远走 mock 分支（假数据），而且毫无报错。
 * 现在改为读 src/config/buildConfig.ts 里的**源码常量**。
 */
import type { TenantCode } from '../../domain/types';
import { BUILD_CONFIG, type AdapterKind } from '../../config/buildConfig';
import { MockCheckinAdapter } from './mockAdapter';
import { YouxueCheckinAdapter } from './youxueAdapter';
import type { CheckinAdapter } from './types';

export type { AdapterKind };

export function currentAdapterKind(): AdapterKind {
  return BUILD_CONFIG.adapter;
}

export function resolveTenant(): TenantCode {
  return BUILD_CONFIG.tenant as TenantCode;
}

let cached: CheckinAdapter | null = null;

export function getAdapter(): CheckinAdapter {
  if (cached) return cached;
  const tenant = resolveTenant();
  cached = currentAdapterKind() === 'youxue' ? new YouxueCheckinAdapter(tenant) : new MockCheckinAdapter(tenant);
  return cached;
}

/** 测试/演示辅助：拿到 mock 实例（非 mock 模式返回 null） */
export function getMockAdapter(): MockCheckinAdapter | null {
  const a = getAdapter();
  return a instanceof MockCheckinAdapter ? a : null;
}

export { MockCheckinAdapter, YouxueCheckinAdapter };
export type { CheckinAdapter };

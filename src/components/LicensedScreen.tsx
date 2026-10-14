import React from 'react';
import { LicenseGate } from './LicenseGate';
import { useUnlock } from '../state/unlockStore';

/**
 * 授权闸门：未授权时拦住功能页，显示**填授权码**的界面。
 *
 * ══════════════ ★★★ 判定依据换过一次（重要，别再改回去）══════════════
 *
 * 原先是 `useLicense().licensed` —— 那套要拉一个**远程授权名单**
 * （`EXPO_PUBLIC_LICENSE_URL` + LicenseManifest）。而本项目：
 *   · 用的是**授权码**机制（LK1-... 那种，本地校验 + 服务端确认）
 *   · 服务端没有名单接口
 *   · 名单地址也没配
 * 所以 `licensed` 永远是 false —— **不管有没有授权码都用不了**。
 * 用户看到的就是「暂时无法校验 / 名单条目：未获取 / 不可用」。
 *
 * 现在改成 `useUnlock().entitled`，那才是真正在跑的那套：
 *   entitled = unlocked（本地授权码校验通过）
 *           && serverAuth !== 'denied'（服务端没明确拒绝）
 *
 * ⚠️ 注意 `serverAuth === 'unknown'`（连不上服务器）时是**放行**的 ——
 *    这是刻意的降级策略：不能因为服务器挂着就把已授权的用户关在门外。
 *    见 unlockStore 里"降级策略"那段注释。
 */
export function LicensedScreen({ children }: { children: React.ReactNode }) {
  const { entitled } = useUnlock();
  if (!entitled) return <LicenseGate />;
  return <>{children}</>;
}

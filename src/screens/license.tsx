/**
 * 由 app/license.tsx 迁移而来（tools/migrate-screens.cjs）。
 * 已移除 expo-router 依赖 —— 见 src/nav/router.tsx 的说明。
 */
import React from 'react';
import { LicenseGate } from '../components/LicenseGate';

/** 授权页：未授权时展示状态与开通指引；已授权时展示可用能力 */
export function LicenseScreen() {
  return <LicenseGate />;
}

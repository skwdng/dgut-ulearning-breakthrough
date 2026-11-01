/**
 * 「当前站点」的运行时状态 —— 让用户**不重装**就能切换优学院站点。
 *
 * ══════════════ 为什么需要运行时状态，而不是构建常量 ══════════════
 *
 * 用户需求：「现在有一个优学院走的中国站点不是东莞理工站点的，怎么改」
 *
 * 如果站点写死在构建常量里，那么：
 *   · 东莞理工的同学要一个包
 *   · 中国站的同学要另一个包
 *   → 得打两个 APK，而且用户自己换不了
 *
 * 所以改成：**一个包，设置里选站点**。
 *
 * ══════════════ 为什么用模块级变量而不是 React state ══════════════
 *
 * 用它的地方大多是**服务层**（`signApi` / `webCookie` / `http`），
 * 那些是普通类/函数，不是组件，拿不到 React context。
 * 所以这里做一份模块级快照，React 那边通过 store 触发重新渲染。
 *
 * ⚠️ 读它必须是**同步**的（服务层不能 await）——
 *    所以启动时由 `loadCurrentSite()` 一次性灌进来。
 */
import { store } from '../services/storage';
import { STORE_KEYS } from '../services/storage';
import {
  DEFAULT_SITE_CODE,
  getSiteConfig,
  type SiteConfig,
  type SiteServices,
} from './sites';

/**
 * 当前站点。
 *
 * ⚠️ 初值是**打包默认站点**（东莞理工）——
 *    在 `loadCurrentSite()` 跑完之前，服务层也必须能正常工作
 *    （否则启动早期任何请求都会炸）。
 */
let current: SiteConfig = getSiteConfig(DEFAULT_SITE_CODE);

/** 同步读当前站点（服务层用这个） */
export function getCurrentSite(): SiteConfig {
  return current;
}

/** 同步设当前站点（**不落盘**，仅供 load 时用；界面请用 store 的 actions） */
export function setCurrentSiteInMemory(code: string): SiteConfig {
  current = getSiteConfig(code);
  return current;
}

/** 存储形状 */
export interface StoredSiteChoice {
  code: string;
  savedAt: number;
}

/**
 * 启动时调用：把用户选过的站点读出来。
 *
 * ⚠️ 失败不抛错 —— 读不到就用默认站点。
 *    站点读不出来不该让整个 App 起不来。
 */
export async function loadCurrentSite(): Promise<SiteConfig> {
  try {
    const v = await store.get<StoredSiteChoice | null>(STORE_KEYS.youxueSite, null);
    if (v?.code) {
      current = getSiteConfig(v.code);
    }
  } catch {
    /* 读不到就沿用默认 */
  }
  return current;
}

/** 切换站点并落盘（成功后立刻对所有服务生效） */
export async function saveCurrentSite(code: string): Promise<SiteConfig> {
  const next = getSiteConfig(code);
  current = next;
  await store.set<StoredSiteChoice>(STORE_KEYS.youxueSite, {
    code: next.code,
    savedAt: Date.now(),
  });
  return next;
}

/**
 * 便捷：某个服务的基址。
 * ⚠️ 只在**确实需要整个 base** 时用；拼具体接口请用 `resolvePath`。
 */
export function serviceBase(key: keyof SiteServices): string {
  const v = current.services[key];
  return typeof v === 'string' ? v : '';
}

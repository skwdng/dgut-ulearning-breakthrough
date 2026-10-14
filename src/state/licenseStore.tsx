/**
 * 授权（白名单）状态管理。
 *
 * 职责：
 * - 拉取并缓存远程名单（离线时用缓存，超过 TTL 则要求联网）
 * - 用已绑定的学号校验授权状态
 * - 记录使用日志（谁、什么时候、做了什么）
 *
 * 名单地址从 `EXPO_PUBLIC_LICENSE_URL` 读取（.env 配置），改名单不用重新打包。
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  CACHE_TTL_MS,
  evaluateLicense,
  fetchManifest,
  isLicensed,
  verifyManifestShape,
  type LicenseEntry,
  type LicenseManifest,
  type LicenseState,
  type LicenseStatus,
} from '../domain/license';
import { store, STORE_KEYS } from '../services/storage';
import { useCheckin } from './checkinStore';

/** 使用日志条目 */
export interface UsageLogItem {
  at: number;
  studentId: string;
  action: 'license-check' | 'checkin' | 'manual-checkin' | 'unbind' | 'screen-open';
  detail?: string;
  ok: boolean;
}

interface State {
  ready: boolean;
  manifest: LicenseManifest | null;
  fetchedAt?: number;
  /** 本地缓存的校验结果 */
  license: LicenseState;
  logs: UsageLogItem[];
  checking: boolean;
}

const initialState: State = {
  ready: false,
  manifest: null,
  license: { status: 'unknown' },
  logs: [],
  checking: false,
};

type Action =
  | { type: 'HYDRATE'; payload: Partial<State> }
  | { type: 'SET_MANIFEST'; manifest: LicenseManifest | null; fetchedAt?: number }
  | { type: 'SET_LICENSE'; license: LicenseState }
  | { type: 'SET_CHECKING'; checking: boolean }
  | { type: 'LOG'; item: UsageLogItem }
  | { type: 'CLEAR_LOGS' };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'HYDRATE':
      return { ...state, ...action.payload, ready: true };
    case 'SET_MANIFEST':
      return { ...state, manifest: action.manifest, fetchedAt: action.fetchedAt ?? state.fetchedAt };
    case 'SET_LICENSE':
      return { ...state, license: action.license };
    case 'SET_CHECKING':
      return { ...state, checking: action.checking };
    case 'LOG': {
      const logs = [action.item, ...state.logs];
      return { ...state, logs: logs.slice(0, 300) };
    }
    case 'CLEAR_LOGS':
      return { ...state, logs: [] };
    default:
      return state;
  }
}

export interface LicenseActions {
  /** 拉取名单并重新校验（按钮触发 / 启动触发） */
  refresh(): Promise<LicenseState>;
  /** 只重新校验（不联网） */
  revalidate(): LicenseState;
  log(action: UsageLogItem['action'], detail?: string, ok?: boolean): void;
  clearLogs(): void;
}

const Ctx = createContext<
  (State & { licensed: boolean; entry?: LicenseEntry; actions: LicenseActions }) | null
>(null);

function envLicenseUrl(): string {
  return (process.env.EXPO_PUBLIC_LICENSE_URL ?? '').trim();
}

export function LicenseProvider({ children }: { children: React.ReactNode }) {
  const { account } = useCheckin();
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const studentId = account?.studentId;

  // ---------- 读取缓存 ----------
  useEffect(() => {
    (async () => {
      const [manifest, fetchedAt, logs, cachedLicense] = await Promise.all([
        store.get<LicenseManifest | null>(STORE_KEYS.licenseManifest, null),
        store.get<number>(STORE_KEYS.licenseFetchedAt, 0),
        store.get<UsageLogItem[]>(STORE_KEYS.usageLogs, []),
        store.get<LicenseState | null>(STORE_KEYS.licenseState, null),
      ]);
      dispatch({
        type: 'HYDRATE',
        payload: {
          manifest,
          fetchedAt: fetchedAt || undefined,
          logs,
          license: cachedLicense ?? { status: 'unknown' },
        },
      });
    })();
  }, []);

  // ---------- 持久化 ----------
  useEffect(() => {
    if (!state.ready) return;
    store.set(STORE_KEYS.licenseManifest, state.manifest);
    store.set(STORE_KEYS.licenseFetchedAt, state.fetchedAt ?? 0);
    store.set(STORE_KEYS.licenseState, state.license);
    store.set(STORE_KEYS.usageLogs, state.logs);
  }, [state.ready, state.manifest, state.fetchedAt, state.license, state.logs]);

  const log = useCallback<LicenseActions['log']>((action, detail, ok = true) => {
    dispatch({
      type: 'LOG',
      item: {
        at: Date.now(),
        studentId: stateRef.current.license.entry?.studentId ?? '',
        action,
        detail,
        ok,
      },
    });
  }, []);

  // ---------- 校验 ----------
  const revalidate = useCallback((): LicenseState => {
    const s = stateRef.current;
    const stale = Boolean(s.fetchedAt && Date.now() - s.fetchedAt > CACHE_TTL_MS);
    const next = evaluateLicense({
      manifest: s.manifest,
      studentId,
      cacheStale: stale,
      // 开发模式且未配置名单地址时旁路，方便本地调试
      devBypass: __DEV__ && !envLicenseUrl() && !s.manifest,
    });
    dispatch({ type: 'SET_LICENSE', license: next });
    return next;
  }, [studentId]);

  const refresh = useCallback(async (): Promise<LicenseState> => {
    const url = envLicenseUrl();
    dispatch({ type: 'SET_CHECKING', checking: true });
    try {
      if (!url) {
        // 没配名单地址：只在开发模式旁路，否则视为未授权
        const next = evaluateLicense({
          manifest: stateRef.current.manifest,
          studentId,
          devBypass: __DEV__,
        });
        dispatch({ type: 'SET_LICENSE', license: next });
        log('license-check', '未配置名单地址', isLicensed(next));
        return next;
      }

      const manifest = await fetchManifest(url);
      if (manifest) {
        const shape = verifyManifestShape(manifest);
        if (!shape.ok) {
          const bad: LicenseState = { status: 'invalid', checkedAt: Date.now(), message: shape.reason };
          dispatch({ type: 'SET_LICENSE', license: bad });
          log('license-check', `名单格式异常：${shape.reason}`, false);
          return bad;
        }
        dispatch({ type: 'SET_MANIFEST', manifest, fetchedAt: Date.now() });
        const next = evaluateLicense({ manifest, studentId });
        dispatch({ type: 'SET_LICENSE', license: next });
        log('license-check', `名单 v${manifest.version}，共 ${manifest.entries.length} 条`, isLicensed(next));
        return next;
      }

      // 拉取失败 → 用缓存（并按 TTL 判断是否过期）
      const stale = Boolean(stateRef.current.fetchedAt && Date.now() - stateRef.current.fetchedAt > CACHE_TTL_MS);
      const next = evaluateLicense({ manifest: stateRef.current.manifest, studentId, cacheStale: stale });
      dispatch({ type: 'SET_LICENSE', license: next });
      log('license-check', '拉取名单失败，使用缓存', isLicensed(next));
      return next;
    } finally {
      dispatch({ type: 'SET_CHECKING', checking: false });
    }
  }, [studentId, log]);

  // 绑定账号变化时自动重新校验
  useEffect(() => {
    if (!state.ready) return;
    revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.ready, studentId, state.manifest]);

  const licensed = isLicensed(state.license);

  const actions = useMemo<LicenseActions>(
    () => ({ refresh, revalidate, log, clearLogs: () => dispatch({ type: 'CLEAR_LOGS' }) }),
    [refresh, revalidate, log],
  );

  const value = useMemo(
    () => ({ ...state, licensed, entry: state.license.entry, actions }),
    [state, licensed, actions],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLicense() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useLicense 必须在 LicenseProvider 内使用');
  return ctx;
}

/** 给模块系统用的简化视图：签到模块是否解锁 */
export function useCheckinUnlocked(): { unlocked: boolean; status: LicenseStatus; message?: string } {
  const { licensed, license } = useLicense();
  return { unlocked: licensed, status: license.status, message: license.message };
}

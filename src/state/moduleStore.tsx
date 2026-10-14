/**
 * 功能模块（插件）配置。
 *
 * 三件事：
 * 1. 持久化用户的启用/停用选择
 * 2. 记录已授予的能力（通知/相机/定位/通知使用权）
 * 3. 对外暴露"当前该显示哪些模块"的计算结果
 *
 * 关键规则：**用户选择优先于平台能力**（见 modules.ts 的 computeModuleRuntime）
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  computeAllModules,
  currentPlatform,
  type GrantedPerms,
  type LicenseChecker,
  type ModuleRuntime,
  type PermKey,
  type PlatformKey,
} from '../domain/modules';
import { store, STORE_KEYS } from '../services/storage';

interface ModuleConfig {
  /** 用户主动开启的（优先于平台能力） */
  enabled: string[];
  /** 用户主动关闭的 */
  disabled: string[];
  granted: GrantedPerms;
}

const DEFAULT_CFG: ModuleConfig = { enabled: [], disabled: [], granted: {} };

interface State extends ModuleConfig {
  ready: boolean;
  platform: PlatformKey;
}

type Action =
  | { type: 'HYDRATE'; cfg: ModuleConfig }
  | { type: 'ENABLE'; key: string }
  | { type: 'DISABLE'; key: string }
  | { type: 'RESET'; key: string }
  | { type: 'GRANT'; perm: PermKey; value: boolean };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'HYDRATE':
      return { ...state, ...action.cfg, ready: true };
    case 'ENABLE': {
      // 注意：平台不支持的模块也允许开启 —— 这是"用户选择优先于平台能力"的落实，
      // UI 会把它标成"不可用"并给出原因，而不是偷偷替用户决定。
      return {
        ...state,
        enabled: [...new Set([...state.enabled, action.key])],
        disabled: state.disabled.filter((k) => k !== action.key),
      };
    }
    case 'DISABLE':
      return {
        ...state,
        disabled: [...new Set([...state.disabled, action.key])],
        enabled: state.enabled.filter((k) => k !== action.key),
      };
    case 'RESET':
      return {
        ...state,
        enabled: state.enabled.filter((k) => k !== action.key),
        disabled: state.disabled.filter((k) => k !== action.key),
      };
    case 'GRANT':
      return { ...state, granted: { ...state.granted, [action.perm]: action.value } };
    default:
      return state;
  }
}

export interface ModuleActions {
  enable(key: string): void;
  disable(key: string): void;
  /** 恢复默认（清除用户选择） */
  reset(key: string): void;
  setGranted(perm: PermKey, value: boolean): void;
  /** 从系统查询实际权限状态并同步进来 */
  refreshPermissions(): Promise<void>;
}

const Ctx = createContext<(State & { runtimes: ModuleRuntime[]; visible: ModuleRuntime[]; actions: ModuleActions }) | null>(null);

export function ModuleProvider({
  children,
  /** 授权校验器：由外层（LicenseProvider）注入，避免循环依赖 */
  checkLicense,
}: {
  children: React.ReactNode;
  checkLicense?: LicenseChecker;
}) {
  const [state, dispatch] = useReducer(reducer, {
    ...DEFAULT_CFG,
    ready: false,
    platform: currentPlatform(),
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    (async () => {
      const cfg = await store.get<ModuleConfig>(STORE_KEYS.moduleConfig, DEFAULT_CFG);
      dispatch({
        type: 'HYDRATE',
        cfg: {
          enabled: cfg.enabled ?? [],
          disabled: cfg.disabled ?? [],
          granted: cfg.granted ?? {},
        },
      });
    })();
  }, []);

  useEffect(() => {
    if (!state.ready) return;
    store.set(STORE_KEYS.moduleConfig, {
      enabled: state.enabled,
      disabled: state.disabled,
      granted: state.granted,
    });
  }, [state.ready, state.enabled, state.disabled, state.granted]);

  // ---------- 计算 ----------
  const runtimes = useMemo(
    () =>
      computeAllModules(
        { enabled: state.enabled, disabled: state.disabled },
        state.granted,
        state.platform,
        checkLicense,
      ),
    [state.enabled, state.disabled, state.granted, state.platform, checkLicense],
  );

  const visible = useMemo(() => runtimes.filter((r) => r.visible), [runtimes]);

  const actions = useMemo<ModuleActions>(
    () => ({
      enable(key) {
        dispatch({ type: 'ENABLE', key });
      },
      disable(key) {
        dispatch({ type: 'DISABLE', key });
      },
      reset(key) {
        dispatch({ type: 'RESET', key });
      },
      setGranted(perm, value) {
        dispatch({ type: 'GRANT', perm, value });
      },
      async refreshPermissions() {
        // 通知 / 相机 / 定位：查系统实际状态；通知使用权由原生模块查
        try {
          const Notifications = require('expo-notifications') as typeof import('expo-notifications');
          const p = await Notifications.getPermissionsAsync();
          dispatch({ type: 'GRANT', perm: 'notification', value: p.status === 'granted' });
        } catch { /* 模块不可用时忽略 */ }
        try {
          const { Camera } = require('expo-camera') as typeof import('expo-camera');
          const p = await Camera.getCameraPermissionsAsync();
          dispatch({ type: 'GRANT', perm: 'camera', value: p.status === 'granted' });
        } catch { /* ignore */ }
        try {
          const Location = require('expo-location') as typeof import('expo-location');
          const p = await Location.getForegroundPermissionsAsync();
          dispatch({ type: 'GRANT', perm: 'location', value: p.status === 'granted' });
        } catch { /* ignore */ }
        try {
          const { DeliveryBridge } = require('../services/delivery/bridge') as typeof import('../services/delivery/bridge');
          const ok = await DeliveryBridge.isListeningEnabled();
          dispatch({ type: 'GRANT', perm: 'notificationAccess', value: ok });
        } catch { /* ignore */ }
      },
    }),
    [],
  );

  const value = useMemo(
    () => ({ ...state, runtimes, visible, actions }),
    [state, runtimes, visible, actions],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useModules() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useModules 必须在 ModuleProvider 内使用');
  return ctx;
}

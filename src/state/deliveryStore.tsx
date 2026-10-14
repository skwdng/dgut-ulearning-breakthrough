/**
 * 外卖记录的状态管理。
 *
 * 职责：
 * - 接收原生通知监听推来的通知（可能发生在 App 未打开时 → 先落"待处理队列"）
 * - 用解析引擎抽店名，用指纹去重，把同一订单的多条通知归并成一条
 * - 计算按店铺聚合的统计（用户的核心需求：某家店点过几次）
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  PLATFORM_META,
  STAGE_RANK,
  type DeliveryOrder,
  type DeliveryPlatform,
  type DeliveryStage,
  type DeliveryStats,
  type StoreStat,
} from '../domain/delivery';
import { fingerprint, mergeNotification, parseDeliveryNotification } from '../services/delivery/parser';
import { DeliveryBridge } from '../services/delivery/bridge';
import { store, STORE_KEYS } from '../services/storage';

/** 原生通知监听在 App 未打开时写入的原始通知 */
export interface RawNotification {
  pkg: string;
  title: string;
  text: string;
  at: number;
}

interface State {
  ready: boolean;
  orders: DeliveryOrder[];
  /** 未处理完的原始通知（App 冷启动时补处理） */
  pending: RawNotification[];
  /** 解析失败/低置信度的通知，供用户确认 */
  uncertain: RawNotification[];
  listening: boolean;
  lastEventAt?: number;
}

const initialState: State = { ready: false, orders: [], pending: [], uncertain: [], listening: false };

type Action =
  | { type: 'HYDRATE'; payload: Partial<State> }
  | { type: 'ADD_ORDER'; order: DeliveryOrder }
  | { type: 'UPDATE_ORDER'; id: string; patch: Partial<DeliveryOrder> }
  | { type: 'DELETE_ORDER'; id: string }
  | { type: 'SET_PENDING'; pending: RawNotification[] }
  | { type: 'SET_UNCERTAIN'; uncertain: RawNotification[] }
  | { type: 'SET_LISTENING'; listening: boolean }
  | { type: 'MARK_EVENT' };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'HYDRATE':
      return { ...state, ...action.payload, ready: true };
    case 'ADD_ORDER':
      return { ...state, orders: [action.order, ...state.orders] };
    case 'UPDATE_ORDER':
      return { ...state, orders: state.orders.map((o) => (o.id === action.id ? { ...o, ...action.patch } : o)) };
    case 'DELETE_ORDER':
      return { ...state, orders: state.orders.filter((o) => o.id !== action.id) };
    case 'SET_PENDING':
      return { ...state, pending: action.pending };
    case 'SET_UNCERTAIN':
      return { ...state, uncertain: action.uncertain };
    case 'SET_LISTENING':
      return { ...state, listening: action.listening };
    case 'MARK_EVENT':
      return { ...state, lastEventAt: Date.now() };
    default:
      return state;
  }
}

export interface DeliveryActions {
  /** 原生推来的通知（App 内实时） */
  ingestNotifications(items: RawNotification[]): void;
  /** 手动补录 */
  addManual(input: { platform: DeliveryPlatform; storeName: string; amount?: number }): void;
  updateOrder(id: string, patch: Partial<DeliveryOrder>): void;
  deleteOrder(id: string): void;
  /** 把待确认的通知按用户修正后入库 */
  confirmUncertain(index: number, storeName: string): void;
  dismissUncertain(index: number): void;
  setListening(v: boolean): void;
}

const Ctx = createContext<(State & { stats: DeliveryStats; actions: DeliveryActions }) | null>(null);

export function DeliveryProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  // ---------- 读取 ----------
  useEffect(() => {
    (async () => {
      const [orders, pending, uncertain, meta] = await Promise.all([
        store.get<DeliveryOrder[]>(STORE_KEYS.deliveryOrders, []),
        store.get<RawNotification[]>(STORE_KEYS.deliveryPending, []),
        store.get<RawNotification[]>(STORE_KEYS.deliveryUncertain, []),
        store.get<{ listening: boolean }>(STORE_KEYS.deliveryMeta, { listening: false }),
      ]);
      dispatch({ type: 'HYDRATE', payload: { orders, pending, uncertain, listening: meta.listening } });
    })();
  }, []);

  // ---------- 持久化 ----------
  useEffect(() => {
    if (!state.ready) return;
    store.set(STORE_KEYS.deliveryOrders, state.orders);
    store.set(STORE_KEYS.deliveryPending, state.pending);
    store.set(STORE_KEYS.deliveryUncertain, state.uncertain);
    store.set(STORE_KEYS.deliveryMeta, { listening: state.listening });
  }, [state.ready, state.orders, state.pending, state.uncertain, state.listening]);

  /**
   * 核心：把一批原始通知变成订单记录。
   * 规则：
   * - 解析成功且 high 置信 → 入库（同指纹则合并阶段/金额）
   * - 解析成功但 low 置信（没店名/没阶段没金额）→ 进待确认
   * - 解析失败（营销通知等）→ 直接丢弃
   */
  const ingestNotifications = useCallback((items: RawNotification[]) => {
    if (items.length === 0) return;
    const current = stateRef.current;
    const orders = [...current.orders];
    const uncertain = [...current.uncertain];

    for (const raw of items) {
      const parsed = parseDeliveryNotification({ pkg: raw.pkg, title: raw.title, text: raw.text });
      if (!parsed) continue; // 营销/无关通知

      if (parsed.confidence === 'low' || !parsed.storeName) {
        // 去重后再进待确认，避免同一通知重复堆叠
        const dup = uncertain.some(
          (u) => u.pkg === raw.pkg && u.title === raw.title && Math.abs(u.at - raw.at) < 60_000,
        );
        if (!dup) uncertain.unshift(raw);
        continue;
      }

      const fp = fingerprint(parsed.platform, parsed.storeName, raw.at);
      const idx = orders.findIndex((o) => o.fingerprint === fp);
      if (idx >= 0) {
        // 同一订单的后续通知：合并阶段与金额
        const merged = mergeNotification(
          { stage: orders[idx].stage, amount: orders[idx].amount, at: orders[idx].at },
          { stage: parsed.stage, amount: parsed.amount, at: raw.at },
        );
        orders[idx] = {
          ...orders[idx],
          stage: merged.stage,
          amount: merged.amount,
          rawTitle: raw.title,
          rawText: raw.text,
        };
      } else {
        orders.unshift({
          id: `d-${raw.at}-${Math.random().toString(36).slice(2, 8)}`,
          platform: parsed.platform,
          pkg: raw.pkg,
          storeName: parsed.storeName,
          amount: parsed.amount,
          stage: parsed.stage,
          at: raw.at,
          source: 'notify',
          fingerprint: fp,
          rawTitle: raw.title,
          rawText: raw.text,
        });
      }
    }

    // 按指纹去重一次（防御性）
    const seen = new Set<string>();
    const deduped = orders.filter((o) => {
      if (seen.has(o.fingerprint)) return false;
      seen.add(o.fingerprint);
      return true;
    });

    dispatch({ type: 'HYDRATE', payload: { orders: deduped, uncertain } });
    dispatch({ type: 'MARK_EVENT' });
  }, []);

  // 冷启动：把原生在后台攒的通知补处理
  useEffect(() => {
    if (!state.ready || state.pending.length === 0) return;
    ingestNotifications(state.pending);
    dispatch({ type: 'SET_PENDING', pending: [] });
  }, [state.ready, state.pending, ingestNotifications]);

  // App 运行期间：订阅原生通知事件（Android 专属，其他平台为 noop）
  useEffect(() => {
    const off = DeliveryBridge.subscribe((items) => {
      ingestNotifications(items);
    });
    // 同时读一次后台攒下的（防止订阅期间漏掉）
    void (async () => {
      const drained = await DeliveryBridge.drainPending();
      if (drained.length) ingestNotifications(drained);
      const enabled = await DeliveryBridge.isListeningEnabled();
      if (enabled) dispatch({ type: 'SET_LISTENING', listening: true });
    })();
    return off;
  }, [ingestNotifications]);

  // ---------- 统计 ----------
  const stats = useMemo<DeliveryStats>(() => computeStats(state.orders), [state.orders]);

  const actions = useMemo<DeliveryActions>(
    () => ({
      ingestNotifications,

      addManual({ platform, storeName, amount }) {
        const at = Date.now();
        const name = storeName.trim();
        if (!name) return;
        const fp = fingerprint(platform, name, at);
        const existing = stateRef.current.orders.find((o) => o.fingerprint === fp);
        if (existing) {
          dispatch({ type: 'UPDATE_ORDER', id: existing.id, patch: { amount: amount ?? existing.amount } });
          return;
        }
        dispatch({
          type: 'ADD_ORDER',
          order: {
            id: `m-${at}-${Math.random().toString(36).slice(2, 8)}`,
            platform,
            pkg: PLATFORM_META[platform].pkg[0] ?? '',
            storeName: name,
            amount,
            stage: 'paid',
            at,
            source: 'manual',
            fingerprint: fp,
          },
        });
      },

      updateOrder(id, patch) {
        dispatch({ type: 'UPDATE_ORDER', id, patch });
      },

      deleteOrder(id) {
        dispatch({ type: 'DELETE_ORDER', id });
      },

      confirmUncertain(index, storeName) {
        const list = stateRef.current.uncertain;
        const raw = list[index];
        if (!raw || !storeName.trim()) return;
        const parsed = parseDeliveryNotification({ pkg: raw.pkg, title: raw.title, text: raw.text });
        const platform = parsed?.platform ?? 'other';
        const at = raw.at;
        dispatch({
          type: 'ADD_ORDER',
          order: {
            id: `u-${at}-${Math.random().toString(36).slice(2, 8)}`,
            platform,
            pkg: raw.pkg,
            storeName: storeName.trim(),
            amount: parsed?.amount,
            stage: parsed?.stage ?? 'unknown',
            at,
            source: 'notify',
            fingerprint: fingerprint(platform, storeName.trim(), at),
            rawTitle: raw.title,
            rawText: raw.text,
          },
        });
        dispatch({ type: 'SET_UNCERTAIN', uncertain: list.filter((_, i) => i !== index) });
      },

      dismissUncertain(index) {
        dispatch({ type: 'SET_UNCERTAIN', uncertain: stateRef.current.uncertain.filter((_, i) => i !== index) });
      },

      setListening(v) {
        dispatch({ type: 'SET_LISTENING', listening: v });
      },
    }),
    [ingestNotifications],
  );

  const value = useMemo(() => ({ ...state, stats, actions }), [state, stats, actions]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDelivery() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useDelivery 必须在 DeliveryProvider 内使用');
  return ctx;
}

// ---------------- 统计计算 ----------------

/** 已取消的订单不计入"点过几次" */
const COUNTABLE: DeliveryStage[] = ['created', 'paid', 'delivering', 'done', 'unknown'];

export function computeStats(orders: DeliveryOrder[]): DeliveryStats {
  const countable = orders.filter((o) => COUNTABLE.includes(o.stage));

  const byStore = new Map<string, StoreStat>();
  for (const o of countable) {
    const key = o.storeName;
    const prev = byStore.get(key);
    if (prev) {
      prev.count += 1;
      prev.totalAmount += o.amount ?? 0;
      prev.lastAt = Math.max(prev.lastAt, o.at);
      if (!prev.platforms.includes(o.platform)) prev.platforms.push(o.platform);
    } else {
      byStore.set(key, {
        storeName: key,
        count: 1,
        platforms: [o.platform],
        lastAt: o.at,
        totalAmount: o.amount ?? 0,
      });
    }
  }

  const topStores = [...byStore.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);

  const byPlatformMap = new Map<DeliveryPlatform, number>();
  for (const o of countable) byPlatformMap.set(o.platform, (byPlatformMap.get(o.platform) ?? 0) + 1);

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  return {
    total: countable.length,
    storeCount: byStore.size,
    byPlatform: [...byPlatformMap.entries()]
      .map(([platform, count]) => ({ platform, count }))
      .sort((a, b) => b.count - a.count),
    topStores,
    monthCount: countable.filter((o) => o.at >= monthStart).length,
    lastOrderAt: countable.length ? Math.max(...countable.map((o) => o.at)) : undefined,
  };
}

export { STAGE_RANK };

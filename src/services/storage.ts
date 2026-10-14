/**
 * 本地存储。
 *
 * 安全约定（tech-spec §3.4）：
 * - Cookie / 密码 一律只进 SecureStore（iOS Keychain / Android Keystore）；
 * - 业务数据（课程、任务、设置）进普通文件存储；
 * - 任何地方都不打印凭据。
 */
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system';

const DATA_DIR = `${FileSystem.documentDirectory}lifekit`;
const CRED_PREFIX = 'lifekit.cred.';

/** 记下最近一次存储故障，供诊断页显示 */
export const storageFaults: string[] = [];
function fault(msg: string) {
  storageFaults.unshift(`[${new Date().toLocaleTimeString()}] ${msg}`);
  if (storageFaults.length > 20) storageFaults.pop();
  console.warn('[storage]', msg);
}

/**
 * 确保目录存在。
 *
 * ⚠️ 踩过的坑：原实现是 `FileSystem.makeDirectoryAsync(...)` 不 await，
 * 竞态下首次写入可能发生在目录建好之前 —— 而写入失败又是静默的，
 * 于是出现"明明存了却读不到"。这里改成 await。
 */
async function ensureDir(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(DATA_DIR);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(DATA_DIR, { intermediates: true });
    }
  } catch (e) {
    fault(`建目录失败: ${(e as Error).message}`);
  }
}

/** 普通 JSON 存储（同步读缓存 + 异步落盘，避免页面闪烁） */
const cache = new Map<string, unknown>();

export const store = {
  async get<T>(key: string, fallback: T): Promise<T> {
    if (cache.has(key)) return cache.get(key) as T;
    await ensureDir();
    try {
      const path = `${DATA_DIR}/${key}.json`;
      const info = await FileSystem.getInfoAsync(path);
      if (!info.exists) {
        cache.set(key, fallback);
        return fallback;
      }
      const raw = await FileSystem.readAsStringAsync(path);
      const parsed = JSON.parse(raw) as T;
      cache.set(key, parsed);
      return parsed;
    } catch (e) {
      // 不再静默：记下来，诊断页能看到
      fault(`读取 ${key} 失败: ${(e as Error).message}`);
      cache.set(key, fallback);
      return fallback;
    }
  },

  getSync<T>(key: string, fallback: T): T {
    return (cache.get(key) as T) ?? fallback;
  },

  /**
   * 列出磁盘上**所有已保存的 key**（按前缀过滤可选）。
   *
   * 为什么需要：store 是按确定性 key 读写的，没有"枚举"能力，
   * 于是"到底存了几个账号的凭据"这类问题只能靠猜。
   * 换账号串数据的排查就卡在这里 —— 加上它，诊断页能直接把全部账号列出来。
   */
  async listKeys(prefix?: string): Promise<string[]> {
    await ensureDir();
    try {
      const names = await FileSystem.readDirectoryAsync(DATA_DIR);
      const keys = names
        .filter((n) => n.endsWith('.json'))
        .map((n) => n.slice(0, -'.json'.length))
        // 防御：真实文件里可能有子目录/临时文件
        .filter((k) => !k.includes('/') && !k.includes('\\'));
      const out = prefix ? keys.filter((k) => k.startsWith(prefix)) : keys;
      return out.sort();
    } catch (e) {
      fault(`列出存储 key 失败: ${(e as Error).message}`);
      return [];
    }
  },

  async set<T>(key: string, value: T): Promise<void> {
    cache.set(key, value);
    await ensureDir();
    try {
      await FileSystem.writeAsStringAsync(`${DATA_DIR}/${key}.json`, JSON.stringify(value));
    } catch (e) {
      fault(`写入 ${key} 失败: ${(e as Error).message}`);
    }
  },

  /**
   * 写入并**读回校验**。
   *
   * 为什么需要：凭据写入若静默失败，用户看到的是"明明绑定了却说没绑定"，
   * 而错误发生在很久之后、完全对不上因果。这里当场验证并把结果返回，
   * 让绑定流程能立刻报出真实原因。
   */
  async setVerified<T>(key: string, value: T): Promise<{ ok: boolean; error?: string }> {
    await store.set(key, value);
    try {
      const path = `${DATA_DIR}/${key}.json`;
      const info = await FileSystem.getInfoAsync(path);
      if (!info.exists) return { ok: false, error: `写入后文件不存在（${key}）` };
      const raw = await FileSystem.readAsStringAsync(path);
      const back = JSON.parse(raw) as T;
      if (JSON.stringify(back) !== JSON.stringify(value)) {
        return { ok: false, error: `写入内容与预期不一致（${key}）` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `校验失败: ${(e as Error).message}` };
    }
  },

  async remove(key: string): Promise<void> {
    cache.delete(key);
    try {
      await FileSystem.deleteAsync(`${DATA_DIR}/${key}.json`, { idempotent: true });
    } catch {
      /* ignore */
    }
  },
};

/** 凭据存储（敏感） */
export const secureStore = {
  async setSecret(ref: string, payload: unknown): Promise<void> {
    const value = JSON.stringify(payload);
    if (Platform.OS === 'web') {
      // Web 端 SecureStore 不可用，仅用于本地调试
      globalThis.localStorage?.setItem(CRED_PREFIX + ref, value);
      return;
    }
    await SecureStore.setItemAsync(CRED_PREFIX + ref, value, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  },

  async getSecret<T>(ref: string): Promise<T | null> {
    try {
      const value =
        Platform.OS === 'web'
          ? globalThis.localStorage?.getItem(CRED_PREFIX + ref) ?? null
          : await SecureStore.getItemAsync(CRED_PREFIX + ref);
      return value ? (JSON.parse(value) as T) : null;
    } catch {
      return null;
    }
  },

  async removeSecret(ref: string): Promise<void> {
    if (Platform.OS === 'web') {
      globalThis.localStorage?.removeItem(CRED_PREFIX + ref);
      return;
    }
    await SecureStore.deleteItemAsync(CRED_PREFIX + ref);
  },
};

export const STORE_KEYS = {
  account: 'account',
  /**
   * ★ 「上次启动有没有走完」的标记（services/startupGuard.ts 用）。
   *
   * ⚠️ 为什么需要它：崩溃日志只能抓 JS 层异常，
   *    而 ANR（JS 线程阻塞被系统杀掉）**走不到 JS 层、一条日志都没有**。
   *    靠这个标记才能知道"上次启动异常结束"，以及连续发生了几次。
   */
  startupMark: 'startupMark',
  courses: 'courses',
  tasks: 'tasks',
  /**
   * 历史记录。
   *
   * ⚠️ 与 courses / tasks 一样，实际写盘时 key 会带上账号 id
   *    （形如 `history.dgut-2099000000116`），避免换账号后串数据。
   *    见 checkinStore 的持久化读写。
   */
  history: 'history',
  pollPlan: 'pollPlan',
  submitCounter: 'submitCounter',
  settings: 'settings',
  // ---- 外卖记录 ----
  deliveryOrders: 'deliveryOrders',
  /** 原生通知监听在 App 未打开时攒下的原始通知 */
  deliveryPending: 'deliveryPending',
  /** 解析置信度低、需要用户确认的通知 */
  deliveryUncertain: 'deliveryUncertain',
  deliveryMeta: 'deliveryMeta',
  // ---- 功能模块（插件）配置 ----
  moduleConfig: 'moduleConfig',
  // ---- 授权（白名单） ----
  licenseManifest: 'licenseManifest',
  licenseFetchedAt: 'licenseFetchedAt',
  licenseState: 'licenseState',
  usageLogs: 'usageLogs',
  // ---- 签到模块总览缓存 ----
  signOverview: 'signOverview',
  // ---- 插件解锁码（一人一码） ----
  unlockCode: 'unlockCode',
  // ---- 天气缓存 ----
  weather: 'weather',
  // ---- 崩溃日志 ----
  crashLog: 'crashLog',
  // ---- 首页背景照片 ----
  homePhoto: 'homePhoto',
  // ---- 手动选择的天气城市（鸿蒙无 GMS 定位，靠它） ----
  weatherCity: 'weatherCity',
  // ---- 管理服务端地址（局域网，用于万能码与用户上报） ----
  serverBase: 'serverBase',
  // ---- 待补发的上报（服务器没开时先存本地） ----
  pendingReports: 'pendingReports',
  /**
   * 已关掉「更新弹窗」的那个版本号（versionCode）。
   *
   * ⚠️ 存的是**版本号**而不是一个布尔值 ——
   *    只记"关过了"的话，用户关掉 0.17 的弹窗后，
   *    发了 0.18 他就再也看不到弹窗，会漏掉更新。
   */
  updatePromptDismissed: 'updatePromptDismissed',
} as const;

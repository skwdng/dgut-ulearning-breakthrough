/**
 * 天气服务 —— 用 Open-Meteo（免费、免注册、支持 CORS）。
 *
 * ⚠️ 定位在鸿蒙上**不可用**。
 *    实测报错：`LocationServices.API is not available on this device`
 *    —— 鸿蒙没有实现 Google 定位服务（GMS），而 expo-location 依赖它。
 *    所以**不能依赖 GPS**。
 *
 * 现在的策略：
 *   ① 用户手动选城市（默认路径，一定可用）
 *   ② 如果系统定位恰好可用，也允许走定位（真机适配后可能可用）
 *
 * 失败时返回 failure 说明原因，首页据此给提示。
 */
import * as Location from 'expo-location';
import { store, STORE_KEYS } from './storage';
import { logFault } from './crashLog';
import { findCity } from '../data/chinaCities';

export interface WeatherNow {
  /** 摄氏温度 */
  temperature: number;
  /** 体感温度 */
  feelsLike?: number;
  /** WMO 天气代码 */
  code: number;
  /** 中文描述 */
  label: string;
  /** 对应的 emoji */
  icon: string;
  /** 最高 / 最低 */
  high?: number;
  low?: number;
  /** 城市名 */
  city?: string;
  /** 数据时间 */
  at: number;
}

/** 内置城市表见 src/data/chinaCities.ts（按省份分组，覆盖主要地级市） */

/** WMO Weather interpretation codes → 中文 + emoji */
const WMO: Record<number, { label: string; icon: string }> = {
  0: { label: '晴', icon: '☀️' },
  1: { label: '大部晴朗', icon: '🌤️' },
  2: { label: '多云', icon: '⛅' },
  3: { label: '阴', icon: '☁️' },
  45: { label: '有雾', icon: '🌫️' },
  48: { label: '雾凇', icon: '🌫️' },
  51: { label: '小毛毛雨', icon: '🌦️' },
  53: { label: '毛毛雨', icon: '🌦️' },
  55: { label: '大毛毛雨', icon: '🌦️' },
  56: { label: '冻毛毛雨', icon: '🌧️' },
  57: { label: '强冻毛毛雨', icon: '🌧️' },
  61: { label: '小雨', icon: '🌧️' },
  63: { label: '中雨', icon: '🌧️' },
  65: { label: '大雨', icon: '🌧️' },
  66: { label: '冻雨', icon: '🌧️' },
  67: { label: '强冻雨', icon: '🌧️' },
  71: { label: '小雪', icon: '🌨️' },
  73: { label: '中雪', icon: '🌨️' },
  75: { label: '大雪', icon: '❄️' },
  77: { label: '雪粒', icon: '🌨️' },
  80: { label: '阵雨', icon: '🌦️' },
  81: { label: '强阵雨', icon: '🌧️' },
  82: { label: '暴雨', icon: '⛈️' },
  85: { label: '阵雪', icon: '🌨️' },
  86: { label: '强阵雪', icon: '❄️' },
  95: { label: '雷阵雨', icon: '⛈️' },
  96: { label: '雷阵雨伴冰雹', icon: '⛈️' },
  99: { label: '强雷暴伴冰雹', icon: '⛈️' },
};

export function describeWmo(code: number): { label: string; icon: string } {
  return WMO[code] ?? { label: '未知', icon: '🌡️' };
}

/**
 * 取天气的失败原因。
 *
 * ⚠️ 之前所有失败都返回 null，首页只能显示一句"天气未获取"，
 * 用户完全不知道是**权限没给**、**定位不可用**还是**网络不通**。
 */
export type WeatherFailure =
  | { kind: 'permission'; message: string }
  | { kind: 'location'; message: string }
  | { kind: 'network'; message: string }
  | { kind: 'unknown'; message: string };

export interface WeatherResult {
  data: WeatherNow | null;
  failure?: WeatherFailure;
}

interface Cached {
  at: number;
  data: WeatherNow;
}

/** 缓存有效期 30 分钟 */
const TTL = 30 * 60 * 1000;

/** 用户手动选的城市（存下来，下次直接用） */
export async function getSavedCity(): Promise<string | null> {
  return store.get<string | null>(STORE_KEYS.weatherCity, null);
}

export async function setSavedCity(name: string | null): Promise<void> {
  await store.set(STORE_KEYS.weatherCity, name);
  // 换城市要清掉旧缓存，否则还显示上一个城市的天气
  await store.set(STORE_KEYS.weather, null);
}

/** 真正的查询：给定经纬度和城市名，拿天气 */
async function queryWeather(
  lat: number,
  lon: number,
  city: string | undefined,
): Promise<WeatherResult> {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,apparent_temperature,weather_code` +
      `&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`;
    const res = await fetch(url);
    if (!res.ok) {
      return { data: null, failure: { kind: 'network', message: `天气服务返回 HTTP ${res.status}` } };
    }
    const j = (await res.json()) as {
      current?: { temperature_2m?: number; apparent_temperature?: number; weather_code?: number };
      daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] };
    };
    const temp = j.current?.temperature_2m;
    const code = j.current?.weather_code;
    if (typeof temp !== 'number' || typeof code !== 'number') {
      return { data: null, failure: { kind: 'network', message: '天气服务返回的数据不完整' } };
    }

    const meta = describeWmo(code);
    const data: WeatherNow = {
      temperature: Math.round(temp),
      feelsLike:
        typeof j.current?.apparent_temperature === 'number'
          ? Math.round(j.current.apparent_temperature)
          : undefined,
      code,
      label: meta.label,
      icon: meta.icon,
      high:
        j.daily?.temperature_2m_max?.[0] !== undefined
          ? Math.round(j.daily.temperature_2m_max[0])
          : undefined,
      low:
        j.daily?.temperature_2m_min?.[0] !== undefined
          ? Math.round(j.daily.temperature_2m_min[0])
          : undefined,
      city,
      at: Date.now(),
    };

    await store.set(STORE_KEYS.weather, { at: Date.now(), data } satisfies Cached);
    return { data };
  } catch (e) {
    return { data: null, failure: { kind: 'network', message: `取天气失败：${(e as Error).message}` } };
  }
}

/**
 * 取天气。
 *
 * 顺序：
 *   1. 缓存（30 分钟内直接用）
 *   2. **手动选的城市**（有就用它 —— 这是鸿蒙上的主路径）
 *   3. 系统定位（鸿蒙上会失败，失败就提示去选手动城市）
 */
export async function fetchWeatherEx(opts: { force?: boolean } = {}): Promise<WeatherResult> {
  if (!opts.force) {
    const cached = await store.get<Cached | null>(STORE_KEYS.weather, null);
    if (cached && Date.now() - cached.at < TTL) return { data: cached.data };
  }

  // ── 2) 手动选的城市优先 ──
  const manual = await store.get<string | null>(STORE_KEYS.weatherCity, null);
  if (manual) {
    const c = findCity(manual);
    if (c) return queryWeather(c.lat, c.lon, c.name);
  }

  // ── 3) 系统定位（鸿蒙上会失败，把原因如实带回去）──
  let lat: number | undefined;
  let lon: number | undefined;
  let city: string | undefined;
  let locationFailure: WeatherFailure | undefined;
  try {
    let perm = await Location.getForegroundPermissionsAsync();
    if (perm.status !== 'granted') {
      perm = await Location.requestForegroundPermissionsAsync();
    }
    if (perm.status !== 'granted') {
      locationFailure = {
        kind: 'permission',
        message: '没有定位权限。可以直接在上面选一个城市，不依赖定位。',
      };
    } else {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low });
      lat = pos.coords.latitude;
      lon = pos.coords.longitude;
      try {
        const geo = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lon });
        const g = geo[0];
        city = g?.city ?? g?.region ?? g?.district ?? undefined;
      } catch {
        /* 拿不到城市名不影响天气 */
      }
    }
  } catch (e) {
    /**
     * ⚠️ 2026-10 改动：原来这里把**原生错误的原文**截 80 字符显示给用户：
     *      「这台设备用不了系统定位（Location request has been rejected: 17:
     *        API: LocationServices.API is not available on this devi…）」
     *    真机上看到的就是这一长串英文 —— 用户完全看不懂，
     *    而这种情况**恰恰是国产机的常态**（没装 Google 服务）。
     *
     *    现在：只说人话 + 明确告诉他"选城市不受影响"。
     *    技术细节仍写进崩溃日志，需要排查时查得到。
     */
    logFault(`[天气] 系统定位不可用：${(e as Error).message}`, 'weather.location');
    locationFailure = {
      kind: 'location',
      message:
        '这台设备的系统定位用不了（常见原因：手机没有 Google 服务，或定位总开关关着）。' +
        '直接在上面选一个城市就行 —— 手动选的城市不依赖定位。',
    };
  }

  if (lat === undefined || lon === undefined) {
    return {
      data: null,
      failure:
        locationFailure ?? { kind: 'unknown', message: '拿不到位置，请手动选一个城市。' },
    };
  }

  const r = await queryWeather(lat, lon, city);
  // 定位成功但网络失败时，把网络原因带出去
  return r;
}

/** 兼容旧调用：只要数据 */
export async function fetchWeather(opts: { force?: boolean } = {}): Promise<WeatherNow | null> {
  const r = await fetchWeatherEx(opts);
  return r.data;
}

/** 问候语（按当前小时） */
export function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 5) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 13) return '中午好';
  if (h < 18) return '下午好';
  if (h < 23) return '晚上好';
  return '夜深了';
}

/** 格式化日期：2026年10月8日 星期三 */
export function formatFullDate(now = new Date()): string {
  const wd = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()];
  return `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${wd}`;
}

/** 农历/节日之类的简单占位，后续可扩展 */
export function dayHint(now = new Date()): string | null {
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const fixed: Record<string, string> = {
    '1-1': '元旦',
    '5-1': '劳动节',
    '10-1': '国庆节',
    '12-25': '圣诞节',
  };
  return fixed[`${m}-${d}`] ?? null;
}

/**
 * 定位的**容错封装**（2026-10 新增）。
 *
 * ══════════════ ⚠️ 为什么需要这一层（真机实测踩到的）══════════════
 *
 * 用户实测（华为/荣耀类无 GMS 手机）报：
 *
 *     Location request has been rejected: 17: API:
 *     LocationServices.API is not available on this device.
 *     ConnectionResult{statusCode=SERVICE_INVALID, resolution=null}
 *
 * 根因：**`expo-location` 在 Android 上走的是 Google Play 服务（GMS）的
 *      FusedLocationProvider**。手机没装 GMS（国产机基本都没有）时，
 *      这个 API 直接不可用 —— 而且它抛的是**原生异常**，
 *      不是返回一个"没权限"的状态码。
 *
 * ⚠️ 也就是说：**你不能靠 `perm.status !== 'granted'` 来判断"能不能定位"**。
 *    没 GMS 的机器上，`requestForegroundPermissionsAsync()` 这个调用**本身就抛**。
 *    所以凡是"先要权限、再取位置"的代码，**必须整段包 try/catch**，
 *    否则一个"要不要给定位权限"的小动作就能把整页搞成报错页。
 *
 * ══════════════ 设计原则：定位失败**不是**致命错误 ══════════════
 *
 * 这个 App 里定位只是**辅助**：
 *   · 地图选点 —— 拿不到当前定位就退到学校坐标，用户手动拖，**完全可用**
 *   · 位置签到 —— 有预设圈就不需要定位（这正是那个功能的价值）
 *
 * 所以这里的所有函数都**不抛异常**，失败返回 `null` / `'unavailable'`，
 * 让调用方安静降级，而不是弹一堆用户看不懂的原生错误。
 */
import * as Location from 'expo-location';

/** 定位能力的三种状态 */
export type GeoAvailability =
  /** 有权限、能用 */
  | 'ok'
  /** 用户拒绝了权限（可以去设置里开） */
  | 'denied'
  /**
   * ⚠️ 设备不支持 —— 没装 GMS、或系统定位服务关着。
   *    这种情况**引导用户去开权限是没用的**，得换提示话术。
   */
  | 'unavailable';

/**
 * 问一次"能不能定位"。
 *
 * ⚠️ **绝不抛异常** —— 原生层不可用时返回 `'unavailable'`。
 *    这是这个模块存在的唯一理由。
 */
export async function probeLocation(): Promise<GeoAvailability> {
  try {
    const perm = await Location.getForegroundPermissionsAsync();
    if (perm.status === 'granted') return 'ok';
    if (perm.canAskAgain === false) return 'denied';
    const asked = await Location.requestForegroundPermissionsAsync();
    if (asked.status === 'granted') return 'ok';
    return asked.canAskAgain === false ? 'denied' : 'denied';
  } catch {
    /**
     * ⚠️ 走到这里基本就是"没 GMS"。
     *    注意**不能**据此判断用户拒绝了权限 —— 那是两回事。
     */
    return 'unavailable';
  }
}

/**
 * 取当前位置。失败返回 `null`（不抛）。
 *
 * @param accuracy 默认 Balanced —— 只是给地图当起点用，不需要高精度，
 *                 高精度更慢更费电。
 */
export async function tryGetCurrentPosition(
  accuracy: Location.Accuracy = Location.Accuracy.Balanced,
): Promise<{ latitude: number; longitude: number; accuracy: number | null } | null> {
  try {
    const pos = await Location.getCurrentPositionAsync({ accuracy });
    return {
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      accuracy: pos.coords.accuracy ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * 取"最后已知位置"（更快，不触发定位）。
 *
 * ⚠️ 它比 `getCurrentPositionAsync` 更容易成功：只是读系统缓存。
 *    用来做"参考信息"（比如告诉用户"你离圈心多远"）很合适 ——
 *    拿不到也不影响主流程。
 */
export async function tryGetLastKnownPosition(): Promise<{
  latitude: number;
  longitude: number;
} | null> {
  try {
    const pos = await Location.getLastKnownPositionAsync();
    if (!pos) return null;
    return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
  } catch {
    return null;
  }
}

/**
 * 把状态翻译成**给用户看的一句话**（含该怎么做）。
 *
 * ⚠️ 三种情况的"该怎么做"完全不同：
 *   · denied      → 去系统设置里开权限
 *   · unavailable → 开权限也没用（设备不支持），请他手动拖地图/手动填坐标
 *   · ok 但取不到 → 可能是室内没信号，让他到窗边或稍后再试
 */
export function describeGeoFailure(state: GeoAvailability | 'failed'): string {
  switch (state) {
    case 'denied':
      return '没有定位权限。可以到系统设置里给本应用开启定位，或手动拖动地图选点。';
    case 'unavailable':
      return (
        '这台设备的定位服务不可用（常见原因：手机没有 Google 服务，' +
        '或系统定位总开关关着）。\n不影响使用 —— 手动拖动地图把准星对准位置即可。'
      );
    default:
      return '暂时取不到当前位置（可能在室内或信号弱）。可以手动拖动地图选点。';
  }
}

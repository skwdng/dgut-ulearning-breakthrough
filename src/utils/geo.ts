/**
 * 地理计算工具（无第三方依赖）。
 *
 * 用途：定位签到需要
 * 1) 判断当前位置是否在教师设定的签到范围内；
 * 2) 在范围内自动挑一个合法的提交点（而不是无脑用中心点，避免"每次都同一个坐标"的机器特征）。
 */

const EARTH_RADIUS_M = 6371008.8;

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface Circle extends LatLng {
  radius: number;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Haversine 距离（米） */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 经纬度偏移换算（1 度纬度 ≈ 111320m；经度按纬度收缩） */
export function metersToLatLng(origin: LatLng, dxMeters: number, dyMeters: number): LatLng {
  const dLat = dyMeters / 111320;
  const dLng = dxMeters / (111320 * Math.cos(toRad(origin.latitude)) || 1);
  return { latitude: origin.latitude + dLat, longitude: origin.longitude + dLng };
}

export function isInside(point: LatLng, circle: Circle): boolean {
  return distanceMeters(point, circle) <= circle.radius;
}

/** 在圆内均匀取一点（面积均匀，不是半径均匀）：r = R * sqrt(u) */
export function randomPointInCircle(circle: Circle): LatLng {
  const u = Math.random();
  const r = circle.radius * Math.sqrt(u) * 0.75; // 留 25% 余量，避免贴边被判定失败
  const theta = Math.random() * 2 * Math.PI;
  return metersToLatLng(circle, r * Math.cos(theta), r * Math.sin(theta));
}

/** 在圆内取离"目标点"最近的合法位置（超出范围时用） */
export function nearestPointInside(target: LatLng, circle: Circle): LatLng {
  const d = distanceMeters(target, circle);
  if (d <= circle.radius) return target;
  // 沿圆心→目标方向，退回到半径的 80% 处
  const ratio = (circle.radius * 0.8) / d;
  const dLat = target.latitude - circle.latitude;
  const dLng = target.longitude - circle.longitude;
  return {
    latitude: circle.latitude + dLat * ratio,
    longitude: circle.longitude + dLng * ratio,
  };
}

/** 人类可读的距离 */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)}m`;
  return `${(meters / 1000).toFixed(2)}km`;
}

/**
 * 根据"地址名"或坐标，生成一个默认签到范围。
 * 真实实现应改为从签到详情接口读取教师设定的中心点与半径（tech-spec §11 P0 待验证项）。
 */
export function defaultCircleFor(courseLocation?: { latitude: number; longitude: number; address?: string; radius?: number }): Circle | null {
  if (!courseLocation) return null;
  return {
    latitude: courseLocation.latitude,
    longitude: courseLocation.longitude,
    radius: courseLocation.radius ?? 120,
  };
}

/** 在圆形范围内随机取点（用于"帮我在范围内选一个点"） */
export function pickInsideWithJitter(circle: Circle): LatLng {
  return randomPointInCircle(circle);
}

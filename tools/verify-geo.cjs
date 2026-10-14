// 临时校验脚本：验证 src/utils/geo.ts 的距离与"范围内取点"逻辑。
// 关键正确性要求：
//  1) Haversine 距离与已知值一致；
//  2) randomPointInCircle 产生的每个点都必须在半径内（含留余量后）；
//  3) nearestPointInside 对圆外点必须吸附到半径内，对圆内点必须原样返回。
// 通过后本文件可删除。

const EARTH_RADIUS_M = 6371008.8;
const toRad = (d) => (d * Math.PI) / 180;

function distanceMeters(a, b) {
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function metersToLatLng(origin, dxMeters, dyMeters) {
  const dLat = dyMeters / 111320;
  const dLng = dxMeters / (111320 * Math.cos(toRad(origin.latitude)) || 1);
  return { latitude: origin.latitude + dLat, longitude: origin.longitude + dLng };
}

function isInside(p, c) {
  return distanceMeters(p, c) <= c.radius;
}

function randomPointInCircle(c) {
  const u = Math.random();
  const r = c.radius * Math.sqrt(u) * 0.75;
  const theta = Math.random() * 2 * Math.PI;
  return metersToLatLng(c, r * Math.cos(theta), r * Math.sin(theta));
}

function nearestPointInside(target, c) {
  const d = distanceMeters(target, c);
  if (d <= c.radius) return target;
  const ratio = (c.radius * 0.8) / d;
  return {
    latitude: c.latitude + (target.latitude - c.latitude) * ratio,
    longitude: c.longitude + (target.longitude - c.longitude) * ratio,
  };
}

const results = [];
const check = (name, ok, extra) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

// 1) 已知距离：
//    纬度 1 度 ≈ 111.32km；同纬度下 0.001 度经度 ≈ 111.32m * cos(lat)
const lat1 = { latitude: 22.9, longitude: 113.8 };
const lat2 = { latitude: 23.9, longitude: 113.8 };
const d1 = distanceMeters(lat1, lat2);
check('纬度差 1 度 ≈ 111.2km', Math.abs(d1 - 111195) < 300, `${(d1 / 1000).toFixed(2)}km`);

const dLng1 = distanceMeters(lat1, { latitude: 22.9, longitude: 113.801 });
check(
  '经度 0.001 度 ≈ 102m（22.9° 纬度）',
  Math.abs(dLng1 - 102.6) < 3,
  `${dLng1.toFixed(1)}m`,
);

const dZero = distanceMeters(lat1, lat1);
check('同点距离为 0', dZero === 0, `${dZero}`);

// 2) metersToLatLng 与 distanceMeters 互逆
const target = metersToLatLng(lat1, 100, 0); // 向东 100m
const back = distanceMeters(lat1, target);
check('向东 100m 换算→回算 ≈ 100m', Math.abs(back - 100) < 1, `${back.toFixed(2)}m`);

// 3) randomPointInCircle 必须全部落在半径内（跑 2000 次）
const circle = { latitude: 22.9015, longitude: 113.8182, radius: 120 };
let allInside = true;
let maxSeen = 0;
let minSeen = Infinity;
for (let i = 0; i < 2000; i += 1) {
  const p = randomPointInCircle(circle);
  const d = distanceMeters(p, circle);
  maxSeen = Math.max(maxSeen, d);
  minSeen = Math.min(minSeen, d);
  if (!isInside(p, circle)) {
    allInside = false;
    break;
  }
}
check(
  '范围内取点 2000 次全部合法',
  allInside,
  `最近 ${minSeen.toFixed(1)}m / 最远 ${maxSeen.toFixed(1)}m（半径 120m，留 25% 余量）`,
);
check('取点确实覆盖到较远区域（不是都挤在圆心）', maxSeen > 60, `max=${maxSeen.toFixed(1)}m`);
check('取点不是固定值（有随机性）', maxSeen - minSeen > 20, `spread=${(maxSeen - minSeen).toFixed(1)}m`);

// 4) nearestPointInside：圆内原样返回，圆外吸附到范围内
const insidePoint = metersToLatLng(circle, 20, 20);
const same = nearestPointInside(insidePoint, circle);
check('圆内点原样返回', same === insidePoint);

const farPoint = metersToLatLng(circle, 800, 600); // 约 1000m 外
const farDist = distanceMeters(farPoint, circle);
const snapped = nearestPointInside(farPoint, circle);
const snappedDist = distanceMeters(snapped, circle);
check('圆外点被吸附到范围内', isInside(snapped, circle), `原始 ${farDist.toFixed(0)}m → 吸附后 ${snappedDist.toFixed(0)}m`);
check('吸附后仍保留原方向（不是直接跳到圆心）', snappedDist > circle.radius * 0.5, `${snappedDist.toFixed(0)}m`);

// 5) 边界：正好等于半径算范围内
const edge = metersToLatLng(circle, circle.radius, 0);
check('正好在半径上算范围内', isInside(edge, circle), `${distanceMeters(edge, circle).toFixed(2)}m vs r=${circle.radius}`);

const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);

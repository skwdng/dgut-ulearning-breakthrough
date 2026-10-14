// 授权（白名单）体系的回归测试。
//
// 重点验证：
//   1. 名单里没有 → 未授权
//   2. 有效期到了 → 过期（即使名单里有）
//   3. 单独禁用 → 停用（优先级高于有效期）
//   4. 名单缺失/缓存过期 → 需要联网
//   5. 学号匹配要忽略大小写与空格
//   6. 名单格式异常能被识别
//   7. 授权状态与模块可用性的联动（未授权时签到模块不可用但仍显示）
//   8. **授权只影响签到模块**，其他模块不受牵连
//
// 用法: node tools/verify-license.cjs

// ===== 与被测逻辑保持一致 =====
function canonicalKey(s) {
  return String(s ?? '').trim().toLowerCase();
}
function findEntry(manifest, studentId) {
  if (!manifest || !studentId) return undefined;
  const key = canonicalKey(studentId);
  return manifest.entries.find((e) => canonicalKey(e.studentId) === key);
}
function verifyManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object') return { ok: false, reason: '名单不是对象' };
  if (!Array.isArray(manifest.entries)) return { ok: false, reason: 'entries 不是数组' };
  for (const e of manifest.entries) {
    if (!e || typeof e.studentId !== 'string' || !e.studentId.trim()) return { ok: false, reason: '存在缺少 studentId 的条目' };
    if (typeof e.name !== 'string') return { ok: false, reason: '存在缺少 name 的条目' };
  }
  return { ok: true };
}
function evaluateLicense({ manifest, studentId, now = Date.now(), cacheStale = false, devBypass = false }) {
  const checkedAt = now;
  if (devBypass) return { status: 'dev-bypass', checkedAt };
  if (!studentId) return { status: 'not-bound', checkedAt };
  if (!manifest) return { status: 'no-manifest', checkedAt, message: cacheStale ? '缓存过期' : '没有名单' };
  const entry = findEntry(manifest, studentId);
  if (!entry) return { status: 'not-listed', checkedAt };
  if (entry.disabled) return { status: 'disabled', entry, checkedAt };
  if (entry.expiresAt && now > entry.expiresAt) return { status: 'expired', entry, checkedAt };
  return { status: 'granted', entry, checkedAt };
}
function isLicensed(state) {
  return state.status === 'granted' || state.status === 'dev-bypass';
}

// ===== 模块联动（与 src/domain/modules.ts 一致的精简版） =====
const MODULES = [
  { key: 'checkin', requiresLicense: true, platforms: ['android', 'ios'], defaultEnabled: true },
  { key: 'delivery', platforms: ['android'], defaultEnabled: true },
  { key: 'todo', platforms: ['android', 'ios'], defaultEnabled: true },
];
function computeAll(cfg, licensed, platform = 'android') {
  return MODULES.map((def) => {
    const platformSupported = def.platforms.includes(platform);
    const explicitlyEnabled = cfg.enabled.includes(def.key);
    const explicitlyDisabled = cfg.disabled.includes(def.key);
    const userEnabled = explicitlyEnabled ? true : explicitlyDisabled ? false : def.defaultEnabled;
    const licenseOk = def.requiresLicense ? licensed : true;
    return {
      def,
      platformSupported,
      userEnabled,
      visible: userEnabled && (platformSupported || explicitlyEnabled),
      usable: userEnabled && platformSupported && licenseOk,
    };
  });
}

// ===== 测试 =====
const results = [];
function check(name, ok, extra) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-07T12:00:00Z');

const MANIFEST = {
  version: 3,
  issuedAt: NOW - DAY,
  entries: [
    { name: '同学A', studentId: '2099000000116', expiresAt: NOW + 30 * DAY },
    { name: '张三', studentId: '2099000000199', expiresAt: NOW - DAY }, // 已过期
    { name: '李四', studentId: '2099000000177', disabled: true }, // 被禁用
    { name: '王五', studentId: '2099000000155' }, // 永久有效
  ],
};

// 1) 基本命中
{
  const s = evaluateLicense({ manifest: MANIFEST, studentId: '2099000000116', now: NOW });
  check('名单内且未过期 → granted', s.status === 'granted');
  check('授予时带出条目信息', s.entry?.name === '同学A');
  check('isLicensed 为真', isLicensed(s) === true);
}

// 2) 不在名单
{
  const s = evaluateLicense({ manifest: MANIFEST, studentId: '9999999999999', now: NOW });
  check('不在名单 → not-listed', s.status === 'not-listed');
  check('not-listed 不算授权', isLicensed(s) === false);
}

// 3) 过期
{
  const s = evaluateLicense({ manifest: MANIFEST, studentId: '2099000000199', now: NOW });
  check('名单内但已过期 → expired', s.status === 'expired');
  check('过期不算授权', isLicensed(s) === false);
}

// 4) 禁用优先于有效期（王五永久有效但李四是 disabled；这里测 disabled 分支）
{
  const s = evaluateLicense({ manifest: MANIFEST, studentId: '2099000000177', now: NOW });
  check('被单独禁用 → disabled', s.status === 'disabled');
}

// 5) 永久有效
{
  const s = evaluateLicense({ manifest: MANIFEST, studentId: '2099000000155', now: NOW });
  check('无 expiresAt → 长期有效', s.status === 'granted');
}

// 6) 边界：正好到期时刻
{
  const m = { version: 1, issuedAt: NOW, entries: [{ name: 'A', studentId: 'X1', expiresAt: NOW }] };
  const at = evaluateLicense({ manifest: m, studentId: 'X1', now: NOW });
  const after = evaluateLicense({ manifest: m, studentId: 'X1', now: NOW + 1 });
  check('到期时刻本身仍有效（now > expiresAt 才失效）', at.status === 'granted' && after.status === 'expired');
}

// 7) 学号匹配忽略大小写与空格
{
  const m = { version: 1, issuedAt: NOW, entries: [{ name: 'A', studentId: '  AbC123 ', expiresAt: NOW + DAY }] };
  check('忽略大小写匹配', evaluateLicense({ manifest: m, studentId: 'abc123', now: NOW }).status === 'granted');
  check('忽略首尾空格匹配', evaluateLicense({ manifest: m, studentId: 'ABC123', now: NOW }).status === 'granted');
}

// 8) 未绑定 / 无名单 / 缓存过期
{
  check('未绑定账号 → not-bound', evaluateLicense({ manifest: MANIFEST, studentId: undefined, now: NOW }).status === 'not-bound');
  check('无名单 → no-manifest', evaluateLicense({ manifest: null, studentId: 'X', now: NOW }).status === 'no-manifest');
  check('缓存过期 → no-manifest 且带提示', evaluateLicense({ manifest: null, studentId: 'X', now: NOW, cacheStale: true }).message === '缓存过期');
  check('开发旁路 → dev-bypass', evaluateLicense({ manifest: null, studentId: undefined, now: NOW, devBypass: true }).status === 'dev-bypass');
}

// 9) 名单格式校验
{
  check('正常名单 → ok', verifyManifestShape(MANIFEST).ok === true);
  check('entries 非数组 → 拒绝', verifyManifestShape({ version: 1, issuedAt: NOW, entries: 'x' }).ok === false);
  check('缺 studentId → 拒绝', verifyManifestShape({ version: 1, issuedAt: NOW, entries: [{ name: 'A' }] }).ok === false);
  check('studentId 为空串 → 拒绝', verifyManifestShape({ version: 1, issuedAt: NOW, entries: [{ name: 'A', studentId: '  ' }] }).ok === false);
  check('缺 name → 拒绝', verifyManifestShape({ version: 1, issuedAt: NOW, entries: [{ studentId: 'X' }] }).ok === false);
  check('完全不是对象 → 拒绝', verifyManifestShape(null).ok === false);
}

// 10) 与模块系统联动
{
  const EMPTY = { enabled: [], disabled: [] };

  const denied = computeAll(EMPTY, false, 'android');
  const c1 = denied.find((m) => m.def.key === 'checkin');
  check('未授权：签到模块仍**显示**（让用户看到原因）', c1.visible === true);
  check('未授权：签到模块**不可用**', c1.usable === false);

  const allowed = computeAll(EMPTY, true, 'android');
  const c2 = allowed.find((m) => m.def.key === 'checkin');
  check('已授权：签到模块可用', c2.usable === true);

  // 关键：授权只影响签到，不能牵连其他模块
  const d1 = denied.find((m) => m.def.key === 'delivery');
  const t1 = denied.find((m) => m.def.key === 'todo');
  check('未授权不影响外卖模块', d1.usable === true && d1.visible === true);
  check('未授权不影响待办模块', t1.usable === true && t1.visible === true);

  // 用户主动关闭签到 → 未授权也不显示
  const closed = computeAll({ enabled: [], disabled: ['checkin'] }, false, 'android');
  check('用户手动关闭签到 → 不显示（用户选择优先）', closed.find((m) => m.def.key === 'checkin').visible === false);

  // iOS 上外卖仍按平台过滤
  const ios = computeAll(EMPTY, true, 'ios');
  check('iOS 上外卖仍被平台过滤', ios.find((m) => m.def.key === 'delivery').visible === false);
}

const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY total=${results.length} pass=${results.length - failed.length} fail=${failed.length}`);
process.exit(failed.length === 0 ? 0 : 1);

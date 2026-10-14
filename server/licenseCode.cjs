/**
 * 授权码生成（服务端用）。
 *
 * ⚠️ 这段算法必须与 App 端 `src/domain/licenseCode.ts` **完全一致**，
 *    否则 App 校验不过。三处实现要保持同步：
 *      · src/domain/licenseCode.ts       （App）
 *      · web/license-admin.html          （旧的网页生成器）
 *      · src/services/serverClient.ts     （App 读服务器）
 *      · 本文件 + server/server.cjs        （服务端自动下发）
 *    改算法时必须一起改，`tools/verify-code-cross.cjs` 会做一致性检查。
 *
 * 为什么要服务端也生成：需求是"填了万能码的人自动获得一份个人授权码"。
 * 那份码必须和 App 里的校验算法匹配，所以在服务端生成最省事
 * （不用把密钥再塞进 App）。
 */

const CODE_PREFIX = 'LK1';
const SIGN_KEY = 'LifeKit::checkin::v1::2026';
const B32 = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const SEG_LEN = 5;

function normalizeStudentId(s) {
  return String(s ?? '').replace(/\s+/g, '').toLowerCase();
}

/** 两轮不同种子的 FNV-1a → 16 位 hex（与 App 一致，**不是** 12 位） */
function hashStudentId(studentId) {
  const s = normalizeStudentId(studentId);
  const fnv = (seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  return (
    fnv(0x811c9dc5).toString(16).padStart(8, '0') +
    fnv(0x9e3779b9).toString(16).padStart(8, '0')
  );
}

function toBase32(bytes) {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const b of bytes) {
    acc = ((acc << 8) | (b & 0xff)) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(acc >>> (bits - 5)) & 31];
      bits -= 5;
      acc &= (1 << bits) - 1;
    }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

function hexToBytes(hex) {
  const out = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

function signWith(key, payloadStr) {
  const raw = `${key}|${payloadStr}`;
  return toBase32(hexToBytes(hashStudentId(raw) + hashStudentId(`${raw}#2`)));
}

function sign(payloadStr) {
  return signWith(SIGN_KEY, payloadStr);
}

function group(s) {
  const parts = [];
  for (let i = 0; i < s.length; i += SEG_LEN) parts.push(s.slice(i, i + SEG_LEN));
  return parts.join('-');
}

/** 到期时间戳 → 天数（自 2026-01-01）；0 表示永久 */
function expireDaysFrom(expiresAt) {
  if (!expiresAt) return 0;
  const EPOCH = Date.UTC(2026, 0, 1);
  const days = Math.round((expiresAt - EPOCH) / 86400000);
  if (days <= 0) return 1;
  return Math.min(days, 0xffff);
}

/**
 * 生成绑定学号的个人授权码。
 *
 * @param {string} studentId
 * @param {{expiresAt?: number}} [options] 不传 = 永久
 * @returns {string} 形如 `LK1-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXX`
 */
function generateLicenseCode(studentId, options = {}) {
  const sid = normalizeStudentId(studentId);
  if (!sid) throw new Error('学号不能为空');

  const hashBytes = hexToBytes(hashStudentId(sid)).slice(0, 6);
  const days = expireDaysFrom(options.expiresAt);
  const payloadStr = toBase32([...hashBytes, (days >> 8) & 0xff, days & 0xff]);
  const sigStr = sign(payloadStr).slice(0, SEG_LEN * 3);
  return `${CODE_PREFIX}-${group(payloadStr + sigStr)}`;
}

module.exports = { generateLicenseCode, hashStudentId, CODE_PREFIX, SIGN_KEY, B32 };

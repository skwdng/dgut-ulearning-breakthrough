/**
 * 生成 `LKM-` 签名万能码（自用）。
 *
 * ══════════════ 为什么需要这个工具 ══════════════
 *
 * 用户要「往外投，每人一个授权码」→ 对外版必须**剥离明文便利万能码**
 * （`CONVENIENCE_MASTER_CODE`，见 src/domain/licenseCode.ts 的注释），
 * 否则任何人反编译 APK 就能搜出内置万能码，
 * 而它的权限是 `scope: 'all'` —— **能改任何人**的签到状态。
 *
 * ⚠️ 剥离之后，用户自己的设备也没法用便利码了，所以需要
 *    **服务器认的签名万能码**（`LKM-…`）：
 *      · 它是 `MASTER_KEY` + 载荷**签名算出来**的，反编译造不出有效组合
 *      · 真正的门是服务端的 `masterCodeHash` —— 签名码也得服务端认
 *
 * ══════════════ 用法 ══════════════
 *
 *   node tools/gen-master-code.cjs              # 永久有效
 *   node tools/gen-master-code.cjs 365          # 365 天后过期
 *
 * ⚠️ 这个脚本**只在开发机上跑**，不要放进 APK。
 *
 * ══════════════ ⚠️ 与 src/domain/licenseCode.ts 必须保持一致 ══════════════
 *
 * 下面这几个常量/算法是从那边**逐字抄过来**的。
 * 那边改了这里必须同步 —— 否则生成的码 App 解析不了（会报"签名校验失败"）。
 * 有测试盯着：tools/verify-master-code.cjs
 */
const MASTER_PREFIX = 'LKM';
const MASTER_KEY = 'LifeKit::master::v1::2026';
const B32 = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const SEG_LEN = 5;
const MASTER_PAYLOAD_BYTES = 3;
const MASTER_PAYLOAD_CHARS = Math.ceil((MASTER_PAYLOAD_BYTES * 8) / 5);

/** 学号/字符串哈希（FNV-1a 双种子 → 16 位 hex） */
function hashStudentId(studentId) {
  const s = String(studentId ?? '').replace(/\s/g, '');
  const fnv = (seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  return fnv(0x811c9dc5).toString(16).padStart(8, '0') + fnv(0x9e3779b9).toString(16).padStart(8, '0');
}

function signWith(key, payloadStr) {
  const raw = `${key}|${payloadStr}`;
  const h1 = hashStudentId(raw);
  const h2 = hashStudentId(`${raw}#2`);
  return toBase32(hexToBytes(h1 + h2));
}

function hexToBytes(hex) {
  const out = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
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

function group(s) {
  const parts = [];
  for (let i = 0; i < s.length; i += SEG_LEN) parts.push(s.slice(i, i + SEG_LEN));
  return parts.join('-');
}

/** 到期时间 → 天数（自 2026-01-01）；0 表示永久 */
function expireDaysFrom(expiresAt) {
  if (!expiresAt) return 0;
  const EPOCH = Date.UTC(2026, 0, 1);
  const days = Math.round((expiresAt - EPOCH) / 86400000);
  if (days <= 0) return 1;
  return Math.min(days, 0xffff);
}

/** 生成万能码 */
function generateMasterCode(options = {}) {
  const days = expireDaysFrom(options.expiresAt);
  const payloadBytes = [0x4d, (days >> 8) & 0xff, days & 0xff];
  const payloadStr = toBase32(payloadBytes);
  const sigStr = signWith(MASTER_KEY, payloadStr).slice(0, SEG_LEN * 3);
  return `${MASTER_PREFIX}-${group(payloadStr + sigStr)}`;
}

// ────────────────────────────── 自检 ──────────────────────────────
/**
 * ⚠️ 生成前先自检：拿已知的解析逻辑反解一遍，确认格式对得上。
 *    这样"生成的码 App 认不认"当场就知道，不用等装到手机上才发现。
 */
function selfCheck(code) {
  const body = code.slice(MASTER_PREFIX.length + 1); // 去掉 "LKM-"
  const flat = body.replace(/-/g, '');
  const sigChars = SEG_LEN * 3;
  if (flat.length !== MASTER_PAYLOAD_CHARS + sigChars) {
    return `长度不对（期望 ${MASTER_PAYLOAD_CHARS + sigChars}，实际 ${flat.length}）`;
  }
  const payloadStr = flat.slice(0, MASTER_PAYLOAD_CHARS);
  const sigStr = flat.slice(MASTER_PAYLOAD_CHARS);
  if (signWith(MASTER_KEY, payloadStr).slice(0, sigChars) !== sigStr) {
    return '签名校验失败 —— 算法与 App 不一致';
  }
  const bytes = fromBase32(payloadStr, MASTER_PAYLOAD_BYTES);
  if (bytes[0] !== 0x4d) return `魔数不对（期望 0x4d，实际 0x${bytes[0].toString(16)}）`;
  const days = ((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0);
  return `✓ 自检通过（有效期天数=${days}，0 表示永久）`;
}

function fromBase32(s, byteLen) {
  const out = [];
  let bits = 0;
  let acc = 0;
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error(`非法 Base32 字符: ${ch}`);
    acc = ((acc << 5) | v) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >>> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return out.slice(0, byteLen);
}

// ────────────────────────────── 主流程 ──────────────────────────────
const daysArg = process.argv[2];
const days = daysArg ? Number(daysArg) : 0;
if (daysArg && (!Number.isFinite(days) || days <= 0)) {
  console.error('  × 参数应为正整数天数（不填 = 永久）');
  process.exit(1);
}
const expiresAt = days ? Date.now() + days * 86400000 : undefined;
const code = generateMasterCode({ expiresAt });

console.log('');
console.log('  ══════════════════════════════════════════════');
console.log('   LKM- 签名万能码（自用，对外版里没有明文码）');
console.log('  ══════════════════════════════════════════════');
console.log('');
console.log(`    ${code}`);
console.log('');
console.log(`  有效期：${days ? `${days} 天后过期` : '永久'}`);
console.log(`  ${selfCheck(code)}`);
console.log('');
console.log('  ⚠️ 这个码权限是「能改任何人」，别外传。');
console.log('  ⚠️ 输入位置：设置 → 授权码。');
console.log('');

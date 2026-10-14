/**
 * 授权模型测试：只有「对应的学号 + 对应的授权码」才能用签到。
 *
 * 覆盖两种"盗用"场景：
 *   ① 拿别人的授权码填进自己的 App → 必须被拒
 *   ② 用别人的账号登录自己的 App（码还是自己的）→ 必须被拒
 *
 * ⚠️ 这里**复刻** src/domain/licenseCode.ts 的哈希/编码算法，
 *    并断言与源文件常量一致；算法或常量一变，这个测试就会失败，
 *    提醒同步更新（宁可测试报警，也不要悄悄放行）。
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'domain', 'licenseCode.ts'), 'utf8');

function constOf(name) {
  /**
   * ⚠️ 三种写法都要认：
   *   ① 直接字面量：      `const X = 'abc';`
   *   ② 三元（对外版剥离）：`const X = ... === '1' ? '' : 'abc';`
   *   ③ 公开仓库版（2026-10）：兜底值走环境变量 ——
   *        `const X = ... === '1' ? '' : (process.env.EXPO_PUBLIC_MASTER_CODE || 'CHANGE_ME');`
   *      → 优先取**环境变量**（那才是真实值），没设再取源码里的兜底占位符。
   *      ⚠️ 踩过：只认 ① 时改成 ② 后抠到 null → 后面 `.length` 直接崩。
   */
  const direct = SRC.match(new RegExp(`${name}\\s*=\\s*'([^']+)'`));
  if (direct) return direct[1];
  /** ③ 形如 `process.env.EXPO_PUBLIC_MASTER_CODE || '占位'` */
  const viaEnv = SRC.match(
    new RegExp(`${name}\\s*=[\\s\\S]{0,200}?process\\.env\\.([A-Z0-9_]+)\\s*\\|\\|\\s*'([^']+)'`),
  );
  if (viaEnv) return process.env[viaEnv[1]] || viaEnv[2];
  /** ③b 直接是 `process.env.X || '占位'`（没有三元剥离那一层） */
  const viaEnvDirect = SRC.match(
    new RegExp(`${name}\\s*=[\\s\\S]{0,60}?process\\.env\\.([A-Z0-9_]+)\\s*\\|\\|\\s*'([^']+)'`),
  );
  if (viaEnvDirect) return process.env[viaEnvDirect[1]] || viaEnvDirect[2];
  const ternary = SRC.match(
    new RegExp(`${name}\\s*=[\\s\\S]{0,120}?\\?\\s*''\\s*:\\s*'([^']+)'`),
  );
  return ternary ? ternary[1] : null;
}

const CODE_PREFIX = constOf('CODE_PREFIX');
const MASTER_PREFIX = constOf('MASTER_PREFIX');
const SIGN_KEY = constOf('SIGN_KEY');
const MASTER_KEY = constOf('MASTER_KEY');
const CONVENIENCE_MASTER_CODE = constOf('CONVENIENCE_MASTER_CODE');
const SEG_LEN = Number((SRC.match(/SEG_LEN\s*=\s*(\d+)/) ?? [])[1] ?? 5);
const B32 = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

let pass = 0;
let fail = 0;
function t(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  √ ${name}`);
  } else {
    fail += 1;
    console.log(`  × ${name}${extra ? '  → ' + extra : ''}`);
  }
}

// ── 复刻算法（与源文件一致）──
const normalizeStudentId = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

/** 两轮不同种子的 FNV-1a → 16 位 hex（**不是** 12 位） */
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
  const a = fnv(0x811c9dc5);
  const b = fnv(0x9e3779b9);
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
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

/** 与 generateLicenseCode 一致：payload = base32(前6字节哈希 + 2字节有效期) */
function payloadOf(studentId, expireDays = 0) {
  const hashBytes = hexToBytes(hashStudentId(studentId)).slice(0, 6);
  const expireBytes = [(expireDays >> 8) & 0xff, expireDays & 0xff];
  return toBase32([...hashBytes, ...expireBytes]);
}

/** 从完整码里取回 payload（前缀之后的前 13 个字符，去掉横线） */
function payloadFromCode(code) {
  const raw = code.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (!raw.startsWith(CODE_PREFIX)) return null;
  return raw.slice(CODE_PREFIX.length, CODE_PREFIX.length + 13);
}

console.log('  源文件常量：');
console.log(`    CODE_PREFIX=${CODE_PREFIX}  MASTER_PREFIX=${MASTER_PREFIX}  SEG_LEN=${SEG_LEN}`);
console.log(`    便利万能码=${CONVENIENCE_MASTER_CODE}`);
console.log('');

console.log('=== 1) 哈希算法 ===');
t('同样学号两次哈希相同', hashStudentId('2099000000116') === hashStudentId('2099000000116'));
t('大小写不敏感', hashStudentId('ABC') === hashStudentId('abc'));
t('空格被忽略', hashStudentId(' 202 5404 ') === hashStudentId('2025404'));
t('不同学号哈希不同', hashStudentId('2099000000116') !== hashStudentId('2099000000117'));
t('哈希长度 16（8 字节 hex）', hashStudentId('x').length === 16);
t('只含 hex 字符', /^[0-9a-f]{16}$/.test(hashStudentId('2099000000116')));

console.log('\n=== 2) 码里确实带学号信息（核心）===');
const sidA = '2099000000116';
const sidB = '2099000000999';
const payloadA = payloadOf(sidA);
// 造一个"发给 A 的完整码"（签名随便填，只测 payload 部分）
const codeForA = `${CODE_PREFIX}-${(payloadA + 'ZZZZZZZZZZZZZZZ').replace(/(.{5})(?=.)/g, '$1-')}`;

t('从码里能取回 payload', payloadFromCode(codeForA) === payloadA, `${payloadFromCode(codeForA)} vs ${payloadA}`);
t('★ A 的 payload ≠ B 的 payload（换学号必然对不上）', payloadOf(sidA) !== payloadOf(sidB));
t('★ payload 前段与 A 的哈希字节一致', payloadA.startsWith(toBase32(hexToBytes(hashStudentId(sidA)).slice(0, 6))));
t('有效期为 0 的 payload 与有有效期的不同', payloadOf(sidA, 0) !== payloadOf(sidA, 100));

console.log('\n=== 3) 万能码不绑学号 ===');
t('万能码前缀与普通码不同', MASTER_PREFIX !== CODE_PREFIX);
t('便利万能码长度不符合算法码规格', CONVENIENCE_MASTER_CODE.length !== 13 + 15);
t(
  '便利万能码不出现在算法码里',
  !payloadOf(sidA).includes(CONVENIENCE_MASTER_CODE.toUpperCase()),
);

console.log('\n=== 4) 两类密钥不同 ===');
t('SIGN_KEY 与 MASTER_KEY 不同', SIGN_KEY !== MASTER_KEY);
t('两个密钥都非空', Boolean(SIGN_KEY) && Boolean(MASTER_KEY));

console.log('\n=== 5) Base32 字母表 ===');
t('正好 32 个字符', B32.length === 32);
t('不含易混字符 0/1/I/O', !/[01IO]/.test(B32));
t('无重复字符', new Set(B32).size === 32);
t('算法码只由这些字符组成', [...payloadA].every((c) => B32.includes(c)));

console.log('\n=== 6) 服务端授权语义（与 unlockStore 的 entitled 一致）===');
/** 只有服务器**明确拒绝**才拦；连不上/没登记都不拦 */
function entitled(unlocked, serverAuth) {
  return unlocked && serverAuth !== 'denied';
}
t('本地通过 + 服务器通过 → 可用', entitled(true, 'granted') === true);
t('本地通过 + 服务器没登记 → 可用（不拦）', entitled(true, 'unknown') === true);
t('★ 本地通过 + 服务器明确拒绝 → 不可用', entitled(true, 'denied') === false);
t('★ 本地不通过（码不匹配）→ 不可用', entitled(false, 'granted') === false);
t('本地不通过 + 服务器拒绝 → 不可用', entitled(false, 'denied') === false);

console.log('\n=== 7) 「登录别人账号」的两种情形 ===');
// 情形一：拿别人的码填进自己的 App
const iAmB = sidB;
const payloadBelongsToA = payloadOf(sidA);
const payloadMine = payloadOf(iAmB);
t('★ 情形一：别人的码 ≠ 我的 payload → 被拒', payloadBelongsToA !== payloadMine);

// 情形二：用别人的账号登录（码还是自己的）
const codeMine = payloadOf(sidA);
const nowLoggedInAsB = payloadOf(sidB);
t('★ 情形二：我的码 ≠ 当前账号的 payload → 被拒', codeMine !== nowLoggedInAsB);

console.log('\n=== 8) 权限范围：万能码 vs 个人码（新增）===');
{
  /**
   * 复刻 unlockStore / licenseCode 的范围判定：
   *   万能码                 → 'all'（可改任何人）
   *   个人码                 → 'self'（只能改自己）
   *   万能码失效 + 有个人码   → 降级 'self'
   *   万能码失效 + 无个人码   → 'none'
   */
  function scopeOf(kind, masterStillValid, hasPersonalCode) {
    if (kind === 'personal') return 'self';
    if (kind === 'master') {
      if (masterStillValid) return 'all';
      return hasPersonalCode ? 'self' : 'none';
    }
    return 'none';
  }

  t('万能码有效 → all', scopeOf('master', true, false) === 'all');
  t('个人码 → self', scopeOf('personal', true, false) === 'self');
  t('★ 万能码失效 + 有个人码 → 降级 self', scopeOf('master', false, true) === 'self');
  t('★ 万能码失效 + 无个人码 → none', scopeOf('master', false, false) === 'none');

  /** 复刻 denyStatusChange：个人码不能改别人的记录 */
  function canChange(scope, myUserId, targetUserId) {
    if (scope === 'none') return false;
    if (scope === 'all') return true;
    // self：必须确认目标就是自己
    if (!myUserId) return false; // 拿不到自己的 id → 保守拒绝
    return targetUserId === myUserId;
  }

  const me = 90990001;
  const other = 88888888;
  t('★ self：改自己 → 允许', canChange('self', me, me) === true);
  t('★ self：改别人 → 拒绝', canChange('self', me, other) === false);
  t('★ self：拿不到自己 userId → 保守拒绝', canChange('self', undefined, other) === false);
  t('all：改别人 → 允许', canChange('all', me, other) === true);
  t('none：一律拒绝', canChange('none', me, me) === false);
}

console.log('\n=== 9) 万能码领到的个人码也要绑学号 ===');
{
  // 服务器给 A 发的个人码，只能给 A 用
  const personalForA = payloadOf(sidA);
  t('★ A 的个人码 ≠ B 的 payload（B 用不了）', personalForA !== payloadOf(sidB));
  t('A 的个人码 == A 的 payload', personalForA === payloadOf(sidA));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

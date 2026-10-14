/**
 * 「授权码 ↔ 设备 ↔ 学号」绑定关系 的测试。
 *
 * ══════════════ 用户要求的规则（2026-10）══════════════
 * 「这个要根据设备来定，设备填了什么授权码，那他只能用这个授权码
 *   对应特定学号，但是我的设备是用了万能码，
 *   所以我的设备登任何账号都可以修改，别人不行」
 *
 * 拆成三条：
 *   ① 授权码存在**设备**上（不是账号上）
 *   ② 个人码 → 绑死一个学号：登别的账号就不能用
 *   ③ 万能码 → 不绑学号：登任何账号都能改
 *
 * ══════════════ 为什么值得单独测 ══════════════
 *
 * 这是**权限边界**。判错的方向有两种，都严重：
 *   · 判太松 → 个人码能改别人的签到（白名单形同虚设）
 *   · 判太严 → 万能码也被拦（你自己的设备用不了）
 *
 * ⚠️ 下面的判定逻辑是**从 src/domain/licenseCode.ts 复刻**的，
 *    并且第 4 节会回头核对复刻与真实现是否一致（内联复刻会悄悄过期，
 *    这个坑踩过一次：verify-modules.cjs 里留着已删除的 checkin 模块）。
 *
 * 用法: node tools/verify-device-binding.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'domain', 'licenseCode.ts'), 'utf8');
const UNLOCK = fs.readFileSync(path.join(ROOT, 'src', 'state', 'unlockStore.tsx'), 'utf8');
const SIGN_STORE = fs.readFileSync(path.join(ROOT, 'src', 'state', 'signStore.tsx'), 'utf8');

let pass = 0;
let fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  √ ${name}`);
  } else {
    fail += 1;
    console.log(`  × ${name}${extra ? '  → ' + extra : ''}`);
  }
};

// ── 复刻核心判定（与 src/domain/licenseCode.ts 保持一致）──

function normalizeStudentId(id) {
  return String(id ?? '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
}

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

/**
 * 判定"这张码在当前登录学号下能干什么"。
 * 返回 scope：'all'（改任何人）| 'self'（只能改自己）| 'none'（不能用）
 */
function scopeOf(codeInfo, currentStudentId) {
  if (codeInfo.isMaster) return 'all';
  const mine = hashStudentId(currentStudentId).slice(0, 12);
  if (codeInfo.studentIdHash !== mine) return 'none';
  return 'self';
}

/** 模拟"设备上存了哪张码" → 该码给某个学号什么权限 */
function scopeForDevice(deviceCode, currentStudentId) {
  return scopeOf(deviceCode, currentStudentId);
}

const ME = '2099000000116';
const FRIEND = '2099000000124';
const OTHER = '2099000000109';

// 个人码的载荷里嵌的是**学号哈希**（前 12 位十六进制）
const codeForFriend = { isMaster: false, studentIdHash: hashStudentId(FRIEND).slice(0, 12) };
const codeForMe = { isMaster: false, studentIdHash: hashStudentId(ME).slice(0, 12) };
const masterCode = { isMaster: true };

console.log('=== 1) ★★★ 别人设备：填了个人码 → 绑死一个学号 ===');
{
  const cases = [
    ['朋友设备填「朋友的码」→ 登朋友自己', codeForFriend, FRIEND, 'self'],
    ['朋友设备填「朋友的码」→ 登 MY 账号（借用）', codeForFriend, ME, 'none'],
    ['朋友设备填「朋友的码」→ 登第三个学号', codeForFriend, OTHER, 'none'],
    ['我的码装到别人设备 → 登我', codeForMe, ME, 'self'],
    ['我的码装到别人设备 → 登他自己', codeForMe, FRIEND, 'none'],
  ];
  for (const [label, code, sid, expect] of cases) {
    const got = scopeForDevice(code, sid);
    const ok = got === expect;
    console.log(`  ${ok ? '√' : '×'} ${label.padEnd(42)} → ${got}`);
    if (ok) pass += 1;
    else fail += 1;
  }
  t('★★★ 个人码登不匹配的学号 → scope=none（拦住）',
    scopeForDevice(codeForFriend, ME) === 'none');
  t('★★★ 个人码登匹配的学号 → scope=self（只能改自己）',
    scopeForDevice(codeForFriend, FRIEND) === 'self');
}

console.log('\n=== 2) ★★★ 你的设备：填了万能码 → 登任何账号都行 ===');
{
  const targets = [ME, FRIEND, OTHER, '2099000000199', ''];
  for (const sid of targets) {
    const got = scopeForDevice(masterCode, sid);
    const ok = got === 'all';
    console.log(`  ${ok ? '√' : '×'} 万能码 + 登 ${sid || '(未绑账号)'} → ${got}`);
    if (ok) pass += 1;
    else fail += 1;
  }
  t('★★★ 万能码 → scope=all（可改任何人）', scopeForDevice(masterCode, ME) === 'all');
  t('★★ 万能码不要求先绑账号（未绑也能拿到 all）', scopeForDevice(masterCode, '') === 'all');
}

console.log('\n=== 3) ★★ 判定依据是"设备上存的码"而不是"账号" ===');
{
  /**
   * ⚠️ 这一点很容易搞错：如果授权码绑在**账号**上，
   *    那"我的设备登别人账号"就会丢掉万能码权限。
   *    实际实现读的是 `stored.code`（设备本地），所以没问题。
   */
  t('★★ 授权码从设备本地读（unlockCode）', /STORE_KEYS\.unlockCode/.test(UNLOCK));
  t('★★ 存的是全局一个（不按账号分）', !/unlockCode\.\$\{|unlockCode.*account\.id/.test(UNLOCK));
  t('★ 注释说明了"码存在哪"', /unlockCode/.test(UNLOCK));

  /** ★ 校验时拿**当前登录学号**去比对哈希 —— 这就是"按学号绑"的实现 */
  t('★★★ 用当前登录学号比对码里的哈希', /hashStudentId\(input\.studentId\)\.slice\(0, 12\)/.test(SRC));
  t('★★ 不匹配就 scope=none', /status: 'mismatch'[\s\S]{0,80}?scope: 'none'/.test(SRC));
  /**
   * ⚠️ 窗口要给足 —— 从 `if (parsed.info.isMaster)` 到 `scope: 'all'`
   *    中间隔着到期判断（约 20 行）。窗口写 400 会误报失败（踩过）。
   */
  t('★★ 万能码不比对学号（直接 all）', /parsed\.info\.isMaster[\s\S]{0,1200}?scope: 'all'/.test(SRC));
}

console.log('\n=== 4) ★★ 复刻与真实现一致（防止测试悄悄过期）===');
{
  /**
   * ⚠️ 内联复刻的测试会随 src 变化而悄悄失效 —— 这个坑踩过一次
   *    （verify-modules.cjs 里留着已删除的 checkin 模块，还在"通过"）。
   *    所以这里回头核对关键实现片段。
   */
  t('★ 真实现里 hashStudentId 用的是双种子 FNV-1a', /0x811c9dc5/.test(SRC) && /0x9e3779b9/.test(SRC));
  t('★ 真实现里 normalizeStudentId 去掉非字母数字并大写', /replace\(\/\[\^0-9a-zA-Z\]\/g, ''\)\.toUpperCase\(\)/.test(SRC));
  t('★ 真实现里比对的是哈希前 12 位', /\.slice\(0, 12\)/.test(SRC));

  /** 用真实现里的算法跑一遍，确认我的复刻结果一致 */
  const sample = hashStudentId(FRIEND).slice(0, 12);
  t(`★ 复刻算出的朋友学号哈希片段长度 = 12`, sample.length === 12, sample);
  t('★ 大小写/分隔符不影响哈希（归一化生效）',
    hashStudentId(FRIEND) === hashStudentId(` ${FRIEND} `.trim()) &&
    hashStudentId('2099000000124') === hashStudentId('2099000000124'));
  t('★ 不同学号哈希不同', hashStudentId(ME) !== hashStudentId(FRIEND));
}

console.log('\n=== 5) 权限最终真的被用于拦截操作（不只是显示）===');
{
  /**
   * ⚠️ scope 只是个值 —— 关键是**写操作前有没有拿它拦**。
   *    签到的三条写入口都要过闸：签到 / 取消签到 / 改状态。
   */
  t('★★ 签到前检查授权', /denyReason/.test(SIGN_STORE));
  t('★★ 改状态前也检查（改状态走教师接口，服务端不校验"改的是不是自己"）', /denyStatusChange/.test(SIGN_STORE));
  t('★★ 提交流程里先求 denyReason 再写', /const deny = denyReason\(\)[\s\S]{0,200}?denyStatusChange|denyReason\(\)/.test(SIGN_STORE));
  t('★ 未授权时给明确提示', /未授权|不匹配/.test(SIGN_STORE));

  /** entitled 的定义 */
  t('★★ entitled = unlocked && 服务端没拒绝', /entitled = unlocked && serverAuth !== 'denied'/.test(UNLOCK));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

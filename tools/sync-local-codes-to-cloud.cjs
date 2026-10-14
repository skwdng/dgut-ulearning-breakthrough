/**
 * 把**本地服务器**（桌面管理后台）生成的授权码**同步到云端**。
 *
 * ══════════════ 🚨 为什么需要这个（用户的真实踩坑）══════════════
 *
 * 用户原话：「我用的桌面上的这个给他生成的」
 *
 * 情况：
 *   · 他打开**桌面那个**管理后台（跑在他电脑上，局域网）
 *   · 在里面给朋友（2099000000127 等）生成了授权码
 *   · 但朋友的手机 App **默认连的是云端**（地址见 LIFEKIT_CLOUD）
 *   · App 问云端"这个学号授权了吗" → 云端说没有 → **拦住**
 *
 *   现象就是：「填了码还是卡住」，而本地后台明明显示已授权。
 *
 * ══════════════ 这个脚本做什么 ══════════════
 *
 *   读本地 data.json 的 users
 *     ↓
 *   对每个**云端没有、或码不一致**的学号，调云端的 `/api/issue` 写入
 *     ↓
 *   逐个复核
 *
 * ⚠️ 用 `/api/issue`（merge 式写入）而不是直接改 data.json：
 *    那是云端唯一安全的写入口，会保留 boundAt / loginCount / usedCount。
 *
 * ⚠️ **不删除**云端任何记录，只新增/补码。
 *
 * 用法: node tools/sync-local-codes-to-cloud.cjs
 *       node tools/sync-local-codes-to-cloud.cjs --check   # 只看差异，不写
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
/**
 * ⚠️ 公开仓库版（2026-10）：这里原先硬编码了**本机桌面路径**、
 *    真实服务器地址、以及管理口令的 base64。全部改成环境变量。
 *
 *    用法：
 *      LIFEKIT_LOCAL_DATA=路径 LIFEKIT_CLOUD=http://你的地址:8787 \
 *      LIFEKIT_ADMIN_PASSWORD=你的口令 node tools/sync-local-codes-to-cloud.cjs
 */
const LOCAL_DATA = process.env.LIFEKIT_LOCAL_DATA || '';
const CLOUD = process.env.LIFEKIT_CLOUD || '';
const ADMIN_PASSWORD = process.env.LIFEKIT_ADMIN_PASSWORD || '';
if (!LOCAL_DATA || !CLOUD || !ADMIN_PASSWORD) {
  console.error('  × 需要 LIFEKIT_LOCAL_DATA / LIFEKIT_CLOUD / LIFEKIT_ADMIN_PASSWORD 三个环境变量');
  process.exit(1);
}
const ADMIN = 'Basic ' + Buffer.from(`admin:${ADMIN_PASSWORD}`).toString('base64');

const CHECK_ONLY = process.argv.includes('--check');

/**
 * ⚠️ 本地 data.json 是 **UTF-8 带中文**的。
 *    必须按 utf8 读 —— 用 PowerShell 读会乱码（踩过）。
 */
function readLocal() {
  if (!fs.existsSync(LOCAL_DATA)) {
    console.error(`  × 找不到本地数据文件：${LOCAL_DATA}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(LOCAL_DATA, 'utf8');
  const j = JSON.parse(raw);
  return j.users ?? {};
}

async function getCloud(studentId) {
  const r = await fetch(`${CLOUD}/api/auth-state?studentId=${studentId}`);
  return r.json();
}

async function getCloudUsers() {
  const r = await fetch(`${CLOUD}/api/users`, { headers: { Authorization: ADMIN } });
  const j = await r.json();
  /** { studentId: userRecord } */
  const map = {};
  for (const u of j.users ?? []) map[u.studentId] = u;
  return map;
}

async function issue(studentId, studentName) {
  const r = await fetch(`${CLOUD}/api/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: ADMIN },
    body: JSON.stringify({ studentId, studentName }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
  console.log('');
  console.log('  ══════════════════════════════════════════════');
  console.log('   本地（桌面后台）授权码 → 同步到云端');
  console.log('  ══════════════════════════════════════════════');
  console.log('');

  const local = readLocal();
  const cloud = await getCloudUsers();

  const localIds = Object.keys(local);
  console.log(`  本地 ${localIds.length} 个学号，云端 ${Object.keys(cloud).length} 个学号`);
  console.log('');

  let needFix = 0;
  let fixed = 0;
  let failed = 0;

  for (const sid of localIds) {
    const lu = local[sid];
    const cu = cloud[sid];
    const localCode = String(lu.code ?? '');
    const cloudCode = String(cu?.code ?? '');

    const missing = !cu;
    const noCode = !cloudCode;
    const different = cu && cloudCode && localCode && cloudCode !== localCode;

    if (!missing && !noCode && !different) {
      console.log(`  √ ${sid.padEnd(15)} 云端已有且一致`);
      continue;
    }

    needFix += 1;
    const why = missing ? '云端没有这个学号' : noCode ? '云端没有码' : '两边码不一致';
    console.log(`  ⚠️ ${sid.padEnd(15)} ${why}`);
    console.log(`       本地码：${localCode}`);
    if (different) console.log(`       云端码：${cloudCode}`);

    if (CHECK_ONLY) continue;

    /**
     * ⚠️ 用 issue —— 它会为这个学号签发/复用一份云端码。
     *
     * ★★★ 关键发现：`generateLicenseCode` 是**确定性**的
     *     （同一学号 + 同一有效期 → **完全相同的码**）。
     *     所以云端签发出来的**和本地那份一模一样**，
     *     同学**不需要换码**，填原来那份就能过。
     *
     *     ⚠️ 我第一版在这里写了"本地那份在云端不认"——
     *       那是**错的**（我没先验证确定性就下结论）。
     *        验证工具：tools/check-code-determinism.cjs
     */
    const r = await issue(sid, String(lu.studentName ?? ''));
    if (r.status === 200 && r.body?.ok && r.body?.code) {
      fixed += 1;
      const same = r.body.code === localCode;
      console.log(`  ✅ ${sid.padEnd(15)} 云端已登记：${r.body.code}`);
      console.log(
        same
          ? '       ★ 与本地那份**完全一致** → 对方**不用换码**'
          : '       ⚠️ 与本地那份不同（有效期可能不一样）→ 请把云端这个发给他',
      );
    } else {
      failed += 1;
      console.log(`  ❌ ${sid.padEnd(15)} 签发失败：HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
    }
  }

  console.log('');
  console.log('  ══════════════════════════════════════════════');
  if (CHECK_ONLY) {
    console.log(`  检查完成：${needFix} 个学号需要同步（未做任何修改）`);
  } else {
    console.log(`  结果：需要修 ${needFix} 个，成功 ${fixed} 个，失败 ${failed} 个`);
  }
  console.log('  ══════════════════════════════════════════════');
  console.log('');
  console.log('  ⚠️ 重要提醒：以后**直接在这个地址生成码**，别用本机那个 ——');
  console.log(`     云端管理后台：${CLOUD}/admin   （口令见你设的 LIFEKIT_ADMIN_PASSWORD）`);
  console.log('     本机那个改的是**本地**数据，手机连云端看不到。');
  console.log('');
})();

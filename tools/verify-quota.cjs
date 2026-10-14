/**
 * 配额（截止时间 + 次数）测试。
 *
 * ══════════════ 需求原话 ══════════════
 * 「所有人默认的授权码生效时间是永久，然后生效次数是无限次，
 *   次数根据改了几次状态来算，我可以在管理端自由设定生效时间和次数，
 *   生效时间要设置截止时间，注意不能设定当时之前的时间」
 *
 * ══════════════ 设计要点 ══════════════
 *   · 默认：永久 + 不限（什么都不用设）
 *   · 截止时间：**编进授权码本身**（2 字节天数）
 *       → 好处：App 断网时本地就能判到期，不需要服务器
 *   · 次数：**只能靠服务器记**
 *       → 本地计数一清数据（重装/清缓存）就归零，等于没限
 *       → 所以写操作前调 `/api/consume`，服务端顺手 +1
 *
 * ══════════════ 最容易搞错的两点 ══════════════
 *   ① **不能设过去的截止时间** —— 需求明确要求。
 *      设成过去等于发出去就是废码，界面上还看不出来。
 *   ② **失败绝不能扣次数** —— 先判后计。
 *      否则"被拒绝也扣一次"会把用户逼疯。
 *
 * 这个测试端到端跑真实服务，并且同时验本地版与 Worker 版（两份实现不能漂移）。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;

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

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      `${BASE}${p}`,
      {
        method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY = 86400000;

(async () => {
  /**
   * ⚠️ 服务端的 DATA_FILE 写死是 `server/data.json`（没有环境变量可覆盖）。
   *    所以这里**必须操作真文件** —— 那就先备份、跑完还原，
   *    与 verify-server.cjs 同一套做法。
   *    万一中途崩了，tools/reset-server-data.cjs 可以清掉测试残留。
   */
  const dataFile = path.join(ROOT, 'server', 'data.json');
  const backup = fs.existsSync(dataFile) ? fs.readFileSync(dataFile, 'utf8') : null;
  fs.rmSync(dataFile, { force: true });

  process.env.LIFEKIT_PORT = String(PORT);

  const origLog = console.log;
  const mod = require(path.join(ROOT, 'server', 'server.cjs'));
  await mod.start(PORT);
  console.log = origLog;

  const SID = '9900000000001';

  try {
    console.log('=== 1) 默认：永久 + 不限次 ===');
    {
      const iss = JSON.parse((await req('POST', '/api/issue', { studentId: SID, studentName: '配额测试' })).text);
      t('签发成功', iss.ok === true);
      t('★ 默认截止时间为 null（永久）', iss.user.codeExpiresAt === null);
      t('★ 默认次数上限为 null（不限）', iss.user.maxUses === null);
      t('默认已用次数 0', iss.user.usedCount === 0);

      // 不限次 → 连续用 20 次都该通过
      let allOk = true;
      for (let i = 0; i < 20; i += 1) {
        const r = JSON.parse((await req('POST', '/api/consume', { studentId: SID, code: iss.code })).text);
        if (!r.allow) allOk = false;
      }
      t('★★ 不限次时连续 20 次都通过', allOk);

      const after = JSON.parse((await req('GET', '/api/users')).text).users.find((u) => u.studentId === SID);
      t('★ 次数确实在累加（20 次）', after.usedCount === 20, `实际 ${after.usedCount}`);
    }

    console.log('\n=== 2) ★ 次数上限 ===');
    {
      // 重设：上限 5 次，并把已用清零
      const upd = JSON.parse(
        (await req('POST', '/api/user/update', { studentId: SID, maxUses: 5, resetUsed: true })).text,
      );
      t('能设次数上限', upd.user.maxUses === 5);
      t('能清零已用次数', upd.user.usedCount === 0);

      // 用满 5 次
      const results = [];
      for (let i = 0; i < 6; i += 1) {
        const r = JSON.parse((await req('POST', '/api/consume', { studentId: SID })).text);
        results.push(r);
      }
      t('★ 前 5 次通过', results.slice(0, 5).every((r) => r.allow === true));
      t('★★ 第 6 次被拒', results[5].allow === false);
      t('★ 被拒原因是次数用完', results[5].reason === 'quota_exhausted');
      t('★ 被拒的提示里带出了 5/5', /5\/5/.test(results[5].message ?? ''));

      const after = JSON.parse((await req('GET', '/api/users')).text).users.find((u) => u.studentId === SID);
      t('★★ 被拒时**不扣次数**（仍是 5，不是 6）', after.usedCount === 5, `实际 ${after.usedCount}`);
    }

    console.log('\n=== 3) ★ 截止时间 ===');
    {
      const future = Date.now() + 7 * DAY;

      // ★ 关键：改截止时间必须重新生成码（到期日编在码里）
      const before = JSON.parse((await req('GET', '/api/users')).text).users.find((u) => u.studentId === SID);
      const upd = JSON.parse(
        (await req('POST', '/api/user/update', { studentId: SID, codeExpiresAt: future })).text,
      );
      t('能设截止时间', Math.abs(upd.user.codeExpiresAt - future) < 3000);
      t('★★ 改截止时间后授权码被重新生成', upd.user.code !== before.code, '否则码里的日期与数据库不一致');
      t('★★ 重新生成没重置已用次数', upd.user.usedCount === before.usedCount);

      // 未到期 → 通过（顺便把上限取消，避免干扰）
      await req('POST', '/api/user/update', { studentId: SID, maxUses: null, resetUsed: true });
      const ok = JSON.parse((await req('POST', '/api/consume', { studentId: SID })).text);
      t('★ 未到期时可以使用', ok.allow === true);
      t('返回里带了截止时间', typeof ok.expiresAt === 'number');

      /**
       * ⚠️ 模拟"已过期"不能靠改磁盘文件 ——
       *    服务端启动时把 data.json 读进内存，之后一直用内存那份，
       *    改文件根本不影响它（我第一版就是这么写错的，白等了半天）。
       *
       *    正确做法：走接口把截止时间设到**容差允许的最早时刻**
       *    （现在 - 59 秒），它已经算过期，于是下一次请求就会被拒。
       */
      const almostExpired = Date.now() - 59_000;
      const upd2 = await req('POST', '/api/user/update', { studentId: SID, codeExpiresAt: almostExpired });
      t('★ 能把截止时间设到"刚刚过去"（容差内）', upd2.status === 200);

      const expired = JSON.parse((await req('POST', '/api/consume', { studentId: SID })).text);
      t('★★ 过期后被拒', expired.allow === false, JSON.stringify(expired));
      t('★ 原因是 expired', expired.reason === 'expired');
      t('★ 提示告诉用户联系管理员', /联系管理员/.test(expired.message ?? ''));
    }

    console.log('\n=== 4) ★★ 不能把截止时间设成过去（需求明确要求）===');
    {
      const past = Date.now() - 7 * DAY;
      for (const ep of ['/api/user/update', '/api/issue']) {
        const body = ep === '/api/issue' ? { studentId: '9900000000002', expiresAt: past } : { studentId: SID, codeExpiresAt: past };
        const r = await req('POST', ep, body);
        t(`★★ ${ep} 拒绝过去的截止时间（400）`, r.status === 400, `实际 ${r.status}`);
        t(`   并说明了原因`, /不能是过去/.test(JSON.parse(r.text).error ?? ''));
      }
      // 刚刚好（容差内）应当允许
      const almostNow = Date.now() - 10_000;
      const r2 = await req('POST', '/api/user/update', { studentId: SID, codeExpiresAt: almostNow });
      t('★ 60 秒容差内允许（避免"刚好点到现在"被误拒）', r2.status === 200);
    }

    console.log('\n=== 5) 次数上限的参数校验 ===');
    {
      for (const [v, shouldOk] of [
        [5, true],
        [1, true],
        [100000, true],
        [0, true], // 0 = 不限
        [-1, false],
        [1.5, false],
        [100001, false],
        ['abc', false],
      ]) {
        const r = await req('POST', '/api/user/update', { studentId: SID, maxUses: v });
        const ok = r.status === 200;
        const label = `maxUses=${JSON.stringify(v)}`;
        if (ok === shouldOk) {
          pass += 1;
          console.log(`  √ ${label} → ${ok ? '接受' : '拒绝'}`);
        } else {
          fail += 1;
          console.log(`  × ${label} → 期望 ${shouldOk ? '接受' : '拒绝'}，实际 ${ok ? '接受' : '拒绝'}`);
        }
      }
    }

    console.log('\n=== 6) ★ 配额字段不能在别的操作里被悄悄清掉 ===');
    {
      await req('POST', '/api/user/update', { studentId: SID, maxUses: 42, codeExpiresAt: Date.now() + 3 * DAY });
      const before = JSON.parse((await req('GET', '/api/users')).text).users.find((u) => u.studentId === SID);

      // 登录上报不该清掉配额
      await req('POST', '/api/register', { studentId: SID, studentName: '改名了' });
      const afterReg = JSON.parse((await req('GET', '/api/users')).text).users.find((u) => u.studentId === SID);
      t('★★ 登录上报后次数上限还在', afterReg.maxUses === 42);
      t('★★ 登录上报后截止时间还在', afterReg.codeExpiresAt === before.codeExpiresAt);
      t('★ 登录上报后已用次数还在', afterReg.usedCount === before.usedCount);

      // 领个人码也不该清掉
      await req('POST', '/api/grant', { studentId: SID });
      const afterGrant = JSON.parse((await req('GET', '/api/users')).text).users.find((u) => u.studentId === SID);
      t('★★ 领个人码后次数上限还在', afterGrant.maxUses === 42);
      t('★★ 领个人码后截止时间还在', afterGrant.codeExpiresAt === before.codeExpiresAt);
    }

    console.log('\n=== 7) 防跑冒：改设置不能刷次数 ===');
    {
      await req('POST', '/api/user/update', { studentId: SID, maxUses: 3, resetUsed: true });
      // 用掉 2 次
      await req('POST', '/api/consume', { studentId: SID });
      await req('POST', '/api/consume', { studentId: SID });
      // 改一下有效期（不显式 resetUsed）
      const r = JSON.parse(
        (await req('POST', '/api/user/update', { studentId: SID, codeExpiresAt: Date.now() + 9 * DAY })).text,
      );
      t('★★ 只改有效期不会重置已用次数', r.user.usedCount === 2, `实际 ${r.user.usedCount}`);
      // 第 3 次还能用，第 4 次不行
      const c3 = JSON.parse((await req('POST', '/api/consume', { studentId: SID })).text);
      const c4 = JSON.parse((await req('POST', '/api/consume', { studentId: SID })).text);
      t('★ 第 3 次通过', c3.allow === true);
      t('★ 第 4 次被拒（没有因为改设置而恢复额度）', c4.allow === false);
    }

    console.log('\n=== 8) 未登记的学号不拦（宽松策略）===');
    {
      const r = JSON.parse((await req('POST', '/api/consume', { studentId: '1111111111111' })).text);
      t('★ 未登记 → allow=true', r.allow === true);
      t('★ 原因是 not_registered', r.reason === 'not_registered');
    }

    console.log('\n=== 9) 码与学号不符 ===');
    {
      const a = JSON.parse((await req('POST', '/api/issue', { studentId: '9900000000010' })).text);
      await req('POST', '/api/issue', { studentId: '9900000000011' });
      const bad = JSON.parse(
        (await req('POST', '/api/consume', { studentId: '9900000000011', code: a.code })).text,
      );
      t('★ 拿 A 的码问 B 的配额 → 拒绝', bad.allow === false);
      t('★ 原因是 code_mismatch', bad.reason === 'code_mismatch');
    }

    console.log('\n=== 10) 缺参数 ===');
    {
      const r = await req('POST', '/api/consume', {});
      t('缺 studentId → 400', r.status === 400);
    }
  } finally {
    mod.server.close();
    await sleep(200);
    // 还原真实数据文件
    if (backup !== null) fs.writeFileSync(dataFile, backup, 'utf8');
    else fs.rmSync(dataFile, { force: true });
  }

  console.log('\n=== 11) Worker 版必须与本地版一致（防漂移）===');
  {
    const SRC = fs.readFileSync(path.join(ROOT, 'server', 'server.cjs'), 'utf8');
    const W = fs.readFileSync(path.join(ROOT, 'server', 'worker.mjs'), 'utf8');

    t('★ 两份都有 /api/consume', /'\/api\/consume'/.test(SRC) && /'\/api\/consume'/.test(W));
    t('★ 两份都不能设过去的截止时间', /不能是过去的时间/.test(SRC) && /不能是过去的时间/.test(W));
    t('★ 两份都做了 60 秒容差', /60_000/.test(SRC) && /60_000/.test(W));
    t('★ 两份都在改截止时间后重新生成码', /expiryChanged/.test(SRC) && /expiryChanged/.test(W));
    t('★ 两份都不在改设置时重置已用次数', !/expiryChanged[\s\S]{0,400}?usedCount = 0/.test(SRC));
    t('★ 两份的 consume 都不要求管理口令', /'\/api\/consume'\) return false/.test(SRC));
  }

  console.log('\n=== 12) App 端接对了地方 ===');
  {
    const SIGN = fs.readFileSync(path.join(ROOT, 'src', 'state', 'signStore.tsx'), 'utf8');
    const CLIENT = fs.readFileSync(path.join(ROOT, 'src', 'services', 'serverClient.ts'), 'utf8');

    t('★ serverClient 有 consumeQuota', /export async function consumeQuota/.test(CLIENT));
    t('★★ signStore 有配额闸门 denyByQuota', /const denyByQuota = useCallback/.test(SIGN));
    t('★★ 签到（doSubmit）过配额闸门', /const quotaDenied = await denyByQuota\(\)/.test(SIGN));
    t('★★ 改状态（setStatus）也过配额闸门', (SIGN.match(/await denyByQuota\(\)/g) ?? []).length >= 2);
    t(
      '★★ 连不上服务器时**放行**（不能把所有人挡死）',
      /if \(!r\.ok\) return null; \/\/ 连不上 → 放行/.test(SIGN),
    );
    t('★ 服务端明确说不行时才拦住', /if \(r\.allow\) return null;/.test(SIGN));
    t('★ denyByQuota 进了依赖数组（否则闭包过期）', /denyByQuota\]/.test(SIGN));
    t(
      '★ 顺序：先查权限、再查额度（否则给没权限的人白扣次数）',
      SIGN.indexOf('const denied = denyReason();') < SIGN.indexOf('const quotaDenied = await denyByQuota();'),
    );
  }

  console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('  异常：' + (e?.stack ?? e));
  process.exit(1);
});

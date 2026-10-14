/**
 * 验证「万能码被 /api/consume 误判为 code_mismatch」的修复。
 *
 * ══════════════ 用户反馈的原始现象（2026-10）══════════════
 *
 *   用**万能码**改签到状态 → 弹窗报「这个授权码不属于当前学号」
 *   而设置页显示「万能码 · 长期有效 · 可用」
 *
 * ══════════════ 根因 ══════════════
 *
 *   server.cjs 的 /api/consume 里有这段：
 *
 *     if (code) {
 *       const u = db.users[studentId];
 *       if (u?.code && u.code !== code) → code_mismatch
 *     }
 *
 *   它要求"传上来的码必须等于**服务器给这个学号发的那份个人码**"。
 *   于是万能码（不等于任何个人码）**永远过不去** —— 漏了万能码分支。
 *
 * 修法：先 `verifyMasterCode(db, code)`，是万能码就放行。
 *
 * ══════════════ 这个测试怎么验 ══════════════
 *
 *   起一个隔离实例（独立端口 + 独立数据文件），然后真的打 /api/consume：
 *     ① 万能码        → **必须 allow**
 *     ② 该学号的个人码 → 必须 allow
 *     ③ 别人的码      → 必须 code_mismatch（原来的保护不能丢）
 *
 * 用法: node tools/verify-consume-master.cjs
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8931;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, 'server', '_consume-test-data.json');

/** 测试用的最小数据：一个学号 + 它的个人码 + 别的学号 */
const FIXTURE = {
  masterCodeHash: null, // 下面算
  users: {
    '2099000000116': { studentId: '2099000000116', studentName: '同学A', code: 'LK1-MINE-00000-00000-00000-00000-0000', authorized: true, loginCount: 0, usedCount: 0, maxUses: 0, expiresAt: null },
    '2099000000124': { studentId: '2099000000124', studentName: 'L', code: 'LK1-OTHER-11111-11111-11111-11111-1111', authorized: true, loginCount: 0, usedCount: 0, maxUses: 0, expiresAt: null },
  },
};

/** 跟 server.cjs 里一致的 FNV-1a 双种子哈希 */
function hashMasterCode(code) {
  const s = String(code ?? '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
  const fnv = (seed) => {
    let h = seed >>> 0;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  };
  return `fnv1a2:${fnv(0x811c9dc5).toString(16).padStart(8, '0')}${fnv(0x9e3779b9).toString(16).padStart(8, '0')}`;
}

/**
 * ⚠️ 公开仓库版（2026-10）：
 *   · 夹具里的万能码原先写死真实值 → 改成中性测试值（验的是"万能码放行"这条逻辑）
 *   · 学号原先用的是**真实学号** → 换成 99000 开头的**假学号**
 *     （真实学号属于他人个人信息，不进公开仓库）
 */
const FIXTURE_MASTER_CODE = 'testcode123';
FIXTURE.masterCodeHash = hashMasterCode(FIXTURE_MASTER_CODE);
fs.writeFileSync(DATA, JSON.stringify(FIXTURE, null, 2), 'utf8');

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

async function consume(studentId, code) {
  const r = await fetch(`${BASE}/api/consume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId, code }),
  });
  return { status: r.status, body: await r.json() };
}

(async () => {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.cjs')], {
    env: { ...process.env, LIFEKIT_PORT: String(PORT), LIFEKIT_DATA_FILE: DATA },
    stdio: 'ignore',
  });

  /** 等端口就绪 */
  let ready = false;
  for (let i = 0; i < 40 && !ready; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const r = await fetch(`${BASE}/api/version`);
      ready = r.ok;
    } catch {
      ready = false;
    }
  }

  try {
    if (!ready) {
      console.log('  × 隔离实例没起来');
      process.exit(1);
    }
    console.log('  √ 隔离测试实例已就绪\n');

    /**
     * ⚠️ 这两个学号必须和上面 FIXTURE.users 的 key **完全一致**。
     *    批量匿名化时踩过：换了 key 却没换这里 → `users[ME]` 变成 undefined
     *    → 后面 `.code` 直接崩（TypeError）。
     */
    const ME = '2099000000116';
    const MY_CODE = FIXTURE.users[ME].code;
    const OTHER_CODE = FIXTURE.users['2099000000124'].code;

    console.log('=== ① ★★★ 万能码必须放行（这就是那个 bug）===');
    {
      const r = await consume(ME, FIXTURE_MASTER_CODE);
      t('★★★ 万能码不再被判 code_mismatch', r.body.reason !== 'code_mismatch', JSON.stringify(r.body));
      t('★★★ 万能码 allow === true', r.body.allow === true, JSON.stringify(r.body));
    }

    console.log('\n=== ② 自己的个人码仍然放行 ===');
    {
      const r = await consume(ME, MY_CODE);
      t('★★ 个人码 allow === true', r.body.allow === true, JSON.stringify(r.body));
    }

    console.log('\n=== ③ 别人的码仍然被拦（原来的保护不能丢）===');
    {
      const r = await consume(ME, OTHER_CODE);
      t('★★★ 别人的码 → code_mismatch', r.body.reason === 'code_mismatch', JSON.stringify(r.body));
      t('★★★ 别人的码 allow === false', r.body.allow === false);
    }

    console.log('\n=== ④ 不带码也能用（限额按学号算）===');
    {
      const r = await consume(ME, '');
      t('★★ 不带码 allow === true', r.body.allow === true, JSON.stringify(r.body));
    }
  } finally {
    child.kill();
    try {
      fs.unlinkSync(DATA);
    } catch {
      /* 删不掉也无所谓 */
    }
  }

  console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();

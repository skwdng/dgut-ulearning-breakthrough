/**
 * Cloudflare Worker 版服务端的测试。
 *
 * ══════════ 为什么必须测 ══════════
 * Worker 是**另一份实现**（不能直接 require server.cjs，因为运行环境不同）。
 * 两份实现最容易出的问题：
 *   ① 授权码算法漂移 → 云端签发的码在 App 里报"无效"
 *   ② 保护范围不一致 → 要么管理页没保护，要么把 App 接口也挡了
 *   ③ 中文放进 HTTP 头 → Worker 直接抛异常（本地版踩过这个坑）
 *
 * 所以这里用假 KV + 假的 Request/Response 把 Worker 跑起来，
 * 逐条验证与本地版行为一致。
 */
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.resolve(__dirname, '..', 'server', 'worker.mjs'), 'utf8');

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

// ────────────────────────────── 把 Worker 跑起来（浏览器/Node 都能用的最小 shim）

/** 极简 KV（内存版） */
function makeKV() {
  const m = new Map();
  return {
    async get(k) {
      return m.has(k) ? m.get(k) : null;
    },
    async put(k, v) {
      m.set(k, v);
    },
    _dump: () => new Map(m),
  };
}

/** Worker 的 ESM 源码在 Node 里可以直接 import（用了标准 Response/Request） */
async function loadWorker() {
  // ⚠️ 用 .mjs：仓库没设 "type": "module"，.js 会被当成 CommonJS，
  //    Node 得"重新解析一遍"，既慢又会打警告。Cloudflare 也认 .mjs。
  const url = `file://${path.resolve(__dirname, '..', 'server', 'worker.mjs').replace(/\\/g, '/')}`;
  const mod = await import(url);
  return mod.default;
}

function makeEnv() {
  return { LIFEKIT_KV: makeKV() };
}

/** 发一个请求给 Worker */
async function call(worker, env, pathname, { method = 'GET', body, auth } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    headers.Authorization = `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString('base64')}`;
  }
  const req = new Request(`https://example.workers.dev${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await worker.fetch(req, env);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 不是 JSON */
  }
  return { status: res.status, text, json, wwwAuth: res.headers.get('www-authenticate') };
}

// ────────────────────────────── 复刻 App 的校验（与 licenseCode.ts 同算法）

const B32 = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function hashStudentId(studentId) {
  const s = String(studentId ?? '').replace(/\s+/g, '').toLowerCase();
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

function hexBytes(hex) {
  const o = [];
  for (let i = 0; i + 1 < hex.length; i += 2) o.push(parseInt(hex.slice(i, i + 2), 16));
  return o;
}

function verifyLikeApp(code, studentId) {
  const raw = String(code ?? '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
  if (!raw.startsWith('LK1')) return 'prefix';
  const body = raw.slice(3);
  if (body.length !== 28) return 'length';
  const payload = body.slice(0, 13);
  const head = toBase32([...hexBytes(hashStudentId(studentId)).slice(0, 6), 0, 0]).slice(0, 10);
  if (!payload.startsWith(head)) return 'studentIdHash';
  return null;
}

// ────────────────────────────── 开始

(async () => {
  const worker = await loadWorker();

  console.log('=== 1) 没绑定 KV 时给出能看懂的提示（不是 500 空页）===');
  {
    const r = await call(worker, {}, '/api/ping');
    t('返回 500', r.status === 500);
    t('★ 提示里说明了要绑 LIFEKIT_KV', /LIFEKIT_KV/.test(r.json?.error ?? ''));
  }

  const env = makeEnv();

  console.log('\n=== 2) 基本接口 ===');
  {
    const r = await call(worker, env, '/api/ping');
    t('ping 通', r.status === 200 && r.json?.ok === true);
    t('标记为云端', r.json?.cloud === true);
    t('★ 地址提示为云端', /云端/.test(JSON.stringify(r.json?.addressesDetail ?? [])));

    const page = await call(worker, env, '/admin');
    t('管理页可访问', page.status === 200);
    t('管理页含生成授权码', page.text.includes('生成授权码'));
    t('管理页含管理口令', page.text.includes('管理口令'));
  }

  console.log('\n=== 3) ★ 云端签发的码必须能被 App 算法通过 ===');
  {
    const SIDS = ['2099000000109', '2099000000114', '2099000000116'];
    for (const sid of SIDS) {
      const r = await call(worker, env, '/api/issue', { method: 'POST', body: { studentId: sid } });
      const why = verifyLikeApp(r.json?.code, sid);
      t(`学号 ${sid} 的码通过 App 校验`, why === null, why ?? '');
    }

    const a = await call(worker, env, '/api/issue', { method: 'POST', body: { studentId: '9000000000001' } });
    const why2 = verifyLikeApp(a.json?.code, '9000000000002');
    t('★ 换学号校验失败（不能转借）', why2 === 'studentIdHash', why2 ?? '（竟然通过）');

    const again = await call(worker, env, '/api/issue', { method: 'POST', body: { studentId: '9000000000001' } });
    t('★ 重复签发复用同一份码', again.json?.code === a.json?.code && again.json?.reused === true);
  }

  /**
   * ★ 万能码：只校验，不回传明文（与本地版一致的安全性改造）
   *   断言从"能读到明文"改成"读不到明文且校验正确"。
   */
  console.log('\n=== 4) 万能码：只校验，不回传明文 ===');
  {
    const before = await call(worker, env, '/api/master');
    t('★★ GET /api/master 不回传明文', !before.json?.masterCode, JSON.stringify(before.json?.masterCode));
    t('只回"有没有设置"', before.json?.hasMasterCode === true);

    /**
     * ⚠️ 公开仓库版（2026-10）：默认码不再写死，从环境变量取
     *    （Worker 侧读的是 `LIFEKIT_MASTER_CODE`）。
     */
    const DEFAULT_CODE = process.env.LIFEKIT_MASTER_CODE || 'CHANGE_ME';

    const vDefault = await call(worker, env, '/api/verify-master', { method: 'POST', body: { code: DEFAULT_CODE } });
    t('★ 默认万能码校验通过', vDefault.json?.valid === true);

    const vWrong = await call(worker, env, '/api/verify-master', { method: 'POST', body: { code: 'wrongcode' } });
    t('★ 错误码校验失败', vWrong.json?.valid === false);
    t('★★ 失败响应里不含万能码', !JSON.stringify(vWrong.json).includes(DEFAULT_CODE));

    const ch = await call(worker, env, '/api/master', { method: 'POST', body: { masterCode: 'cloudtest1' } });
    t('★ 改码的响应不回显新码', ch.json?.masterCode === undefined && ch.json?.updated === true);
    const after = await call(worker, env, '/api/master');
    t('★ 改完仍读不到明文', !after.json?.masterCode);

    const vNew = await call(worker, env, '/api/verify-master', { method: 'POST', body: { code: 'cloudtest1' } });
    t('★★ 改完立刻生效：新码通过（KV 持久化）', vNew.json?.valid === true);

    const bad = await call(worker, env, '/api/master', { method: 'POST', body: { masterCode: '有中文' } });
    t('非字母数字被拒', bad.status === 400);

    await call(worker, env, '/api/master', { method: 'POST', body: { masterCode: DEFAULT_CODE } });
  }

  console.log('\n=== 5) 登录上报 / 列表 / 改 / 删 ===');
  {
    const reg = await call(worker, env, '/api/register', {
      method: 'POST',
      body: { studentId: '9000000000011', studentName: '云端测试' },
    });
    t('能上报', reg.json?.user?.studentId === '9000000000011');
    t('默认已授权', reg.json?.user?.authorized === true);
    t('次数 1', reg.json?.user?.loginCount === 1);

    const reg2 = await call(worker, env, '/api/register', { method: 'POST', body: { studentId: '9000000000011' } });
    t('重复登录累加', reg2.json?.user?.loginCount === 2);
    t('空姓名不覆盖', reg2.json?.user?.studentName === '云端测试');

    const list = await call(worker, env, '/api/users');
    t('列表能读到', (list.json?.users ?? []).some((u) => u.studentId === '9000000000011'));

    const upd = await call(worker, env, '/api/user/update', {
      method: 'POST',
      body: { studentId: '9000000000011', authorized: false },
    });
    t('★ 能关掉授权', upd.json?.user?.authorized === false);

    const del = await call(worker, env, '/api/user/delete', { method: 'POST', body: { studentId: '9000000000011' } });
    t('能删除', del.json?.ok === true);
  }

  console.log('\n=== 6) ★ 管理口令 ===');
  {
    const AUTH = { user: 'admin', pass: 'cloudpw123' };

    const before = await call(worker, env, '/admin');
    t('未启用口令时管理页可访问', before.status === 200);

    const set = await call(worker, env, '/api/admin/password', { method: 'POST', body: { password: AUTH.pass } });
    t('首次设置成功', set.json?.enabled === true);

    const noAuth = await call(worker, env, '/admin');
    t('★ 无凭据 → 401', noAuth.status === 401);
    t('★ 带 WWW-Authenticate', /Basic/.test(noAuth.wwwAuth ?? ''));
    t('★ 头里只有 ASCII（中文会让 Worker 抛异常）', !/[^\x00-\x7F]/.test(noAuth.wwwAuth ?? ''));

    const bad = await call(worker, env, '/admin', { auth: { user: 'admin', pass: 'wrong' } });
    t('口令错 → 401', bad.status === 401);

    const ok = await call(worker, env, '/admin', { auth: AUTH });
    t('凭据正确 → 200', ok.status === 200);

    // 管理接口受保护
    for (const [m, p, b] of [
      ['GET', '/api/users', undefined],
      ['POST', '/api/master', { masterCode: 'hacked' }],
      ['POST', '/api/issue', { studentId: '9000000000099' }],
      ['GET', '/api/export', undefined],
    ]) {
      const r = await call(worker, env, p, { method: m, body: b });
      t(`★ ${m} ${p} 无凭据被拒`, r.status === 401);
    }

    // ★ App 接口不受影响
    for (const [m, p, b] of [
      ['GET', '/api/ping', undefined],
      ['GET', '/api/master', undefined],
      ['POST', '/api/register', { studentId: '9000000000012' }],
      ['POST', '/api/grant', { studentId: '9000000000012' }],
      ['GET', '/api/auth-state?studentId=9000000000012', undefined],
    ]) {
      const r = await call(worker, env, p, { method: m, body: b });
      t(`√ App 接口 ${m} ${p.split('?')[0]} 不受影响`, r.status === 200);
    }

    /**
     * ★★ 口令启用后，App 仍必须能查到授权状态。
     * （云端与本地两份实现都要满足 —— 否则"远程关人"会静默失效）
     */
    {
      const st = await call(worker, env, '/api/auth-state?studentId=9000000000012');
      t('★★ 口令启用后 /api/auth-state 不带凭据仍可访问', st.status === 200);
      t('★★ 能拿到授权状态且为 true', st.json?.authorized === true);

      await call(worker, env, '/api/user/update', {
        method: 'POST',
        body: { studentId: '9000000000012', authorized: false },
        auth: AUTH,
      });
      const st2 = await call(worker, env, '/api/auth-state?studentId=9000000000012');
      t('★★ 关掉授权后能查到 authorized=false', st2.json?.authorized === false);

      const st3 = await call(worker, env, '/api/auth-state?studentId=1111111111111');
      t('★ 未登记学号不当作被拒', st3.json?.authorized === true);
      t('未登记时 known=false', st3.json?.known === false);

      const st4 = await call(worker, env, '/api/auth-state');
      t('缺 studentId → 400', st4.status === 400);
    }

    const mc = await call(worker, env, '/api/master');
    t('★ 未授权者没能改掉万能码', mc.json?.masterCode !== 'hacked');

    // 清理
    await call(worker, env, '/api/admin/password', { method: 'POST', body: { password: '' }, auth: AUTH });
    const after = await call(worker, env, '/admin');
    t('关闭口令后恢复可访问', after.status === 200);
  }

  console.log('\n=== 7) 边界 ===');
  {
    const r404 = await call(worker, env, '/api/nope');
    t('未知接口 404', r404.status === 404);

    const bad = await call(worker, env, '/api/issue', { method: 'POST', body: {} });
    t('缺学号 400', bad.status === 400);

    const badChars = await call(worker, env, '/api/issue', { method: 'POST', body: { studentId: '中文' } });
    t('非法学号 400', badChars.status === 400);

    const missing = await call(worker, env, '/api/user/update', { method: 'POST', body: { studentId: 'x' } });
    t('改不存在的用户 404', missing.status === 404);
  }

  console.log('\n=== 8) 与本地版算法一致性（关键）===');
  {
    /**
     * 两份实现（server/licenseCode.cjs 与 server/worker.mjs）必须产出**同样的码**。
     * 不一样的话，云端签发的码在 App 里会报"无效" ——
     * 而这种问题只表现为一句"授权码无效"，极难定位。
     */
    const local = require(path.resolve(__dirname, '..', 'server', 'licenseCode.cjs'));
    for (const sid of ['2099000000109', '2099000000114', 'abc123']) {
      const a = local.generateLicenseCode(sid);
      const r = await call(worker, env, '/api/issue', { method: 'POST', body: { studentId: sid } });
      // 取同一个学号的本地码做比对（注意 Worker 已存过就复用，值应完全一致）
      t(`学号 ${sid}：本地码 == 云端码`, a === r.json?.code, `\n     本地 ${a}\n     云端 ${r.json?.code}`);
    }
  }

  console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('  异常：' + (e?.stack ?? e?.message ?? e));
  process.exit(1);
});

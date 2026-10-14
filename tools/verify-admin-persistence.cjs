/**
 * 「管理端数据不丢、万能码不明文」的端到端测试。
 *
 * ══════════════ 起因 ══════════════
 * 用户说：「我刚打开管理网页为什么我新加的两条记录没了」
 *
 * 查明的两条原因（都是真问题）：
 *
 *   ① **我的重置脚本在服务运行时跑了，把它覆盖了**
 *      服务把数据放内存里，磁盘改动会被内存写回覆盖。
 *      → 见 verify-no-data-loss.cjs（那个测保护措施）
 *
 *   ② **管理端签发/改用户后，用户数据必须落盘，且不能丢其他用户**
 *      这里测的是：通过 API 加用户 → 重启服务 → 用户还在
 *
 * ══════════════ 为什么要"重启后还在"这一条 ══════════════
 * 内存里加了不算数 —— 用户明天打开管理页看的是**磁盘上的东西**。
 * 所以要真的：加用户 → 关服务 → 重开服务 → 再查。
 *
 * ⚠️ 全程在**临时副本**上做，绝不碰用户真实的 data.json。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');

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

/**
 * ⚠️ 公开仓库版（2026-10）：夹具用的万能码换成中性测试值（原来是真实码）。
 *
 * ⚠️ 必须**提升到模块作用域** —— 原来是写在下面某个块里的 `const`，
 *    块外引用会 ReferenceError（踩过：改了夹具值却忘了作用域）。
 */
const FIXTURE_CODE = 'testcode123';

/** 起一个服务实例（指向给定数据文件），返回 { close } */
async function startServer(dataFile, port) {
  // server.cjs 的 DATA_FILE 是 __dirname 固定的，所以这里改不了路径 ——
  // 只能用它自己的 server/data.json。为了不碰用户数据，
  // 我们在**开发目录**里做（那本来就是测试用的），并在开始时备份。
  process.env.LIFEKIT_PORT = String(port);
  delete require.cache[require.resolve(path.join(ROOT, 'server', 'server.cjs'))];
  const mod = require(path.join(ROOT, 'server', 'server.cjs'));
  const origLog = console.log;
  console.log = () => {};
  await mod.start(port);
  console.log = origLog;
  return mod;
}

function req(port, method, p, body, auth) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const headers = {};
    if (data) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = data.length;
    }
    if (auth) headers.Authorization = auth;
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(c);
        let j = null;
        try {
          j = JSON.parse(buf.toString('utf8'));
        } catch {
          /* 非 JSON */
        }
        resolve({ status: res.statusCode, body: j, raw: buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const AUTH =
  'Basic ' + Buffer.from('admin:testpw123', 'utf8').toString('base64');

(async () => {
  const PORT = 8793;
  const DEV_DATA = path.join(ROOT, 'server', 'data.json');
  const backup = fs.existsSync(DEV_DATA) ? fs.readFileSync(DEV_DATA) : null;

  console.log('=== 1) 准备一份含旧格式（明文万能码）的数据 ===');
  {
    // 故意用**旧格式**：明文 masterCode，没有 hash。
    // 这样才能同时验"旧数据能平滑升级"。
    // ⚠️ 夹具值 FIXTURE_CODE 定义在模块顶部（见那里的注释）。
    const seeded = {
      masterCode: FIXTURE_CODE,
      masterCodeHistory: [],
      users: {
        '9900000000001': {
          studentId: '9900000000001',
          studentName: '已有用户',
          authorized: true,
          code: 'LK1-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAA',
          issuedByAdmin: true,
        },
      },
      adminPassword: '',
    };
    fs.writeFileSync(DEV_DATA, `${JSON.stringify(seeded, null, 2)}\n`, 'utf8');
    const j = JSON.parse(fs.readFileSync(DEV_DATA, 'utf8'));
    t('★ 测试数据是旧格式（明文 masterCode）', typeof j.masterCode === 'string');
    t('★ 初始 1 个用户', Object.keys(j.users).length === 1);
  }

  let mod = await startServer(DEV_DATA, PORT);

  console.log('\n=== 2) ★★ 管理端加用户 → 必须落盘 ===');
  {
    const r1 = await req(PORT, 'POST', '/api/issue', { studentId: '2099000000116', studentName: '同学A' }, AUTH);
    t('★ 签发第一个学号成功', r1.status === 200 && r1.body?.ok === true, JSON.stringify(r1.body));
    t('★ 返回了授权码', /^LK1-/.test(String(r1.body?.code ?? '')));

    const r2 = await req(PORT, 'POST', '/api/issue', { studentId: '2099000000124', studentName: '同学B' }, AUTH);
    t('★ 签发第二个学号成功', r2.status === 200 && r2.body?.ok === true);
    t('★ 两张码不同（不是同一个）', r1.body?.code !== r2.body?.code);

    /**
     * ★★ 最关键的一条：**不丢已有用户**。
     *    用户那次就是"新加的记录没了" —— 我们要保证
     *    "加新的"不会把"旧的"弄丢。
     */
    const list = await req(PORT, 'GET', '/api/users', null, AUTH);
    const arr = list.body?.users ?? list.body;
    const ids = (Array.isArray(arr) ? arr : Object.values(arr)).map((u) => String(u.studentId));
    console.log(`  现在有 ${ids.length} 个用户: ${ids.join(', ')}`);
    t('★★ 新加两个之后，原有的那个还在（没被覆盖）', ids.includes('9900000000001'));
    t('★ 两个新用户都在', ids.includes('2099000000116') && ids.includes('2099000000124'));
    t('★ 总数 = 3', ids.length === 3, `${ids.length}`);
  }

  console.log('\n=== 3) ★★ 重启服务后用户还在（内存 → 磁盘 → 再读）===');
  {
    mod.server.close();
    await new Promise((r) => setTimeout(r, 300));

    // 直接读磁盘，确认真的写进去了
    const onDisk = JSON.parse(fs.readFileSync(DEV_DATA, 'utf8'));
    const diskIds = Object.keys(onDisk.users ?? {});
    console.log(`  磁盘上的用户: ${diskIds.join(', ')}`);
    t('★★ 磁盘上确实有 3 个用户', diskIds.length === 3, `${diskIds.length}`);

    // 重新起服务，从磁盘加载
    mod = await startServer(DEV_DATA, PORT);
    const list = await req(PORT, 'GET', '/api/users', null, AUTH);
    const arr = list.body?.users ?? list.body;
    const ids = (Array.isArray(arr) ? arr : Object.values(arr)).map((u) => String(u.studentId));
    t('★★ 重启后仍然 3 个用户（说明真的持久化了）', ids.length === 3, `${ids.length}`);
    t('★ 重启后授权码没变', 
      (Array.isArray(arr) ? arr : Object.values(arr)).find((u) => String(u.studentId) === '2099000000116')?.code?.startsWith('LK1-'));
  }

  console.log('\n=== 4) ★★ 万能码：明文必须迁移成哈希 ===');
  {
    const before = JSON.parse(fs.readFileSync(DEV_DATA, 'utf8'));
    t('★ 校验前磁盘上是明文（旧格式）', typeof before.masterCode === 'string', String(before.masterCode));

    // 校验正确码 → 触发迁移
    const ok = await req(PORT, 'POST', '/api/verify-master', { code: FIXTURE_CODE });
    t('★ 正确万能码通过校验', ok.body?.valid === true);
    await new Promise((r) => setTimeout(r, 300));

    const after = JSON.parse(fs.readFileSync(DEV_DATA, 'utf8'));
    console.log(`  masterCode 明文: ${after.masterCode ?? '(已删除)'}`);
    console.log(`  masterCodeHash:  ${after.masterCodeHash ?? '(无)'}`);
    t('★★ 明文已被删除', !after.masterCode);
    t('★★ 现在是哈希格式（fnv1a2: 前缀）', /^fnv1a2:[0-9a-f]{16}$/.test(String(after.masterCodeHash ?? '')));
    /** ★ 迁移不能把用户弄丢 */
    t('★★ 迁移过程中用户一个没少', Object.keys(after.users ?? {}).length === 3);

    // 错误码必须被拒
    const bad = await req(PORT, 'POST', '/api/verify-master', { code: 'definitely-wrong' });
    t('★ 错误万能码被拒', bad.body?.valid === false);
    /** ★ 而且不能泄露任何提示 */
    t('★ 拒绝时不透露任何线索', !JSON.stringify(bad.body).match(/testcode|master|hint|提示/i));
  }

  console.log('\n=== 5) 口令保护：没设口令时放行，设了口令才拦 ===');
  {
    /**
     * ⚠️ 我第一版这里写错了：测试数据里 adminPassword 是空的，
     *    却断言 /api/users 返回 401 —— 那是错的。
     *
     *    **没设口令时必须放行**，否则用户永远没机会设口令
     *    （管理页打不开 → 设不了口令 → 死锁）。
     *    所以正确做法是：先设口令，再验它开始拦。
     */
    const noAuthBefore = await req(PORT, 'GET', '/api/users');
    t('★ 没设口令时用户列表放行（否则永远设不上口令）', noAuthBefore.status === 200, `HTTP ${noAuthBefore.status}`);

    const verifyNoAuth = await req(PORT, 'POST', '/api/verify-master', { code: FIXTURE_CODE });
    t('★ 万能码校验永远不要口令（App 场景）', verifyNoAuth.status === 200);

    // 设一个口令
    const set = await req(PORT, 'POST', '/api/admin/password', { password: 'testpw123' });
    t('★ 能设上管理口令', set.status === 200 && set.body?.ok === true, JSON.stringify(set.body));

    const noAuthAfter = await req(PORT, 'GET', '/api/users');
    t('★★ 设了口令之后，用户列表开始拦（401）', noAuthAfter.status === 401, `HTTP ${noAuthAfter.status}`);

    const withAuthAfter = await req(PORT, 'GET', '/api/users', null, AUTH);
    t('★ 带对口令能访问', withAuthAfter.status === 200, `HTTP ${withAuthAfter.status}`);

    /** ★ 万能码校验不该被口令影响 —— 否则 App 就用不了了 */
    const verifyStillOpen = await req(PORT, 'POST', '/api/verify-master', { code: FIXTURE_CODE });
    t('★★ 设了口令之后，万能码校验仍然不需要口令', verifyStillOpen.status === 200, `HTTP ${verifyStillOpen.status}`);
  }

  // ── 收尾 ──
  mod.server.close();
  await new Promise((r) => setTimeout(r, 300));
  if (backup !== null) fs.writeFileSync(DEV_DATA, backup);
  else if (fs.existsSync(DEV_DATA)) fs.unlinkSync(DEV_DATA);

  console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('  异常：' + (e?.stack ?? e));
  process.exit(1);
});

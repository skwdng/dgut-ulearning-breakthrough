/**
 * 万能码端到端回归 —— 真起 server.cjs，在临时数据文件上跑完整流程。
 *
 * ══════════════ 为什么 require 而不是 spawn ══════════════
 *
 * server.cjs 导出 `{ server, start, loadDb, saveDb, DATA_FILE }`，并且
 * 只在 `require.main === module` 时才自动监听 —— 被 require 时由调用方
 * 自己 `start(0)` 拿随机端口。这样不用 spawn 子进程（受限环境里 spawn
 * 会被拦），也就不用处理子进程退出/端口回收。
 *
 * ══════════════ 为什么必须隔离数据 ══════════════
 *
 * server.cjs 支持 `LIFEKIT_DATA_FILE`（测试专用），但带三条防护：
 * 文件名以 `_` 开头或含 test、绝对路径在 server/ 目录内、不能是 data.json。
 * 所以临时文件放 `server/_verify-master-flow.test.json`，用完删除；
 * 真实的 `server/data.json` 不会被读写（脚本里也断言了这一点）。
 *
 * 覆盖的回归点：
 *   ① GET /api/master 只报"有没有"，不发明文
 *   ② 管理面（/admin、/api/users、POST /api/master）要口令；/ai/* 不要
 *   ③ POST /api/master 设码后 GET 仍不回显
 *   ④ /api/verify-master 正确码 true / 错码 false（这个接口不能要口令）
 *   ⑤ /api/consume 认万能码（该学号已经有一份个人码时也不能被拦）
 *   ⑥ 落盘的数据文件里只有哈希，没有明文
 *
 * 用法：node tools/verify-master-code-flow.cjs
 * 退出码：0 = 全部通过；1 = 有断言失败或流程异常。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const SERVER_FILE = path.join(ROOT, 'server', 'server.cjs');
/**
 * 临时数据文件。
 * ⚠️ 必须落在 server/ 内且名字以 `_` 开头 —— server.cjs 的 resolveDataFile()
 *    只接受这种命名，否则会忽略变量并退回真实 data.json（那绝不能碰）。
 */
const TEST_DATA_FILE = path.join(ROOT, 'server', '_verify-master-flow.test.json');

const ADMIN_PW = 'test-admin-2026';
/** 万能码只允许 2-32 位字母数字（服务端会校验） */
const MASTER_CODE = 'TESTMASTER2026';
const WRONG_CODE = 'WRONGCODE999';
const STUDENT_ID = '20260001';

/** 结果收集 */
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`  ${ok ? '✓' : '×'} ${name}${detail ? `  — ${detail}` : ''}`);
  return Boolean(ok);
}

function cleanupData() {
  for (const f of [TEST_DATA_FILE, `${TEST_DATA_FILE}.tmp`]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* 本来就不存在 */
    }
  }
}

// ── 隔离：先清掉上次残留，再设环境变量，最后才 require（loadDb 在加载时跑）──
cleanupData();
process.env.LIFEKIT_DATA_FILE = TEST_DATA_FILE;
delete process.env.LIFEKIT_PORT; // 端口用 start(0) 随机拿
delete process.env.LIFEKIT_MASTER_CODE; // 不依赖外部环境，默认占位码路径可预测
// /ai 代理指向一个必然拒绝连接的端口：502 立刻返回，测试不依赖真实 AI 服务
process.env.AI_PORT = '1';
// 万一中途异常退出，也尽量别留下测试数据文件（正常路径在 finally 里删）
process.on('exit', cleanupData);

const { server, start, DATA_FILE } = require(SERVER_FILE);

/**
 * ⚠️⚠️ 硬保护：一旦 server.cjs 没接受 LIFEKIT_DATA_FILE（比如防护规则改了），
 * 它会退回真实 `server/data.json`。此时**必须立刻中止**，不能带着"要写数据"
 * 的流程继续跑 —— 下一步 POST /api/admin/password 就会把真实数据文件覆盖掉。
 * 所以这条检查放在所有写请求之前，不通过直接 exit。
 */
if (path.resolve(DATA_FILE) !== path.resolve(TEST_DATA_FILE)) {
  console.error(`  × 数据隔离失败：server.cjs 用的是 ${DATA_FILE}`);
  console.error('    为保护真实 data.json，已中止（不启动服务、不发任何写请求）。');
  process.exit(1);
}

let port = 0;

/** 发一个 HTTP 请求；auth = 'admin:口令' 时带 Basic 头 */
function request(method, p, { body, auth } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const headers = {};
    if (payload) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = payload.length;
    }
    if (auth) headers.Authorization = `Basic ${Buffer.from(auth, 'utf8').toString('base64')}`;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* /admin 回的是 HTML */
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`请求超时：${method} ${p}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

const auth = `admin:${ADMIN_PW}`;

async function main() {
  const started = await start(0);
  port = server.address().port;
  console.log('');
  console.log(`  测试服务：http://127.0.0.1:${port}（start() 报的端口 ${started.port}，实际用 address().port）`);
  console.log(`  数据文件：${path.basename(DATA_FILE)}`);
  console.log('');

  // ── 0. 先确认真数据没被碰 ──────────────────────────────────────
  check(
    '数据隔离：实例打的是临时文件，不是 server/data.json',
    path.resolve(DATA_FILE) === path.resolve(TEST_DATA_FILE),
    path.basename(DATA_FILE),
  );

  // ── ① 未设码阶段：GET /api/master 只报有无、不发明文 ─────────────
  const m0 = await request('GET', '/api/master');
  check('① GET /api/master 免鉴权可用，回 200', m0.status === 200 && m0.json?.ok === true, `status=${m0.status}`);
  check('① GET /api/master 不返回明文（masterCode 为空串）', m0.json?.masterCode === '');
  check('① GET /api/master 响应里没有默认占位码 CHANGE_ME', !m0.text.includes('CHANGE_ME'));
  /**
   * ℹ️ 服务端没有"完全未设码"状态：EMPTY_DB 里就带着默认占位码 CHANGE_ME
   *    的哈希（LIFEKIT_MASTER_CODE 不设时用它），所以 hasMasterCode 恒为 true。
   *    断言实际契约，别按"未设码→false"的想象写，否则脚本一开始就红。
   */
  check('① hasMasterCode 是布尔 true（存在默认占位码）', m0.json?.hasMasterCode === true);

  // ── ② 管理口令 ────────────────────────────────────────────────
  const setPw = await request('POST', '/api/admin/password', { body: { password: ADMIN_PW } });
  check('② 首次设置管理口令成功（当前无口令时免鉴权）', setPw.status === 200 && setPw.json?.enabled === true);

  const adminNoAuth = await request('GET', '/admin');
  check(
    '② /admin 无口令 → 401 且要求 Basic',
    adminNoAuth.status === 401 && /^Basic /.test(adminNoAuth.headers['www-authenticate'] ?? ''),
    `status=${adminNoAuth.status}`,
  );
  const adminAuth = await request('GET', '/admin', { auth });
  check('② /admin 带口令 → 200 且返回 HTML', adminAuth.status === 200 && /<html/i.test(adminAuth.text));

  const usersNoAuth = await request('GET', '/api/users');
  check('② /api/users 无口令 → 401', usersNoAuth.status === 401, `status=${usersNoAuth.status}`);
  const usersAuth = await request('GET', '/api/users', { auth });
  check('② /api/users 带口令 → 200 且列表可读', usersAuth.status === 200 && Array.isArray(usersAuth.json?.users));

  const masterPostNoAuth = await request('POST', '/api/master', { body: { masterCode: MASTER_CODE } });
  check('② POST /api/master 无口令 → 401（改码受保护）', masterPostNoAuth.status === 401, `status=${masterPostNoAuth.status}`);
  const masterPostBadPw = await request('POST', '/api/master', { body: { masterCode: MASTER_CODE }, auth: 'admin:wrong-pw' });
  check('② POST /api/master 错口令 → 401', masterPostBadPw.status === 401, `status=${masterPostBadPw.status}`);

  // ── ③ 设置测试万能码 ──────────────────────────────────────────
  const setMaster = await request('POST', '/api/master', { body: { masterCode: MASTER_CODE }, auth });
  check(
    '③ 带口令设置测试万能码 → 200 updated',
    setMaster.status === 200 && setMaster.json?.ok === true && setMaster.json?.updated === true,
  );
  check('③ 设置响应里不回显新码', !setMaster.text.includes(MASTER_CODE));

  // ── ④ 校验接口 ────────────────────────────────────────────────
  const verifyOk = await request('POST', '/api/verify-master', { body: { code: MASTER_CODE } });
  check(
    '④ POST /api/verify-master 正确码 → valid:true（接口本身免口令）',
    verifyOk.status === 200 && verifyOk.json?.valid === true,
  );
  const verifyLoose = await request('POST', '/api/verify-master', { body: { code: 'test-master-2026' } });
  check('④ 校验前会规范化（小写/横线不影响）→ valid:true', verifyLoose.json?.valid === true);
  const verifyBad = await request('POST', '/api/verify-master', { body: { code: WRONG_CODE } });
  check(
    '④ 错误码 → ok:true 但 valid:false（不加"接近了"之类的提示）',
    verifyBad.status === 200 && verifyBad.json?.ok === true && verifyBad.json?.valid === false,
  );

  // ── ③' 设码后 GET 仍不发明文 ──────────────────────────────────
  const m1 = await request('GET', '/api/master');
  check(
    '③ GET /api/master 设码后仍 masterCode:"" 且不含测试码明文',
    m1.status === 200 && m1.json?.masterCode === '' && !m1.text.includes(MASTER_CODE),
  );

  // ── ⑥ 落盘只存哈希 ────────────────────────────────────────────
  const disk = fs.readFileSync(DATA_FILE, 'utf8');
  let diskDb = null;
  try {
    diskDb = JSON.parse(disk);
  } catch {
    /* 下面断言会报 */
  }
  check(
    '⑥ 数据文件里 masterCodeHash 是 fnv1a2: 哈希',
    typeof diskDb?.masterCodeHash === 'string' && diskDb.masterCodeHash.startsWith('fnv1a2:'),
  );
  check('⑥ 数据文件里没有 masterCode 明文字段、全文不含测试码', !diskDb?.masterCode && !disk.includes(MASTER_CODE));

  // ── ⑤ /api/consume 要认万能码（本轮真正回归的那个 bug）──────────
  const reg = await request('POST', '/api/register', { body: { studentId: STUDENT_ID, studentName: '回归测试' } });
  check('⑤ 注册测试学号（App 登录上报路径）→ 200', reg.status === 200 && reg.json?.ok === true);

  const issued = await request('POST', '/api/issue', { body: { studentId: STUDENT_ID }, auth });
  const personalCode = issued.json?.code ?? '';
  check('⑤ 管理员签发个人码 → LK1- 开头', issued.status === 200 && /^LK1-/.test(personalCode), personalCode ? '已签发' : '');

  const consumeMaster = await request('POST', '/api/consume', { body: { studentId: STUDENT_ID, code: MASTER_CODE } });
  check(
    '⑤ /api/consume 用万能码 → allow:true（该学号已有个人码也不能被拦）',
    consumeMaster.status === 200 && consumeMaster.json?.allow === true && consumeMaster.json?.reason === 'ok',
    `reason=${consumeMaster.json?.reason}`,
  );
  const consumeWrong = await request('POST', '/api/consume', { body: { studentId: STUDENT_ID, code: WRONG_CODE } });
  check(
    '⑤ /api/consume 用错码 → allow:false code_mismatch（个人码比对分支还在）',
    consumeWrong.status === 200 && consumeWrong.json?.allow === false && consumeWrong.json?.reason === 'code_mismatch',
    `reason=${consumeWrong.json?.reason}`,
  );
  const consumePersonal = await request('POST', '/api/consume', { body: { studentId: STUDENT_ID, code: personalCode } });
  check('⑤ /api/consume 用个人码 → allow:true', consumePersonal.status === 200 && consumePersonal.json?.allow === true);

  // ── ②' /ai/* 不经过管理口令（AI 代理没有把鉴权分层打乱）─────────
  const ai = await request('GET', '/ai/__flow_probe__');
  check(
    '② /ai/* 无口令不被 401 拦（代理到不可用后端时回 502）',
    ai.status === 502 && !ai.headers['www-authenticate'] && /小c 服务不可用/.test(ai.json?.error ?? ''),
    `status=${ai.status}`,
  );

  // ── 收尾 ────────────────────────────────────────────────────
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log('');
  if (failed === 0) {
    console.log('  ✅ 万能码端到端流程通过');
    console.log(`  SUMMARY: assertions=${results.length} passed=${passed} failed=0 result=PASS`);
  } else {
    console.log(`  ❌ 有 ${failed} 条断言失败：`);
    for (const r of results.filter((x) => !x.ok)) console.log(`     · ${r.name}`);
    console.log(`  SUMMARY: assertions=${results.length} passed=${passed} failed=${failed} result=FAIL`);
  }
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.log('');
    console.log(`  ❌ 流程异常：${e.stack || e.message}`);
    console.log('  SUMMARY: assertions=0 passed=0 failed=0 result=ERROR');
    process.exitCode = 1;
  })
  .finally(() => {
    // 先关服务器再删数据文件；close 回调在进程退出前能跑完
    try {
      server.close(() => {
        cleanupData();
        // close 回调是异步的，这里不等 —— exit handler 里还有一次清理
      });
    } catch {
      /* 已经关了 */
    }
    cleanupData();
  });

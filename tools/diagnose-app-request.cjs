/**
 * 诊断：同一个接口，为什么本机 401 而 App 里 404？
 *
 * ══════════════ 现象 ══════════════
 * 用户 App 里的探测结果 vs 本机直连（都不带登录凭据）：
 *
 *   接口                                本机     App
 *   /apps/newAttendance                 401      404（Tomcat）
 *   /apps/user                          401      404
 *   /courseapi/homeworks/student        401      500
 *
 * ⚠️ `/apps/...` 的结果不一致 —— 同一个接口，两种状态码。
 *    这只可能是**请求本身不同**（主机/UA/头），而不是服务端变了。
 *
 * `HttpClient` 的默认 UA 是**桌面版**（注释里写了原因：
 * 移动 UA 会拿到没有 pwdEncryptSalt 的移动登录页）。
 * 但 service 的 `headers()` 又加了 `X-Requested-With: cn.ulearning.yxy`
 * 与 `Referer`。这几样组合起来可能把请求路由到了别处。
 *
 * 这个脚本把各种组合都试一遍，看哪个会从 401 变成 404。
 *
 * 用法: node tools/diagnose-app-request.cjs
 */
const https = require('node:https');

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 12; HarmonyOS; ALN-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
/** 优学院 App 自己的 UA 可能长这样（客户端标识） */
const APP_UA = 'cn.ulearning.yxy/8.6.0 (Android 12; ALN-AL00)';

const LMS = 'https://lms.dgut.edu.cn';
const APP = 'https://application.dgut.edu.cn';
const PATH = '/apps/newAttendance';

/** 请求头组合（按 App 里 service.headers() 的样子逐步加） */
const HEADER_SETS = [
  ['① 只有 UA（桌面）', { 'User-Agent': DESKTOP_UA, Accept: 'application/json' }],
  ['② UA + X-Requested-With（App 里就是这样）', { 'User-Agent': DESKTOP_UA, Accept: 'application/json', 'X-Requested-With': 'cn.ulearning.yxy' }],
  ['③ 上面 + Referer /umobile/', { 'User-Agent': DESKTOP_UA, Accept: 'application/json', 'X-Requested-With': 'cn.ulearning.yxy', Referer: `${LMS}/umobile/?timestamp=1` }],
  ['④ 移动 UA', { 'User-Agent': MOBILE_UA, Accept: 'application/json' }],
  ['⑤ 移动 UA + X-Requested-With', { 'User-Agent': MOBILE_UA, Accept: 'application/json', 'X-Requested-With': 'cn.ulearning.yxy' }],
  ['⑥ App 风格 UA', { 'User-Agent': APP_UA, Accept: 'application/json', 'X-Requested-With': 'cn.ulearning.yxy' }],
  ['⑦ 带 AUTHORIZATION: 假值', { 'User-Agent': DESKTOP_UA, Accept: 'application/json', 'X-Requested-With': 'cn.ulearning.yxy', AUTHORIZATION: 'test-invalid-token' }],
];

function get(url, headers) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers, timeout: 15000 }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => {
        const body = Buffer.concat(c).toString('utf8');
        resolve({ status: res.statusCode, len: body.length, head: body.replace(/\s+/g, ' ').slice(0, 100) });
      });
    });
    req.on('error', (e) => resolve({ status: 0, len: 0, head: `异常：${e.message}` }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, len: 0, head: 'timeout' });
    });
  });
}

(async () => {
  console.log('');
  console.log('  为什么本机 401、App 里 404？');
  console.log(`  目标：${LMS}${PATH}`);

  const results = [];
  for (const [label, headers] of HEADER_SETS) {
    const r = await get(`${LMS}${PATH}`, headers);
    results.push({ label, status: r.status });
    console.log('');
    console.log(`  HTTP ${String(r.status).padEnd(4)} ${label}`);
    console.log(`        ${r.len} 字节 · ${r.head}`);
  }

  console.log('');
  console.log('═'.repeat(72));
  console.log('  同一路径在两个主机上（都用桌面 UA）');
  console.log('═'.repeat(72));
  for (const [host, hname] of [
    [LMS, 'lms'],
    [APP, 'application'],
  ]) {
    const r = await get(`${host}${PATH}`, { 'User-Agent': DESKTOP_UA, Accept: 'application/json' });
    console.log(`  HTTP ${String(r.status).padEnd(4)} ${hname}${PATH}`);
    console.log(`        ${r.len} 字节 · ${r.head}`);
  }

  /** 用户 App 里报的 userId（从他之前截图得知） */
  const USER_ID = 90990001;
  console.log('');
  console.log('═'.repeat(72));
  console.log('  一个"确定应该能动"的接口：/apps/user/getUserByUserID/<你的userId>');
  console.log('═'.repeat(72));
  for (const [host, hname] of [
    [LMS, 'lms'],
    [APP, 'application'],
  ]) {
    const r = await get(`${host}/apps/user/getUserByUserID/${USER_ID}`, {
      'User-Agent': DESKTOP_UA,
      Accept: 'application/json',
      'X-Requested-With': 'cn.ulearning.yxy',
    });
    console.log(`  HTTP ${String(r.status).padEnd(4)} ${hname}/apps/user/getUserByUserID/${USER_ID}`);
    console.log(`        ${r.len} 字节 · ${r.head}`);
  }

  console.log('');
  console.log('═'.repeat(72));
  console.log('  结论怎么看');
  console.log('═'.repeat(72));
  const oneOf401 = results.filter((x) => x.status === 401).length;
  const oneOf404 = results.filter((x) => x.status === 404).length;
  console.log(`  401 的组合：${oneOf401} 个   404 的组合：${oneOf404} 个`);
  if (oneOf404 > 0) {
    const which = results.filter((x) => x.status === 404).map((x) => x.label);
    console.log('  ★ 造成 404 的是这些组合：');
    which.forEach((w) => console.log(`     ${w}`));
    console.log('  → 说明是**请求头**把请求路由到了别处（不是主机问题）');
  } else {
    console.log('  ★ 本机所有组合都是 401 —— 说明本机无法复现 App 的 404。');
    console.log('    那问题可能出在**主机选择**：App 用的是编译进去的 host 常量。');
  }
  console.log('');
})();

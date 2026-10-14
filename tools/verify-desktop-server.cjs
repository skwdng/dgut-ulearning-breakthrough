/**
 * 验证「桌面版」能独立运行 —— 不依赖工程目录。
 * 直接在目标目录里 require 它的 server.cjs，然后请求 /admin。
 */
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const DIR = process.argv[2];
if (!DIR) {
  console.log('  用法: node tools/verify-desktop-server.cjs <目录>');
  process.exit(1);
}
const SERVER = path.join(DIR, 'server.cjs');
const PORT = 8794;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const t = (n, c, e = '') => {
  if (c) {
    pass += 1;
    console.log(`  √ ${n}`);
  } else {
    fail += 1;
    console.log(`  × ${n}${e ? '  → ' + e : ''}`);
  }
};

function req(p, method = 'GET', body) {
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

(async () => {
  console.log(`  目录: ${DIR}`);
  console.log('');

  t('server.cjs 存在', fs.existsSync(SERVER));
  t('manage.html 在**同目录**', fs.existsSync(path.join(DIR, 'manage.html')));
  t('启动脚本存在', fs.existsSync(path.join(DIR, '打开管理后台.cmd')));

  const dataFile = path.join(DIR, 'data.json');
  const backup = fs.existsSync(dataFile) ? fs.readFileSync(dataFile) : null;

  process.env.LIFEKIT_PORT = String(PORT);

  // 静音启动日志
  const orig = console.log;
  console.log = (...a) => {
    if (!a.join(' ').includes('LifeKit 管理服务已启动')) orig(...a);
  };
  const mod = require(SERVER);
  await mod.start(PORT);
  console.log = orig;

  try {
    const ping = await req('/api/ping');
    t('/api/ping 通', ping.status === 200);

    const page = await req('/admin');
    t('/admin 可访问', page.status === 200, `HTTP ${page.status}`);
    t('★ 从同目录读到了管理页', page.text.includes('LifeKit 用户管理'), '内容不含标题');

    const master = await req('/api/master');
    t('能读万能码', JSON.parse(master.text).masterCode.length > 0);

    const reg = await req('/api/register', 'POST', { studentId: '8000000000001', studentName: '桌面测试' });
    t('能登记用户', JSON.parse(reg.text).ok === true);

    const users = await req('/api/users');
    t('列表能读到', JSON.parse(users.text).users.length >= 1);

    // ★ 生成授权码（管理页最常用的功能）
    const issued = await req('/api/issue', 'POST', { studentId: '8000000000002', studentName: '签发测试' });
    const ij = JSON.parse(issued.text);
    t('★ 能签发授权码', ij.ok === true && ij.code.startsWith('LK1-'), ij.code);
    t('签发后进了用户列表', JSON.parse((await req('/api/users')).text).users.some((u) => u.studentId === '8000000000002'));

    // 管理页里要有对应的输入框与按钮
    const page2 = await req('/admin');
    t('管理页有生成授权码的输入框', page2.text.includes('id="issue-sid"'));
    t('管理页有生成按钮', page2.text.includes('doIssue'));

    // 清理
    await req('/api/user/delete', 'POST', { studentId: '8000000000001' });
    await req('/api/user/delete', 'POST', { studentId: '8000000000002' });
  } finally {
    mod.server.close();
    await sleep(200);
    if (backup) fs.writeFileSync(dataFile, backup);
    else if (fs.existsSync(dataFile)) fs.unlinkSync(dataFile);
  }

  console.log('');
  console.log(`  SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('  异常：' + e.message);
  process.exit(1);
});

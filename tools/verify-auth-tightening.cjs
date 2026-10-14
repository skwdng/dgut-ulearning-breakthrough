/**
 * 授权收紧 测试 —— **起一个真服务器实例实测**。
 *
 * ══════════════ 用户需求 ══════════════
 * 「我希望别人不能从我的 app 里得到这些功能的完成」
 *
 * ══════════════ 修之前的漏洞（两个叠在一起）══════════════
 *
 * ① `/api/auth-state` 对**未知学号**回 `authorized: true`
 *    （注释写着"不拦"，其实是把门开着）
 * ② `/api/register`（App 每次登录都调）对**新学号**默认
 *    `authorized: prev?.authorized ?? true` —— 自动标记已授权
 *
 * 后果：别人装上 App → 用自己账号登录 → App 上报 register
 *      → 服务端自动建记录并标记已授权。**完全不需要管理员发码。**
 *
 * ══════════════ 为什么起真服务器而不是只读源码断言 ══════════════
 *
 * 源码断言只能证明"代码里有这行字"，证明不了**行为** ——
 * 而这个漏洞的要害恰恰是"多个接口叠起来的行为"。
 * 所以这里起一个隔离实例（独立端口 + 独立数据文件），真打接口。
 *
 * 用法: node tools/verify-auth-tightening.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8899;
const DATA = path.join(ROOT, 'server', '_auth-test-data.json');
const AUTH = `Basic ${Buffer.from('admin:testpw').toString('base64')}`;

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
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: p,
        method,
        timeout: 8000,
        headers: {
          Authorization: AUTH,
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => {
          const text = Buffer.concat(c).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* 非 JSON */
          }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    r.on('error', (e) => resolve({ status: 0, json: null, text: '', error: e.message }));
    r.on('timeout', () => {
      r.destroy();
      resolve({ status: 0, json: null, text: '', error: 'timeout' });
    });
    if (data) r.write(data);
    r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ── 干净起步：删掉测试数据文件 ──
  try {
    fs.unlinkSync(DATA);
  } catch {
    /* 本来就没有 */
  }

  console.log('');
  console.log('  启动隔离测试实例…');
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.cjs')], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      LIFEKIT_PORT: String(PORT),
      /**
       * ⚠️ 让服务端把数据写到**测试专用文件** ——
       *    绝不能碰真的 data.json（那是云端唯一副本的本地镜像）。
       *    见 server.cjs 里对 LIFEKIT_DATA_FILE 的支持。
       */
      LIFEKIT_DATA_FILE: DATA,
    },
    stdio: 'ignore',
  });

  let ready = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(250);
    const p = await req('GET', '/api/ping');
    if (p.status === 200) {
      ready = true;
      break;
    }
  }
  if (!ready) {
    console.log('  × 测试实例起不来（端口占用？）');
    child.kill();
    process.exit(1);
  }
  console.log('  √ 测试实例已就绪\n');

  try {
    console.log('=== ① ★★★ 未知学号：服务端必须说"不许"（修之前是 true）===');
    {
      const r = await req('GET', '/api/auth-state?studentId=9999999999999');
      t('★★★ 未知学号 authorized === false', r.json?.authorized === false, JSON.stringify(r.json));
      t('★★ 同时 known === false（管理页能区分"没这个人"和"被关了"）', r.json?.known === false);
    }

    console.log('\n=== ② ★★★ 别人登录后上报：不能因此获得授权 ===');
    {
      /**
       * ⚠️ 这是漏洞的核心路径：
       *    别人装上 App、用自己的学号登录 → App 调 /api/register 上报。
       *    修之前这一步会把他标记成 authorized=true。
       */
      const r = await req('POST', '/api/register', {
        studentId: '8888888888888',
        studentName: '不速之客',
        tenant: 'dgut',
      });
      t('★★ 上报本身成功（不报错，避免影响正常登录）', r.status === 200 && r.json?.ok === true);
      t('★★★ 但 register 返回的记录里 authorized === false', r.json?.user?.authorized === false,
        JSON.stringify(r.json?.user));
      t('★★★ 且没有授权码（没被签发过）', !r.json?.user?.code);

      const s = await req('GET', '/api/auth-state?studentId=8888888888888');
      t('★★★ 上报后再查授权状态，仍然是 false（没被洗白）', s.json?.authorized === false,
        JSON.stringify(s.json));
      t('★★ 现在 known === true（记录建了，但没授权）', s.json?.known === true);
    }

    console.log('\n=== ③ ★★★ 管理员签发后：才放行 ===');
    {
      const issue = await req('POST', '/api/issue', {
        studentId: '8888888888888',
        studentName: '不速之客',
      });
      t('★★ 签发成功且拿到 LK1- 开头的码',
        issue.status === 200 && /^LK1-/.test(issue.json?.code ?? ''),
        issue.json?.code);

      const s = await req('GET', '/api/auth-state?studentId=8888888888888');
      t('★★★ 签发后 authorized === true（这是唯一的放行途径）', s.json?.authorized === true,
        JSON.stringify(s.json));
    }

    console.log('\n=== ④ ★★ 管理员关掉授权（保留码）：要立刻拦住 ===');
    {
      /**
       * ⚠️ 管理页可以把某人的 `authorized` 关成 false 而不删码。
       *    那种情况必须拦住 —— 所以判据是 `authorized && 有码`，不是只看有没有码。
       */
      const off = await req('POST', '/api/user/update', {
        studentId: '8888888888888',
        authorized: false,
      });
      t('★ 关授权操作成功', off.status === 200 && off.json?.ok !== false, off.text.slice(0, 120));

      const s = await req('GET', '/api/auth-state?studentId=8888888888888');
      t('★★★ 关掉后 authorized === false（即使码还在）', s.json?.authorized === false,
        JSON.stringify(s.json));
    }

    console.log('\n=== ⑤ ★★ 已有记录不会被这次收紧误伤 ===');
    {
      /** 先签一个，再让他"登录上报"，确认授权不被抹掉 */
      await req('POST', '/api/issue', { studentId: '7777777777777', studentName: '自己人' });
      const before = await req('GET', '/api/auth-state?studentId=7777777777777');
      t('★ 签发后是授权的', before.json?.authorized === true);

      const reg = await req('POST', '/api/register', { studentId: '7777777777777', studentName: '自己人' });
      const after = await req('GET', '/api/auth-state?studentId=7777777777777');
      t('★★★ 登录上报后授权仍然在（没被 register 重建记录时抹掉）', after.json?.authorized === true,
        JSON.stringify(after.json));
      t('★★ 授权码也还在', /^LK1-/.test(reg.json?.user?.code ?? ''), reg.json?.user?.code);
    }

    console.log('\n=== ⑥ ★ 下载安装包与版本查询保持公开（不需要授权）===');
    {
      const v = await req('GET', '/api/version');
      t('★ /api/version 仍可访问（不算授权接口）', v.status === 200 || v.json !== null, `HTTP ${v.status}`);
    }

    console.log('\n=== ⑦ 客户端要把"服务端说不许"如实转达 ===');
    {
      const CLIENT = fs.readFileSync(path.join(ROOT, 'src', 'services', 'serverClient.ts'), 'utf8');
      const CODE = CLIENT.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      t('★★★ 不再把 authorized 翻成 true', !/authorized: r\.data\.authorized !== false/.test(CODE));
      t('★★★ 如实返回服务端的值', /return \{ ok: true, authorized: r\.data\.authorized \}/.test(CODE));
      t('★★ 注释区分了"请求失败"与"服务端说不许"', /请求本身失败.*不拦|两者不能混/.test(CLIENT));

      const STORE = fs.readFileSync(path.join(ROOT, 'src', 'state', 'unlockStore.tsx'), 'utf8');
      t('★★★ 服务端说 false → serverAuth=denied', /r\.authorized === false[\s\S]{0,120}?setServerAuth\('denied'\)/.test(STORE));
      t('★★★ 连不上 → unknown（降级放行，不把人锁死）', /if \(!r\.ok\)[\s\S]{0,120}?setServerAuth\('unknown'\)/.test(STORE));
      t('★★ entitled 仍然要求"本地授权码通过"', /entitled = unlocked && serverAuth !== 'denied'/.test(STORE));
    }
  } finally {
    child.kill();
    await sleep(300);
    try {
      fs.unlinkSync(DATA);
    } catch {
      /* 清理失败无所谓 */
    }
  }

  console.log('');
  console.log(`SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();

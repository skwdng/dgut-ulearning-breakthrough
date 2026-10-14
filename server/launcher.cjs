/**
 * 启动管理后台：等就绪 → 打开浏览器 → 打印中文提示。
 *
 * ⚠️ 为什么提示文字放在这里，而不是 .cmd 里：
 *   .cmd 是 cmd.exe 按**系统代码页**读的，里面写中文极易出问题
 *   （UTF-8 会变乱码；GBK 字节里还可能含引号/重定向字符，
 *     把后续命令拆碎 —— 实测两种都踩过）。
 *   所以 .cmd 只保留纯 ASCII，**所有中文都从 node 输出**（node 写 UTF-8 没问题）。
 *
 * 用法: node server/launcher.cjs [端口]
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PORT = Number(process.argv[2] || process.env.LIFEKIT_PORT || 8787);
const HERE = __dirname;
const SERVER = path.join(HERE, 'server.cjs');
const WAIT = path.join(HERE, 'wait-server.cjs');

function ping(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/ping', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 用系统默认浏览器打开 URL */
function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      // start 是 cmd 内置命令；用 detached 让它自己活
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

(async () => {
  const url = `http://127.0.0.1:${PORT}/admin`;

  console.log('');
  console.log('  ══════════════════════════════════════════════');
  console.log('     LifeKit 管理后台');
  console.log('  ══════════════════════════════════════════════');
  console.log('');

  // ① 服务已在跑？
  if (await ping(PORT)) {
    console.log('  服务已经在运行，直接打开管理页…');
    openBrowser(url);
    console.log('');
    console.log('  管理页：' + url);
    await sleep(2500);
    return;
  }

  // ② 启动服务（独立窗口，最小化）
  console.log('  正在启动管理服务…');
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', 'LifeKit 管理服务', '/min', process.execPath, SERVER], {
        cwd: HERE,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, LIFEKIT_PORT: String(PORT) },
      }).unref();
    } else {
      spawn(process.execPath, [SERVER], {
        cwd: HERE,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, LIFEKIT_PORT: String(PORT) },
      }).unref();
    }
  } catch (e) {
    console.log('  × 启动服务失败：' + e.message);
    return;
  }

  // ③ 等就绪（最多 20 秒）
  process.stdout.write('  等待服务就绪');
  let ready = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await ping(PORT)) {
      ready = true;
      break;
    }
    process.stdout.write('.');
    await sleep(400);
  }
  console.log(ready ? ' 好了' : ' 超时');

  if (!ready) {
    console.log('');
    console.log('  × 服务没起来。可能原因：');
    console.log('    · 端口 ' + PORT + ' 被别的程序占用');
    console.log('    · 电脑没装 Node 或缺少文件');
    console.log('    可以手动在文件夹里运行： node server.cjs');
    console.log('');
    await sleep(6000);
    return;
  }

  // ④ 打开浏览器
  openBrowser(url);

  // ⑤ 顺便把手机要填的地址打出来（这里输出中文没问题）
  try {
    const j = await new Promise((resolve) => {
      http
        .get({ host: '127.0.0.1', port: PORT, path: '/api/ping' }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch {
              resolve({});
            }
          });
        })
        .on('error', () => resolve({}));
    });

    const entries = j.addressesDetail || [];
    console.log('');
    console.log('  ──────────────────────────────────────────────');
    console.log('  管理页已在浏览器打开：' + url);
    console.log('');
    if (entries.length) {
      console.log('  手机里「设置 → 管理服务器」可以填这些地址：');
      for (const e of entries) {
        console.log(`     http://${e.address}:${PORT}     ${e.kind || ''}`);
      }
      const hot = entries.find((x) => String(x.kind || '').startsWith('★'));
      if (hot) {
        console.log('');
        console.log(`  ★ 检测到手机热点网段，多半填：http://${hot.address}:${PORT}`);
      }
    } else {
      console.log('  ⚠️ 没检测到局域网地址 —— 电脑似乎没连网络。');
    }
    console.log('  ──────────────────────────────────────────────');
    console.log('');
    console.log('  停止服务：关闭任务栏上那个最小化的');
    console.log('            「LifeKit 管理服务」窗口。');
  } catch {
    /* 打印失败不影响主流程 */
  }

  console.log('');
  await sleep(8000);
})();

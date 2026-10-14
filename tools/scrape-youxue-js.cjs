/**
 * 从优学院自己的网页前端里找"选人/加减分"的真实接口。
 *
 * ══════════════ 为什么先试这个 ══════════════
 * 逐个猜接口路径很慢（当初找 signByTea 花了不少时间）。
 * 但优学院的网页版**必须**调这些接口才能显示选人和积分 ——
 * 接口路径就写在它的 JS 里。
 *
 * 所以：把网页前端的 JS 扒下来，在里面搜接口路径。
 *
 * ⚠️ 这不需要登录 —— 静态 JS 资源一般是公开的。
 *    只有"实际调用"才要凭据。
 *
 * 用法: node tools/scrape-youxue-js.cjs
 */
const https = require('node:https');
const http = require('node:http');

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 优学院的几个站点（按已知配置） */
const HOSTS = [
  'https://lms.dgut.edu.cn',
  'https://application.dgut.edu.cn',
  'https://www.ulearning.cn',
];

function fetchText(url, opts = {}) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(
      url,
      {
        headers: {
          'User-Agent': DESKTOP_UA,
          Accept: opts.accept ?? 'text/html,application/javascript,*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
        timeout: 20000,
      },
      (res) => {
        // 跟一次重定向
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, url).href;
          res.resume();
          return resolve(fetchText(next, opts));
        }
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            type: res.headers['content-type'] ?? '',
            body: Buffer.concat(c).toString('utf8'),
            url,
          }),
        );
      },
    );
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message, url }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: '', error: 'timeout', url });
    });
  });
}

/** 从 HTML 里找出所有 script src 与内联 script */
function findScripts(html, baseUrl) {
  const out = [];
  const re = /<script[^>]*\ssrc=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const src = m[1];
    if (/^(data:|blob:)/.test(src)) continue;
    out.push(src.startsWith('http') ? src : new URL(src, baseUrl).href);
  }
  return out;
}

/**
 * ★ 关键：在 JS 里搜"接口路径"。
 *   优学院的接口长这样：/apps/newAttendance/signByTea、/courseapi/...
 *   所以抓 /apps/ 或 /courseapi/ 开头、后面跟几段路径词的字符串。
 */
function extractPaths(js) {
  const found = new Set();
  // 字符串字面量里的路径
  const re = /["'`](\/(?:apps|courseapi|api)\/[A-Za-z0-9_\-/{}$.]{2,80})["'`]/g;
  let m;
  while ((m = re.exec(js))) found.add(m[1]);
  return [...found];
}

/** 与"选人/点名/分数"有关的关键词（中英都要） */
const KEYWORDS = {
  选人: ['callName', 'randomCall', 'rollCall', 'rollcall', 'pick', 'lottery', 'choose', 'random', 'call'],
  点名: ['attendance', 'newAttendance', 'sign'],
  分数: ['score', 'point', 'integral', 'credit', 'mark', 'grade'],
  学生名单: ['student', 'userList', 'member', 'roster'],
};

(async () => {
  console.log('');
  console.log('  扒优学院前端 JS，找"选人 / 加减分"接口');

  const allPaths = new Set();
  const scanned = [];

  for (const host of HOSTS) {
    console.log('');
    console.log('─'.repeat(66));
    console.log(`  ${host}`);
    console.log('─'.repeat(66));

    const home = await fetchText(host + '/');
    if (!home.body) {
      console.log(`  × 取不到首页：${home.error ?? home.status}`);
      continue;
    }
    console.log(`  √ 首页 HTTP ${home.status}  字节 ${home.body.length}`);

    const scripts = findScripts(home.body, host + '/');
    console.log(`  找到 ${scripts.length} 个外链 JS`);

    // 只取前若干个，避免打太多请求
    for (const s of scripts.slice(0, 12)) {
      const r = await fetchText(s, { accept: 'application/javascript,*/*' });
      scanned.push(s);
      if (!r.body) {
        console.log(`     × ${s.replace(host, '')}  (${r.error ?? r.status})`);
        continue;
      }
      const paths = extractPaths(r.body);
      for (const p of paths) allPaths.add(p);
      console.log(`     √ ${s.replace(host, '')}  ${(r.body.length / 1024).toFixed(0)}KB  → ${paths.length} 个接口路径`);
    }

    // 也顺手看看首页内联脚本
    const inline = [...home.body.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi)]
      .map((m) => m[1])
      .join('\n');
    for (const p of extractPaths(inline)) allPaths.add(p);
  }

  console.log('');
  console.log('─'.repeat(66));
  console.log(`  共 {allPaths.size} 个接口路径`.replace('{allPaths.size}', String(allPaths.size)));
  console.log('─'.repeat(66));

  if (!allPaths.size) {
    console.log('');
    console.log('  ⚠️ 没扒到接口路径。可能原因：');
    console.log('     · 首页需要登录才返回带 JS 的页面');
    console.log('     · JS 资源在别的域名/CDN 上');
    console.log('     · 接口路径不是字面量（拼出来的）');
    console.log('');
    console.log('  → 那就只能回到"在 App 里探测候选接口"那条路。');
    return;
  }

  // 按关键词归类
  for (const [label, keys] of Object.entries(KEYWORDS)) {
    const hit = [...allPaths].filter((p) => keys.some((k) => p.toLowerCase().includes(k.toLowerCase())));
    if (hit.length) {
      console.log('');
      console.log(`  ★ 与「${label}」相关的路径（${hit.length} 个）：`);
      hit.slice(0, 40).forEach((p) => console.log(`     ${p}`));
    }
  }

  console.log('');
  console.log('  全部路径（去重后，前 120 个）：');
  [...allPaths].slice(0, 120).forEach((p) => console.log(`     ${p}`));
  console.log('');
})();

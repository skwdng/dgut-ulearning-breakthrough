/**
 * 找优学院网页版的**全部** JS 分块（含懒加载），并在里面搜
 * 选人 / 点名 / 积分 相关的接口。
 *
 * ══════════════ 为什么改这个方向 ══════════════
 * 上一版搜 `signByTea` / `newAttendance` 都是 0 次 ——
 * 那两个是**手机 App** 的接口，网页版不用它们。
 *
 * 网页版 JS 里能看到它自己的命名空间：
 *   appapi / courseapi / szaccountapi / vrapi / zykapi / sjjx / umooc …
 *
 * 而"教师给学生加减分"这件事**网页端就能做**（优学院帮助文档
 * 讲的是教师在大屏/网页端操作），所以接口更可能在网页版 JS 里。
 *
 * 思路：
 *   ① 先找 webpack 的 chunk 清单（一般是个很小的 manifest JS）
 *   ② 把能找到的 chunk 全下下来
 *   ③ 在里面搜中文关键词（"积分"、"选人"、"加减"）与英文接口名
 *
 * 用法: node tools/scrape-youxue-chunks.cjs
 */
const https = require('node:https');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://application.dgut.edu.cn';

function get(url) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, timeout: 30000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(get(new URL(res.headers.location, url).href));
        }
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () =>
          resolve({ status: res.statusCode, type: res.headers['content-type'] ?? '', body: Buffer.concat(c).toString('utf8') }),
        );
      })
      .on('error', () => resolve({ status: 0, type: '', body: '' }));
  });
}

(async () => {
  console.log('');
  console.log('  找优学院网页版的全部 JS 分块');

  const home = await get(BASE + '/');
  console.log(`  首页 HTTP ${home.status}  字节 ${home.body.length}`);

  // 首页里引的 JS
  const scripts = new Set();
  for (const m of home.body.matchAll(/<script[^>]*\ssrc=["']([^"']+)["']/gi)) {
    const s = m[1];
    scripts.add(s.startsWith('http') ? s : new URL(s, BASE + '/').href);
  }
  console.log(`  首页引用 ${scripts.size} 个 JS`);

  /**
   * ★ 关键：webpack 会把"分块名 → 文件名"的映射写在主 JS 里。
   *   形如：{ "chunk-abc": "chunk-abc.1a2b3c.js" } 或
   *        __webpack_require__.u = e => "static/js/" + e + "." + {...}[e] + ".js"
   *   把这些文件名抠出来，就能把懒加载的页面也下下来。
   */
  const chunkNames = new Set();
  const chunkFiles = new Set();

  for (const s of scripts) {
    const r = await get(s);
    if (!r.body) continue;
    console.log(`  √ ${s.split('/').pop()}  ${(r.body.length / 1024).toFixed(0)} KB`);

    // 形如 "xxx.abcdef12.js" 的字符串
    for (const m of r.body.matchAll(/["']([A-Za-z0-9_~\-]{1,60})\.([0-9a-f]{8})\.js["']/g)) {
      chunkFiles.add(`${m[1]}.${m[2]}.js`);
    }
    // 形如 {123:"chunk-name",...} 的名字表
    for (const m of r.body.matchAll(/["']([A-Za-z0-9_~\-]{2,60})["']\s*:\s*["']?[0-9a-f]{8}["']?/g)) {
      chunkNames.add(m[1]);
    }
  }

  console.log('');
  console.log(`  抠到文件名形态的分块：${chunkFiles.size} 个`);
  console.log(`  抠到名字表条目：${chunkNames.size} 个`);

  /**
   * ⚠️ 优学院这个 webpack 配置是
   *    "static/js/" + e + "." + {name: hash}[e] + ".js"
   *    所以还要拿名字去拼。这里把两种都试一遍。
   */
  const toTry = new Set();
  for (const f of chunkFiles) toTry.add(`${BASE}/static/js/${f}`);
  for (const n of [...chunkNames].slice(0, 200)) {
    // 名字可能直接就是文件名前缀
    toTry.add(`${BASE}/static/js/${n}.js`);
  }

  console.log(`  准备试 ${toTry.size} 个 URL（只取返回 200 的）`);
  console.log('');

  const hits = [];
  let tried = 0;
  for (const u of toTry) {
    if (tried >= 120) break; // 别打太多请求
    tried += 1;
    const r = await get(u);
    if (r.status !== 200 || !r.body || r.body.length < 200) continue;
    const body = r.body;

    /**
     * ★ 在这块 JS 里找我们要的东西。
     *   中文关键词最有指示性 —— 前端会写 "积分"、"选人"。
     */
    const found = [];
    for (const k of [
      '积分',
      '选人',
      '加减',
      '加分',
      '随机',
      '点名',
      '签到',
      'attendance',
      'rollcall',
      'rollCall',
      'callName',
      'score',
      'point',
      'grade',
      'studentList',
    ]) {
      if (body.includes(k)) found.push(k);
    }

    if (found.length) {
      hits.push({ url: u, kb: (body.length / 1024).toFixed(0), found });
      console.log(`  ★ ${u.replace(BASE, '')}  ${(body.length / 1024).toFixed(0)}KB`);
      console.log(`      命中：${found.join(', ')}`);
    }
  }

  console.log('');
  console.log('─'.repeat(70));
  console.log(`  有命中的分块：${hits.length} 个（试了 ${tried} 个 URL）`);
  console.log('─'.repeat(70));

  if (!hits.length) {
    console.log('');
    console.log('  ⚠️ 没找到。可能：');
    console.log('     · 网页版根本没有这些功能（只有 App 有）');
    console.log('     · 分块名拼法和我猜的不一样（hash 对不上）');
    console.log('     · 需要登录后才加载那些分块');
    console.log('');
    console.log('  → 那就只剩"在 App 里探测候选接口"这条路。');
  }
  console.log('');
})();

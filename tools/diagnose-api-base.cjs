/**
 * 从优学院网页版 JS 里挖出**接口基址表**，找出 `classroomapi` 的完整前缀。
 *
 * ══════════════ 为什么需要这个 ══════════════
 * 用户抓包确认 `classroomActivity2` 可用，请求路径形如
 *   `/classroomapi/classroomActivity2?classroomId=443969`
 *
 * 但本机直连两个主机都是 404：
 *   lms.dgut.edu.cn/classroomapi/...          → 404
 *   application.dgut.edu.cn/classroomapi/...  → 404
 *
 * 而 `/apps/newAttendance` 在 lms 上是 401（路径确实存在）。
 *
 * 说明 `classroomapi` 的**宿主不是这两个之一**，或者前缀更长。
 *
 * 之前扒 JS 时看到过这样一段（app.dde9a3d3.js 里）：
 *   p = i+"appapi"+c     z = i+"szaccountapi"+c     g = i+"vrapi"+c
 *   f = i+"zykapi"+c     y = i+"sjjx"+c+"/api"      b = i+"www"+c
 * 其中 `i` 是协议+域名，`c` 是某个后缀。
 *
 * 这份表就是答案 —— 把它的完整定义挖出来。
 *
 * 用法: node tools/diagnose-api-base.cjs
 */
const https = require('node:https');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function get(url) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, timeout: 30000 }, (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
      })
      .on('error', () => resolve(''));
  });
}

(async () => {
  console.log('');
  console.log('  挖优学院网页版的接口基址表');

  const js = await get('https://application.dgut.edu.cn/static/js/app.dde9a3d3.js');
  console.log(`  app.js ${(js.length / 1024).toFixed(0)} KB`);
  if (!js) {
    console.log('  × 取不到');
    return;
  }

  console.log('');
  console.log('─'.repeat(76));
  console.log('  ① 那段"基址拼接"代码的完整上下文');
  console.log('─'.repeat(76));

  /** 已知的特征片段 */
  const anchor = 'appapi';
  let from = 0;
  let shown = 0;
  for (;;) {
    const i = js.indexOf(anchor, from);
    if (i < 0 || shown >= 4) break;
    from = i + anchor.length;
    shown += 1;
    // 往前多取一点，把 i 和 c 的定义也带上
    const start = Math.max(0, i - 900);
    const end = Math.min(js.length, i + 700);
    console.log('');
    console.log(`  [出现点 ${shown}] 偏移 ${i}`);
    console.log('  ' + js.slice(start, end).replace(/\s+/g, ' '));
  }

  console.log('');
  console.log('─'.repeat(76));
  console.log('  ② 搜所有形如 "<名字>api" 的字符串（候选租户）');
  console.log('─'.repeat(76));
  const apis = new Set();
  for (const m of js.matchAll(/["'`]?([a-z]{2,20}api)["'`]?/gi)) apis.add(m[1]);
  [...apis].sort().forEach((a) => console.log(`  ${a}`));

  console.log('');
  console.log('─'.repeat(76));
  console.log('  ③ 搜域名（找出接口真正的主机）');
  console.log('─'.repeat(76));
  const domains = new Set();
  for (const m of js.matchAll(/["'`]([a-z0-9.-]*(?:ulearning|dgut)\.(?:cn|com|edu\.cn)[a-z0-9./-]*)["'`]/gi)) {
    domains.add(m[1]);
  }
  [...domains].sort().forEach((d) => console.log(`  ${d}`));

  console.log('');
  console.log('─'.repeat(76));
  console.log('  ④ 直接搜 classroomapi —— 看它周围是怎么拼的');
  console.log('─'.repeat(76));
  from = 0;
  let n = 0;
  for (;;) {
    const i = js.indexOf('classroomapi', from);
    if (i < 0 || n >= 6) break;
    from = i + 12;
    n += 1;
    console.log('');
    console.log(`  [${n}] 偏移 ${i}`);
    console.log('  ' + js.slice(Math.max(0, i - 260), i + 260).replace(/\s+/g, ' '));
  }
  if (!n) console.log('  （app.js 里没有 classroomapi 字样 → 它在某个懒加载分块里）');

  console.log('');
  console.log('─'.repeat(76));
  console.log('  ⑤ 搜 classroomActivity2');
  console.log('─'.repeat(76));
  if (js.includes('classroomActivity2')) {
    const i = js.indexOf('classroomActivity2');
    console.log('  ' + js.slice(Math.max(0, i - 300), i + 300).replace(/\s+/g, ' '));
  } else {
    console.log('  （app.js 里没有 → 在懒加载分块里）');
  }
  console.log('');
})();

/**
 * 下载优学院网页版的**全部懒加载分块**，在里面搜
 * 「选人 / 点名 / 加减分」相关的接口与文案。
 *
 * ══════════════ 分块命名规则（从 app.js 里抠出来的）══════════════
 *   t.u = function(a){ return "static/js/" + a + "." + {27:"a8786ffd", ...}[a] + ".js" }
 *
 *   文件名 = `static/js/<数字ID>.<8位hash>.js`
 *   有两套 hash 表（生产 / 测试构建），两套都试。
 *
 * ══════════════ 为什么要这么费劲 ══════════════
 * 目标是找到"教师给学生加减分"和"选人"的真实接口。
 * 优学院没有公开文档，手机 App 那套 `/apps/...` 接口在网页 JS 里搜不到
 * （网页版用 appapi / vrapi / zykapi 等另一套命名空间）。
 * 而"加减分"网页端教师就能做，所以接口大概率在这些懒加载分块里。
 *
 * 用法: node tools/scrape-youxue-chunks2.cjs
 */
const https = require('node:https');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://application.dgut.edu.cn';

/** 从 app.js 里抠出来的两套 hash 表 */
const TABLE_PROD = {
  27: 'a8786ffd', 110: '15bbafdf', 131: '3577dd6d', 167: '39b6c94c', 220: '46ead0f7',
  244: 'f7d21f50', 389: '9468f1e7', 390: '239905b7', 421: '44a1a9d2', 439: '7a88315b',
  446: '1d4cfba3', 461: 'a6cf230f', 584: '52df5e65', 641: 'e04432b4', 649: '77ae2ad9',
  652: '90b57eba', 705: 'a7564e50', 776: 'bfa1c9fb', 808: 'b89b1798', 814: '2e251294',
  821: '4ab4f5f4', 851: '0fe41c18', 917: 'e034a9f3', 939: 'b2c8cb58', 966: 'e132bb20',
  988: 'cbf2dfeb', 997: '4ee5a756',
};
const TABLE_TEST = {
  27: '435c5f40', 110: '58f81fbe', 131: '51f7cdd5', 220: '4a9c279b', 389: 'e9bc1993',
  398: '275b997a', 421: '99053a69', 446: '115fb29b', 461: 'dd204689', 584: '531b588c',
  641: '5c6d6a83', 652: '8c6363dc', 808: 'df038a16', 851: '9800ccee', 966: '3391aa0d',
  988: '7e4760c8', 997: '126ce903',
};

function get(url) {
  return new Promise((resolve) => {
    https
      .get(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, timeout: 30000 }, (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
      })
      .on('error', () => resolve({ status: 0, body: '' }));
  });
}

/** ★ 要搜的东西：中文文案 + 英文接口片段 */
const KEYS = [
  '积分', '选人', '加减', '加分', '扣分', '随机', '点名', '签到', '考勤',
  'rollcall', 'rollCall', 'callName', 'attendance', 'newAttendance',
  'score', 'Score', 'point', 'Point', 'studentScore', 'updateScore', 'addScore',
  'appapi', 'vrapi', 'zykapi', 'courseapi',
  'studentList', 'memberList', 'classStudent',
];

/** 从 JS 里抽接口路径（放得很宽 —— 只要能看出是路径） */
function extractPaths(js) {
  const out = new Set();
  for (const m of js.matchAll(/["'`](\/[A-Za-z0-9_\-/{}$.]{4,90})["'`]/g)) out.add(m[1]);
  for (const m of js.matchAll(/url:\s*["'`]([^"'`]{4,120})["'`]/g)) out.add(`url:${m[1]}`);
  return [...out];
}

(async () => {
  console.log('');
  console.log('  下载优学院网页版全部懒加载分块并搜索');

  const seen = new Set();
  const hits = [];
  const allPaths = new Set();
  let ok = 0;

  const allIds = new Set([...Object.keys(TABLE_PROD), ...Object.keys(TABLE_TEST)]);
  console.log(`  候选分块 ${allIds.size} 个（两套 hash 都试）`);
  console.log('');

  for (const id of allIds) {
    for (const table of [TABLE_PROD, TABLE_TEST]) {
      const hash = table[id];
      if (!hash) continue;
      const url = `${BASE}/static/js/${id}.${hash}.js`;
      if (seen.has(url)) continue;
      seen.add(url);

      const r = await get(url);
      if (r.status !== 200 || r.body.length < 200) continue;
      ok += 1;

      const found = KEYS.filter((k) => r.body.includes(k));
      if (found.length) {
        hits.push({ id, url, kb: (r.body.length / 1024).toFixed(0), found });
      }
      for (const p of extractPaths(r.body)) allPaths.add(p);
    }
  }

  console.log(`  √ 成功下载 ${ok} 个分块`);
  console.log('');
  console.log('─'.repeat(72));
  console.log('  有命中的分块');
  console.log('─'.repeat(72));
  if (!hits.length) {
    console.log('  （没有）');
  } else {
    for (const h of hits.sort((a, b) => b.found.length - a.found.length)) {
      console.log(`  ★ ${h.id}  ${h.kb}KB`);
      console.log(`      ${h.found.join(', ')}`);
    }
  }

  console.log('');
  console.log('─'.repeat(72));
  console.log('  与"选人 / 积分"最相关的接口路径');
  console.log('─'.repeat(72));
  const interesting = [...allPaths].filter((p) =>
    /call|rollcall|random|pick|score|point|integral|attendance|activity|interaction/i.test(p),
  );
  console.log(`  （从 ${allPaths.size} 个路径里筛出 ${interesting.length} 个）`);
  interesting.slice(0, 80).forEach((p) => console.log(`  ${p}`));

  console.log('');
  console.log('─'.repeat(72));
  console.log('  全部路径（前 100）');
  console.log('─'.repeat(72));
  [...allPaths].slice(0, 100).forEach((p) => console.log(`  ${p}`));
  console.log('');
})();

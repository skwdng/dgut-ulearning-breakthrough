/**
 * 在优学院前端 JS 里搜关键词（放宽版）。
 *
 * 上一版用严格的路径正则，什么也没抠到 —— 说明接口名可能是
 * 拼出来的、或者在某个常量对象里。这次直接搜**子串**，
 * 并把上下文打出来，人眼一看就知道。
 */
const https = require('node:https');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
        res.on('end', () => resolve(Buffer.concat(c).toString('utf8')));
      })
      .on('error', () => resolve(''));
  });
}

/** 我们要找的东西 —— 已知的当作"温度计"验证搜索有效 */
const PROBES = [
  // ★ 已知存在的接口：如果搜不到它，说明搜索方法不对
  { k: 'signByTea', why: '已知接口（温度计）' },
  { k: 'newAttendance', why: '已知接口命名空间（温度计）' },
  { k: 'courseapi', why: '已知命名空间（温度计）' },
  // 选人相关
  { k: 'callName', why: '选人' },
  { k: 'rollCall', why: '选人' },
  { k: 'rollcall', why: '选人' },
  { k: 'randomCall', why: '选人' },
  { k: 'pickStudent', why: '选人' },
  { k: 'callStudent', why: '选人' },
  { k: 'lottery', why: '选人' },
  // 分数相关
  { k: 'score', why: '分数' },
  { k: 'point', why: '积分' },
  { k: 'integral', why: '积分' },
  { k: 'addScore', why: '加减分' },
  { k: 'updateScore', why: '加减分' },
  { k: 'studentScore', why: '加减分' },
  // 课堂活动
  { k: 'activity', why: '课堂活动' },
  { k: 'interaction', why: '课堂互动' },
  { k: 'classroom', why: '课堂' },
];

(async () => {
  const files = [
    'https://application.dgut.edu.cn/static/js/app.dde9a3d3.js',
    'https://application.dgut.edu.cn/static/js/chunk-vendors.f840cd15.js',
  ];

  console.log('');
  console.log('  下载并搜索前端 JS');

  const blobs = [];
  for (const f of files) {
    const t = await get(f);
    console.log(`  ${t.length ? '√' : '×'} ${f.split('/').pop()}  ${(t.length / 1024).toFixed(0)} KB`);
    if (t) blobs.push({ file: f.split('/').pop(), text: t });
  }

  const all = blobs.map((b) => b.text).join('\n');
  console.log('');
  console.log(`  合计 ${(all.length / 1024).toFixed(0)} KB`);
  console.log('');
  console.log('─'.repeat(70));
  console.log('  关键词命中情况（前三个是"温度计"，用来验证搜索有没有效）');
  console.log('─'.repeat(70));

  for (const p of PROBES) {
    let n = 0;
    let idx = -1;
    // 统计出现次数（限制一下，别在大文件上跑太久）
    let from = 0;
    for (;;) {
      const i = all.indexOf(p.k, from);
      if (i < 0) break;
      n += 1;
      if (idx < 0) idx = i;
      from = i + p.k.length;
      if (n > 500) break;
    }
    const mark = n > 0 ? '√' : '·';
    console.log(`  ${mark} ${p.k.padEnd(18)} ${String(n).padStart(4)} 次   ${p.why}`);
    if (n > 0 && idx >= 0) {
      const ctx = all.slice(Math.max(0, idx - 90), idx + 110).replace(/\s+/g, ' ');
      console.log(`      …${ctx}…`);
    }
  }

  console.log('');
  console.log('─'.repeat(70));
  console.log('  在 JS 里出现的 /apps/ 或 /courseapi/ 路径片段');
  console.log('─'.repeat(70));
  const re = /\/(?:apps|courseapi)\/[A-Za-z0-9_\-/]{3,70}/g;
  const found = new Set();
  let m;
  while ((m = re.exec(all))) found.add(m[0]);
  if (!found.size) console.log('  （没有）');
  [...found].sort().slice(0, 60).forEach((p) => console.log(`  ${p}`));
  console.log(`  共 ${found.size} 个`);
  console.log('');
})();

/**
 * 看优学院 app.js 里 webpack 是怎么拼"分块文件名"的。
 * 找到规则后就能把所有懒加载页面都下下来。
 */
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

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
  const js = await get('https://application.dgut.edu.cn/static/js/app.dde9a3d3.js');
  console.log(`  app.js ${(js.length / 1024).toFixed(0)} KB`);

  // 存下来供 grep
  const out = path.join(require('node:os').tmpdir(), 'youxue-app.js');
  fs.writeFileSync(out, js, 'utf8');
  console.log(`  已存到 ${out}`);

  console.log('');
  console.log('─'.repeat(70));
  console.log('  搜"拼分块文件名"的代码');
  console.log('─'.repeat(70));

  // webpack 的 u 函数：u = e => "static/js/" + e + "." + {..}[e] + ".js"
  for (const key of ['static/js/', 'js/', '.js"', 'chunkId', 'webpackJsonp']) {
    const idx = js.indexOf(key);
    if (idx < 0) {
      console.log(`  · 没找到 ${key}`);
      continue;
    }
    const ctx = js.slice(Math.max(0, idx - 150), idx + 250).replace(/\s+/g, ' ');
    console.log('');
    console.log(`  √ 找到 ${key}（第 ${idx} 字节）`);
    console.log(`     ${ctx}`);
  }

  console.log('');
  console.log('─'.repeat(70));
  console.log('  搜形如 {...}[e]+".js" 的哈希表');
  console.log('─'.repeat(70));
  // 匹配 {"数字或名字":"8位hash",...}
  const maps = [...js.matchAll(/\{[^{}]{20,4000}\}/g)].filter((m) => /"[0-9a-f]{8}"/.test(m[0]) && m[0].split(':').length > 4);
  console.log(`  候选哈希表 ${maps.length} 个`);
  maps.slice(0, 3).forEach((m, i) => {
    console.log('');
    console.log(`  [${i + 1}] ${m[0].slice(0, 600).replace(/\s+/g, ' ')}`);
  });

  console.log('');
  console.log('─'.repeat(70));
  console.log('  搜中文关键词（看 app.js 里有没有选人/积分相关页面）');
  console.log('─'.repeat(70));
  for (const k of ['积分', '选人', '加减', '加分', '随机', '点名', '签到', '成绩', '学生名单']) {
    const n = js.split(k).length - 1;
    console.log(`  ${n > 0 ? '√' : '·'} ${k.padEnd(8)} ${n} 次`);
    if (n > 0) {
      const i = js.indexOf(k);
      console.log(`      …${js.slice(Math.max(0, i - 70), i + 90).replace(/\s+/g, ' ')}…`);
    }
  }
  console.log('');
})();

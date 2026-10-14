// 在真机之外先做一次**纯逻辑**检查：
// 看看 signByStu / 教师端候选接口 在当前代码里是怎么调的，避免盲改。
const fs = require('fs');

const p = __dirname + '/src/services/checkin/signApi.ts';
const s = fs.readFileSync(p, 'utf8');

console.log('  === 当前 signByStu 请求体构造 ===');
const m = s.match(/async submitSign[\s\S]*?\n  \}/);
if (m) {
  const body = m[0];
  const lines = body.split('\n').filter((l) => /body\.|enterWay|attendanceCode|status|newStatus/.test(l));
  lines.forEach((l) => console.log('    ' + l.trim()));
}

console.log('');
console.log('  === 现存的取消签到接口定义 ===');
s.split('\n').forEach((l, i) => {
  if (/signCancel|cancelSignByStu/.test(l)) console.log(`    ${i + 1}: ${l.trim()}`);
});

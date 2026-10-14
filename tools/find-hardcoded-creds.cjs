// 找 .recon 下有没有硬编码的测试凭据（用来判断追踪时用的密码是否可能不对）
const fs = require('fs');
const path = require('path');

const dir = __dirname + '/.recon';
const files = fs.readdirSync(dir).filter((x) => x.endsWith('.cjs'));
let found = 0;

for (const f of files) {
  const s = fs.readFileSync(path.join(dir, f), 'utf8');
  // 跳过从命令行取参数的脚本（那种没有硬编码）
  const hardId = s.match(/(?:studentId|student_id|sid|userId)\s*=\s*['"]([0-9]{8,20})['"]/);
  const hardPw = s.match(/(?:password|passwd|pwd|pw)\s*=\s*['"]([^'"]{4,40})['"]/i);
  if (hardId || hardPw) {
    console.log(`  ${f}`);
    if (hardId) console.log(`      学号 ${hardId[1]}`);
    if (hardPw) console.log(`      密码 有（长度 ${hardPw[1].length}）`);
    found += 1;
  }
}
console.log('');
console.log(`  含硬编码凭据的脚本: ${found} 个`);

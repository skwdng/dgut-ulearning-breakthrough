/**
 * 把 app.json 的版本号改成正式号（升正式版前跑）。
 *
 * ⚠️ 为什么需要它：已发出去的客户端靠 **versionCode 变大**才会提示更新。
 *    测试版用的是 200+ 那一段，正式版用 1xx 那一段，两者不冲突。
 *
 * 用法: node tools/set-version.cjs 1.1.0 130
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'app.json');

const version = process.argv[2];
const versionCode = Number(process.argv[3]);

if (!version || !Number.isInteger(versionCode) || versionCode <= 0) {
  console.error('  × 用法: node tools/set-version.cjs <版本号> <versionCode>');
  console.error('     例: node tools/set-version.cjs 1.1.0 130');
  process.exit(1);
}

const json = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const before = { v: json.expo?.version, c: json.expo?.android?.versionCode };

json.expo.version = version;
json.expo.android.versionCode = versionCode;
fs.writeFileSync(FILE, `${JSON.stringify(json, null, 2)}\n`, 'utf8');

console.log('');
console.log(`  app.json 版本已更新`);
console.log(`     版本号      ${before.v}  →  ${version}`);
console.log(`     versionCode ${before.c}  →  ${versionCode}`);
console.log('');
/**
 * ⚠️ 提醒：**测试版必须用 200+ 的 versionCode**。
 *    否则升级正式版后再打测试版，测试版的 code 反而变小，
 *    手机上"应用内更新"会认为不是更新（不提示）。
 */
if (!version.includes('test') && versionCode >= 200) {
  console.log('  ⚠️ 这是正式号，但 versionCode ≥ 200 —— 建议正式版用 1xx 段');
  console.log('     测试版保留 200+，两者互不干扰。');
  console.log('');
}

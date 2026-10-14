/**
 * 把优学院前端 API 模块的**完整定义段**拉出来看。
 *
 * 前一步已经找到 35 个真实接口，但还需要「改分数」「改可被选中」
 * 那两个写接口 —— 它们应该在同一个 API 模块里，紧挨着别的方法定义。
 *
 * 这个脚本定位到 API 模块（含 `getStudentScoreForClassroom` 的那段），
 * 把周边足够大的一片原文打出来。
 *
 * 用法: node tools/dump-youxue-api-module.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const RECON = path.join(__dirname, '..', '.recon');

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(RECON);

/** 以这些为锚点，把所在的 API 模块整段打出来 */
const ANCHOR = 'getStudentScoreForClassroom';
const WINDOW_BEFORE = 6000;
const WINDOW_AFTER = 6000;

for (const f of files) {
  let s = '';
  try {
    s = fs.readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  const i = s.indexOf(ANCHOR);
  if (i < 0) continue;

  console.log('');
  console.log('═'.repeat(76));
  console.log(`  找到 API 模块：${path.basename(f)}（锚点偏移 ${i}）`);
  console.log('═'.repeat(76));

  const seg = s.slice(Math.max(0, i - WINDOW_BEFORE), i + WINDOW_AFTER);

  /**
   * ⚠️ 这段是压缩过的代码，原样打印会是一大坨。
   *    按 `,t.` / `,n.` 之类的边界切开，每条 API 一行，便于阅读。
   */
  const lines = seg
    .replace(/([,;])(t|n|i|a|o|r|s|c|u|d|p|f|h|m|v|g|y|b|w|x|k|M|J|S|G|A|q|E|O|C|R|T|D|P|F|H|N|B|V|W|Y|X|K|L|U|Z|\$|_)\.([A-Za-z_$][\w$]*)=function/g,
      '$1\n$2.$3=function')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  lines.forEach((l) => {
    // 只打带接口路径的，或看起来是写接口的
    if (/wisdomClassroom|courseapi|users\/|newAttendance/.test(l) || /\.(post|put|delete)\(/.test(l)) {
      console.log('  ' + l.slice(0, 400));
    }
  });
  console.log('');
}

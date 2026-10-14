/**
 * 自检 .cmd 启动脚本。
 *
 * ══════════ 这里记录两个真实踩过的坑 ══════════
 *
 * ① **不要在 .cmd 里内联 JS**
 *    曾内联一段 node 脚本做健康检查，里面有个管道符 `|`，
 *    而 cmd.exe 把 `|` 当成管道 → 把后半段当命令执行，
 *    生成了一个叫 `40){clearInterval(t)` 的垃圾文件，健康检查也没生效。
 *    → 要用脚本就放独立的 .cjs，用 `%~dp0xxx.cjs` 调用。
 *
 * ② **.cmd 里不要出现任何非 ASCII 字符（中文尤其危险）**
 *    cmd.exe 是按**系统代码页**（中文 Windows = 936/GBK）读 .cmd 文件的：
 *      · 存成 UTF-8  → 中文变乱码，每一行都报"不是内部或外部命令"，脚本全废
 *      · 存成 GBK    → 某些中文的 GBK 字节里含 `"` 或 `|`，
 *                      会把后续命令拆碎，同样报一堆错
 *    实测**两种都踩过**。唯一稳妥的做法：
 *      .cmd 只写 ASCII，**所有中文提示交给 node 输出**（node 写 UTF-8 没问题）。
 *
 * 用法: node tools/check-cmd.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIRS = [path.join(ROOT, 'server'), path.join(ROOT, 'server', '桌面版')];

let pass = 0;
let fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  √ ${name}`);
  } else {
    fail += 1;
    console.log(`  × ${name}${extra ? '  → ' + extra : ''}`);
  }
};

// ── 收集所有 .cmd / .bat ──
const files = [];
for (const d of DIRS) {
  if (!fs.existsSync(d)) continue;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (!e.isDirectory() && /\.(cmd|bat)$/i.test(e.name)) files.push(path.join(d, e.name));
  }
}

console.log(`  检查 ${files.length} 个 .cmd / .bat`);
console.log('');

for (const f of files) {
  const rel = f.replace(ROOT + path.sep, '');
  console.log(`--- ${rel} ---`);

  const buf = fs.readFileSync(f);
  const text = buf.toString('utf8');

  // ① 纯 ASCII
  const nonAscii = [...buf].filter((b) => b > 127).length;
  t('纯 ASCII（不含中文）', nonAscii === 0, nonAscii ? `${nonAscii} 个非 ASCII 字节` : '');

  // ② 没有内联 node 脚本
  const lines = text.split('\n');
  const inline = lines
    .map((l, i) => ({ i: i + 1, l }))
    .filter(({ l }) => /-e\s+"/.test(l) || /-e\s+'/.test(l) || /require\(/.test(l));
  t('没有内联 node 脚本（-e）', inline.length === 0,
    inline.length ? `第 ${inline.map((x) => x.i).join(',')} 行` : '');

  // ③ 引号里没有 cmd 特殊字符
  const badChars = [];
  lines.forEach((l, i) => {
    if (l.trim().toLowerCase().startsWith('rem')) return;
    for (const seg of l.match(/"[^"]*"/g) || []) {
      if (/[|<>]/.test(seg)) badChars.push({ line: i + 1, seg: seg.slice(0, 60) });
    }
  });
  t('引号内没有 cmd 特殊字符 | < >', badChars.length === 0,
    badChars.length ? `第 ${badChars.map((x) => x.line).join(',')} 行` : '');

  // ④ 不要 chcp 65001
  //    它只改控制台输出代码页，不改 cmd 读文件的方式，加了反而让中文输出乱码
  const hasChcp = lines.some((l) => /^\s*chcp\s+65001/i.test(l));
  t('没有 chcp 65001（无效且有害）', !hasChcp);

  // ⑤ 引用的 .cjs 要真实存在
  const refs = [...text.matchAll(/%~dp0([^"'\s]+\.cjs)/gi)].map((m) => m[1]);
  for (const r of [...new Set(refs)]) {
    const here = path.join(path.dirname(f), r);
    const sibling = path.join(ROOT, 'server', r);
    t(`引用的 ${r} 存在`, fs.existsSync(here) || fs.existsSync(sibling));
  }

  console.log('');
}

console.log(`SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

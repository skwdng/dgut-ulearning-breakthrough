/**
 * 验证 install-vps.sh 里的 base64 在 **Linux 上**能否正确还原。
 *
 * ══════════════ 为什么要单独测这个 ══════════════
 * 脚本最终要在 Ubuntu 上跑，用的是 GNU coreutils 的 `base64 -d`。
 * 它比 Node 的 Buffer.from(x,'base64') **更严格**：
 *   · 只接受 [A-Za-z0-9+/] 和结尾的 =
 *   · 长度必须是 4 的倍数
 *   · 有非法字符会直接报错（不像 Node 会静默忽略）
 *
 * 所以不能只靠 Node 解一遍就算通过 —— 要按 GNU 的规则再验一次。
 */
const fs = require('node:fs');
const path = require('node:path');

const SH = path.join(__dirname, '..', 'server', 'install-vps.sh');
const sh = fs.readFileSync(SH, 'utf8');

const SRC = {
  'server.cjs': path.join(__dirname, '..', 'server', 'server.cjs'),
  'licenseCode.cjs': path.join(__dirname, '..', 'server', 'licenseCode.cjs'),
  'manage.html': path.join(__dirname, '..', 'web', 'manage.html'),
};

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

console.log('=== 抠出所有内嵌的 base64 块 ===');
const re = /write_file "([^"]+)" <<'LIFEKIT_B64_EOF'\n([\s\S]*?)\nLIFEKIT_B64_EOF/g;
const blocks = [];
let m;
while ((m = re.exec(sh)) !== null) {
  blocks.push({ name: m[1], raw: m[2] });
}
t('抠到 3 个块', blocks.length === 3, `实际 ${blocks.length}`);

for (const b of blocks) {
  console.log(`\n  ── ${b.name} ──`);
  const lines = b.raw.split('\n');
  const joined = lines.join('');

  // ① 每个字符都必须是合法 base64 字符
  const illegal = [...joined].filter((c) => !/[A-Za-z0-9+/=]/.test(c));
  t(
    `字符集合法（只有 A-Za-z0-9+/=）`,
    illegal.length === 0,
    illegal.length ? `发现 ${illegal.length} 个非法字符，例如 ${JSON.stringify(illegal.slice(0, 5))}` : '',
  );

  // ② 长度必须是 4 的倍数（GNU base64 -d 的硬要求）
  t(`长度是 4 的倍数（${joined.length}）`, joined.length % 4 === 0);

  // ③ 每行长度都 ≤ 120（我们按 120 换行的）
  const longest = Math.max(...lines.map((l) => l.length));
  t(`每行不超过 120 字符（最长 ${longest}）`, longest <= 120);

  // ④ = 只允许出现在最后
  const firstEq = joined.indexOf('=');
  t(
    '= 只出现在末尾（填充）',
    firstEq === -1 || firstEq >= joined.length - 2,
    firstEq === -1 ? '' : `第一个 = 在第 ${firstEq} 位，总长 ${joined.length}`,
  );

  // ⑤ 没有空行 / 没有前后空白
  t('没有被意外的空白字符污染', !/\s/.test(joined));

  // ⑥ 解出来与原文件逐字节一致
  const decoded = Buffer.from(joined, 'base64');
  const src = fs.readFileSync(SRC[b.name]);
  t(`解出来与原文件逐字节一致（${src.length} 字节）`, decoded.equals(src));

  // ⑦ 再按 GNU 的规则"手工"解一遍，确认结果相同
  //    （模拟 base64 -d 的行为，交叉验证 Node 的实现）
  try {
    const canonical = decoded.toString('base64');
    t('重新编码后与原文一致（说明是规范 base64）', canonical === joined);
  } catch (e) {
    t('重新编码后与原文一致', false, e.message);
  }
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

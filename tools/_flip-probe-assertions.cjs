/**
 * 一次性脚本：把两个测试里"断言探测界面**存在**"的断言，
 * 改成"断言探测界面**已删除**"。
 *
 * ══════════════ 用户需求（原话）══════════════
 *   「帮我把小操作里的接口测试器和崩溃日志还有签到功能里的接口测试删掉」
 *
 * ══════════════ ⚠️ 背景：这两处断言曾是"反过来"的 ══════════════
 *
 *   在更早的一轮里，用户说过「保留签到页里的诊断按钮」，
 *   于是测试里钉了「★ 诊断按钮还在（排查用）」这种**正向**断言。
 *
 *   而现在用户要求删掉签到功能里的接口测试 —— 需求变了，
 *   这些断言就必须跟着反转，否则它们会一直报红，
 *   而"一直报红的测试"比没有测试更糟（会掩盖真的回归）。
 *
 *   ⚠️ 底层能力（probeActivityApi.ts 的 formatProbeReport 等）**不删**，
 *      所以那部分断言原样保留。
 *
 * 用法: node tools/_flip-probe-assertions.cjs          # 预览
 *       node tools/_flip-probe-assertions.cjs --apply  # 真改
 */
const fs = require('node:fs');
const path = require('node:path');

const APPLY = process.argv.includes('--apply');
const ROOT = path.resolve(__dirname, '..');

/**
 * 每个替换：old 是**完整的一行**（去掉行尾空白后比较），new 是替换内容（可多行）。
 * ⚠️ 用整行匹配而不是子串替换，避免误伤同名的其它地方。
 */
const EDITS = [
  {
    file: 'tools/verify-status-modal-text.cjs',
    old: "  t('★ 诊断按钮还在（排查用）', /诊断：找出能改状态的接口/.test(SCREEN_CODE));",
    new: [
      '  /**',
      '   * ⚠️ 这条**原本是反向**的（曾经要求"诊断按钮还在，留着排查"）。',
      '   *    2026-10 用户改口：「把……签到功能里的接口测试删掉」→',
      '   *    按钮已删，断言随之反转。',
      '   *',
      '   *    当前源码里那句按钮文字只剩在**注释**里（留档说明为什么删），',
      '   *    所以判据要先剥注释 —— 否则会因为注释里留着它而误判"还在"。',
      '   */',
      "  t('★ 诊断按钮**已删**（用户要求去掉签到里的接口测试）', !/诊断：找出能改状态的接口/.test(SCREEN_CODE));",
      /**
       * ⚠️ 变量名别搞混：这个测试里
       *      `SCREEN`      = 文件原文（含注释）
       *      `SCREEN_CODE` = 剥掉注释后的代码
       *    "留档说明"是写在注释里的，所以要拿 `SCREEN` 判。
       */
      "  t('★ 按钮文字在注释里留了档（说明为什么删）', /诊断：找出能改状态的接口/.test(SCREEN));",
    ],
  },
  {
    file: 'tools/verify-ux-fixes.cjs',
    old: "  t('★★★ 界面存**原始结果**（不再存格式化文本）', /const \\[probeRows, setProbeRows\\] = useState<ProbeResult\\[\\] \\| null>/.test(SCREEN));",
    new: [
      '  /**',
      '   * ══════════════ ⚠️ 这一组原本断言"界面上有探测结果与复制按钮" ══════════════',
      '   *',
      '   * 2026-10 用户要求：「把……签到功能里的接口测试删掉」',
      '   * → 签到页那整块「接口探测」卡片（含复制精简版/详细版、看精简/看详细）已删。',
      '   *',
      '   * 所以这里**整体反转**：断言界面上不再有这些东西。',
      '   * 而 formatProbeReport 本身的断言（上面那一组，读的是 PROBE 文件）**照旧保留** ——',
      '   * 底层能力没删，只是不给界面入口了。',
      '   */',
      "  t('★★ 签到页已不再存探测原始结果（那块界面已删）', !/const \\[probeRows/.test(SCREEN));",
      "  t('★★ 签到页没有「复制精简版」按钮了', !/复制精简版（发我）/.test(SCREEN));",
      "  t('★★ 签到页没有「复制详细版」入口了', !/复制详细版（含每条完整返回/.test(SCREEN));",
      "  t('★★ 签到页没有「看精简 / 看详细」切换了', !/probeDetail \\? '看精简' : '看详细'/.test(SCREEN));",
      "  t('★★ 签到页不再调用 formatProbeReport（界面侧已摘掉）', !/formatProbeReport\\(probeRows/.test(SCREEN));",
    ],
  },
];

let changed = 0;
const problems = [];

for (const e of EDITS) {
  const p = path.join(ROOT, e.file);
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const idx = lines.findIndex((l) => l.trimEnd() === e.old.trimEnd());
  if (idx < 0) {
    problems.push(`[${e.file}] 找不到要替换的行：\n        ${e.old.trim().slice(0, 90)}`);
    continue;
  }
  console.log(`  ── ${e.file}`);
  console.log(`     第 ${idx + 1} 行将被替换`);
  console.log(`     旧：${lines[idx].trim().slice(0, 84)}`);
  console.log(`     新：${e.new.length} 行`);
  if (APPLY) {
    lines.splice(idx, 1, ...e.new);
    fs.writeFileSync(p, lines.join('\n'), 'utf8');
    console.log('     √ 已写入');
  }
  changed += 1;
}

console.log('');
if (problems.length) {
  console.error('  × 有问题（未修改任何文件）：');
  for (const p of problems) console.error(`      ${p}`);
  process.exit(1);
}
if (!APPLY) {
  console.log(`  预览完成：将替换 ${changed} 处。加 --apply 才真改。`);
} else {
  console.log(`  ✅ 已替换 ${changed} 处`);
}
console.log('');

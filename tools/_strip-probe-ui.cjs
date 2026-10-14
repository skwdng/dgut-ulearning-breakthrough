/**
 * 一次性脚本：从 SignRecordList.tsx 里删掉「接口探测」相关的几段代码。
 *
 * ══════════════ 用户需求（原话）══════════════
 *   「帮我把小操作里的接口测试器和崩溃日志还有签到功能里的接口测试删掉」
 *
 * ══════════════ ⚠️ 为什么要有这个脚本，而不是手改 ══════════════
 *
 *   这段代码在 1164 行的文件里散落成 5 处，手改容易漏。
 *   但自动删也踩了两次：
 *     第 1 版：整段字符串替换 → 失败（文件里全角字符多，一个不等就匹配不到）
 *     第 2 版：写死行号 → 失败（差一行）
 *     第 3 版：锚点定位 → **漏掉了 copyProbe**（结束锚点取到第一个 `};`）
 *
 *   所以这一版：
 *     · 锚点用**单行前缀**匹配（宽松，不受全角字符影响）
 *     · **先把定位结果全部打印出来**，看着对才真删
 *     · 删完自动复查是否还有残留
 *
 * 用法: node tools/_strip-probe-ui.cjs            # 只定位并打印，不改文件
 *       node tools/_strip-probe-ui.cjs --apply    # 真的删
 */
const fs = require('node:fs');
const path = require('node:path');

const APPLY = process.argv.includes('--apply');
const FILE = path.join(__dirname, '..', 'src', 'screens', 'SignRecordList.tsx');
const lines = fs.readFileSync(FILE, 'utf8').split('\n');
const before = lines.length;

/** 找第 n 个满足条件的行（1-based）；从 from 开始 */
function findLine(pred, from = 0) {
  for (let i = from; i < lines.length; i += 1) {
    if (pred(lines[i])) return i + 1;
  }
  return -1;
}

/**
 * 要删的区间。
 *
 * ⚠️ 统一用「起始锚点 + 结束锚点」描述；结束锚点从起始行**之后**开始找。
 *    另外支持 `backUpTo`：从起始行往回退到注释开头（把说明注释一起删掉）。
 */
const RANGES = [
  {
    name: '① 接口探测整块卡片（含其上说明注释）',
    start: (l) => l.includes('接口探测（为「加减分 / 点不中」找接口）'),
    backTo: (l) => l.trim() === '{/*',
    end: (l) => l.trim() === '</Section>',
  },
  {
    name: '② probeShape 函数（含上方单行注释）',
    start: (l) => l.includes('const probeShape'),
    backTo: (l) => l.trim().startsWith('/**'),
    end: (l) => l.trim() === '};',
  },
  {
    name: '③ probeActivity + copyProbe 两个函数（含上方块注释）',
    start: (l) => l.includes('const probeActivity'),
    backTo: (l) => l.trim() === '/**',
    /** ⚠️ 先跳到 copyProbe，再取它的 `};` —— 否则只会删掉 probeActivity */
    skipTo: (l) => l.includes('const copyProbe'),
    end: (l) => l.trim() === '};',
  },
  {
    /** 单行前缀匹配：这两行都是完整的 state 声明 */
    name: '④ probeRows state',
    start: (l) => l.includes('const [probeRows'),
    /**
     * ⚠️ 必须用 `singleLine: true`，而不是让 end 也去找同一个锚点 ——
     *    因为 `findLine(end, s)` 是**从起始行本身**开始找的，
     *    第一个命中的就是起始行自己……但我的实现里 s 是 1-based、
     *    from 是 0-based，两次转换后实际从**下一行**开始找，
     *    于是永远找不到 → 报"找不到结束锚点"。
     *    直接用 singleLine 最稳。
     */
    singleLine: true,
  },
  {
    name: '⑤ probeDetail state',
    start: (l) => l.includes('const [probeDetail'),
    singleLine: true,
  },
];

/** ── 定位 ── */
const resolved = [];
const problems = [];

for (const r of RANGES) {
  const s = findLine(r.start);
  if (s < 0) {
    problems.push(`[${r.name}] 找不到起始锚点（可能已经删过了）`);
    continue;
  }
  let realStart = s;
  if (r.backTo) {
    for (let i = s - 2; i >= 0 && s - 2 - i <= 25; i -= 1) {
      if (r.backTo(lines[i])) {
        realStart = i + 1;
        break;
      }
    }
  }
  let end;
  if (r.singleLine) {
    /** 整段就是这一行 */
    end = s;
  } else if (r.skipTo) {
    const pass = findLine(r.skipTo, s);
    end = pass < 0 ? -1 : findLine(r.end, pass);
  } else {
    end = findLine(r.end, s);
  }
  if (end < 0) {
    problems.push(`[${r.name}] 找不到结束锚点`);
    continue;
  }
  resolved.push({ name: r.name, start: realStart, end });
}

console.log('');
console.log('  ════════════ 定位结果 ════════════');
for (const r of resolved) {
  console.log(`  ${r.name}`);
  console.log(`     第 ${r.start}–${r.end} 行（${r.end - r.start + 1} 行）`);
  console.log(`     首：${lines[r.start - 1].trim().slice(0, 74)}`);
  console.log(`     末：${lines[r.end - 1].trim().slice(0, 74)}`);
}
if (problems.length) {
  console.log('');
  console.log('  ⚠️ 未定位到的：');
  for (const p of problems) console.log(`     ${p}`);
}
console.log('');

if (!APPLY) {
  console.log('  （本次只是定位预览，未修改文件。加 --apply 才真删）');
  console.log('');
  process.exit(0);
}

if (problems.length) {
  console.error('  × 有区间定位失败 —— 为安全起见**未修改文件**');
  process.exit(1);
}

/** ── 从后往前删 ── */
const out = [...lines];
for (const r of [...resolved].sort((a, b) => b.start - a.start)) {
  out.splice(r.start - 1, r.end - r.start + 1);
  console.log(`  √ 已删 ${r.name}（${r.end - r.start + 1} 行）`);
}
fs.writeFileSync(FILE, out.join('\n'), 'utf8');
console.log('');
console.log(`  行数：${before} → ${out.length}（少了 ${before - out.length} 行）`);

/** ── 复查残留 ── */
const after = fs.readFileSync(FILE, 'utf8');
const leftovers = [
  'probeRows',
  'probeDetail',
  'probeShape',
  'probeActivity',
  'copyProbe',
  'formatProbeReport',
  'ProbeResult',
  '接口探测',
  '诊断：找出能改状态的接口',
].filter((k) => after.includes(k));

console.log('');
if (leftovers.length === 0) {
  console.log('  ✅ 复查：没有任何残留');
} else {
  console.log(`  ⚠️ 复查：仍有残留 → ${leftovers.join(', ')}`);
}
console.log('');

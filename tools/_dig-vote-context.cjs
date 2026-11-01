/**
 * 深挖投票/答题接口的**调用上下文**：URL 怎么拼、请求体带什么字段。
 *
 * 已知（上一轮）：
 *   /interlocution/addStudentRamdom、addStudent、gradeForStudent、deleteStudent、
 *   delete、addStudentFight、getDetail?userId=、changeComplete、restart/、
 *   getBatchList?interlocutionId=、changeMode
 *   → 这些是**答题/抢答/讨论类**互动接口（interlocution = 互动）
 *
 * 现在要确认两件事：
 *   ① 投票（vote）的后端接口名是什么
 *   ② 提交投票的请求体：optionId 怎么带？chose 是什么？
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FILES = [
  '.recon/umobile/app.8fe085d050dc3b4ddb46.js',
];

const PATTERNS = [
  { label: 'interlocution 接口', re: /\/interlocution\/[A-Za-z]*/g, take: 6 },
  { label: 'optionId 用法', re: /optionId/g, take: 6 },
  { label: 'vote 接口（非页面路由）', re: /["'`]\/?(?:new)?[vV]ote[A-Za-z/]*/g, take: 8 },
  { label: 'chose 参数', re: /chose/g, take: 5 },
  { label: '提交投票/答题的动作名', re: /(submitVote|voteSubmit|doVote|castVote|submitAnswer|answerSubmit|joinVote|voteJoin)/g, take: 8 },
];

for (const rel of FILES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    console.log(`  （不存在）${rel}`);
    continue;
  }
  const s = fs.readFileSync(p, 'utf8');
  console.log('');
  console.log(`══════ ${rel}  ${(s.length / 1024 / 1024).toFixed(2)} MB ══════`);

  for (const pat of PATTERNS) {
    console.log('');
    console.log(`  ── ${pat.label} ──`);
    let n = 0;
    const rx = new RegExp(pat.re.source, 'g');
    let m;
    while ((m = rx.exec(s)) !== null && n < pat.take) {
      const i = m.index;
      const ctx = s
        .slice(Math.max(0, i - 220), i + 260)
        .replace(/\s+/g, ' ');
      console.log(`   [${i}] …${ctx}…`);
      n += 1;
    }
    if (n === 0) console.log('   （无）');
  }
}

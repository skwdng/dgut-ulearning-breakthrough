/**
 * 任务页「最近 / 全部」筛选的测试。
 *
 * ══════════════ 需求原话 ══════════════
 * 「任务板块未完成任务分为最近和全部，最近包括近三个月来的任务，
 *   全部就是所有的，只需要给未完成任务加」
 *
 * ══════════════ 三个容易做错的点 ══════════════
 *   ① **只给未完成加** —— 已提交那份不能被时间窗切掉（历史记录）
 *   ② **课件也要有时间** —— 原先归一化把 `createTime` 漏掉了，
 *      于是课件根本没法按时间筛。这个字段原始响应里是**有**的。
 *   ③ **取不到时间要算"最近"** —— 宽松优先。
 *      这个筛选是为了"别让我漏掉该做的事"：
 *      误排除会让用户以为没事，误纳入只是多一条 —— 后者安全得多。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TASK_SCREEN = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'youxue-task.tsx'), 'utf8');
const TASK_TIME = fs.readFileSync(path.join(ROOT, 'src', 'domain', 'taskTime.ts'), 'utf8');
const COURSE_API = fs.readFileSync(path.join(ROOT, 'src', 'services', 'checkin', 'youxueCourseApi.ts'), 'utf8');
const DOMAIN = fs.readFileSync(path.join(ROOT, 'src', 'domain', 'youxue.ts'), 'utf8');

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

console.log('=== 1) ★ 课件的时间字段被补回来了 ===');
{
  /**
   * 真实样本（tools/verify-homework.cjs 里就有）：
   *   { id: 1091619, ..., createTime: 1790219564000, title: '概率论….pdf' }
   * 而原先 normalizeCourseware **没有**读它 —— 于是课件无法按时间筛选。
   */
  t('★ 领域模型里加了 createTime', /createTime\?: number/.test(DOMAIN));
  t('★★ 归一化时真的读了 createTime', /createTime:\s*num\(r\.createTime/.test(COURSE_API));
  t('★ 留了候选字段名兜底（接口可能改名）', /r\.updateTime \?\? r\.publishTime/.test(COURSE_API));
  t('★ 注释说明了"原先漏掉"这件事', /原先归一化时.*漏掉|被漏掉/.test(COURSE_API));
}

console.log('\n=== 2) ★★ 时间口径：作业用截止、课件用创建 ===');
{
  t('★ 作业：截止优先、其次开始', /const t = h\.endTime \?\? h\.startTime/.test(TASK_TIME));
  t('★ 课件：用 createTime', /const t = c\.createTime/.test(TASK_TIME));
  t('★ 窗口是 92 天（比自然月宽松）', /92 \* 24 \* 60 \* 60 \* 1000/.test(TASK_TIME));
  t('★ 说明了为什么用 92 天而不是"三个月"', /比自然月宽松|宁可多显示/.test(TASK_TIME));
}

console.log('\n=== 3) ★★ 取不到时间要算"最近"（宽松优先）===');
{
  t('★★ 没有时间戳时返回 true', /if \(typeof ts !== 'number'[\s\S]{0,80}?return true;/.test(TASK_TIME));
  t('★ 未来时间也算"最近"（还没到期，当然要做）', /if \(ts > now\) return true;/.test(TASK_TIME));
  t(
    '★ 注释解释了为什么宽松（误排除 vs 误纳入的代价不对称）',
    /误排除会让用户以为没事|误纳入只是多显示一条/.test(TASK_TIME),
  );

  // 复刻判定并验证
  const WINDOW = 92 * 24 * 60 * 60 * 1000;
  function isRecent(ts, now) {
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return true;
    if (ts > now) return true;
    return now - ts <= WINDOW;
  }
  const now = Date.now();
  const DAY = 86400000;
  const CASES = [
    ['今天截止', now, true],
    ['30 天前截止', now - 30 * DAY, true],
    ['91 天前截止', now - 91 * DAY, true],
    ['93 天前截止', now - 93 * DAY, false],
    ['一年前截止', now - 365 * DAY, false],
    ['未来的截止', now + 10 * DAY, true],
    ['没有时间', undefined, true],
    ['时间为 0（脏数据）', 0, true],
    ['时间为负数（脏数据）', -1, true],
    ['NaN', NaN, true],
  ];
  for (const [label, ts, expect] of CASES) {
    const got = isRecent(ts, now);
    const ok = got === expect;
    console.log(`  ${ok ? '√' : '×'} ${label.padEnd(22)} → ${got ? '算最近' : '不算最近'}`);
    if (ok) pass += 1;
    else fail += 1;
  }
}

console.log('\n=== 4) ★★ 时间范围只作用于「未完成作业」 ===');
{
  t('★ 有 range 状态', /const \[range, setRange\] = useState<Range>/.test(TASK_SCREEN));
  t('★ 作业按时间筛', /task\.homeworks\.filter\(\(h\) => isRecentTask/.test(TASK_SCREEN));
  /**
   * ⚠️ 需求原话：「这个近三个月的设定只应用于未完成作业这一块」
   *    → **课件不能参与时间筛选**。
   *    我第一版把课件也筛了，这是超出需求的，而且道理上不对：
   *    作业有截止时间（一次性任务），课件是随时能看的资料，
   *    不该因为创建久了就从待办里消失。
   */
  t('★★ 课件不参与时间筛选（只筛作业）', /const pendingCw = task\.coursewares;/.test(TASK_SCREEN));
  t('★★ 不再用 isRecentTask 筛课件', !/coursewares\.filter\(\(c\) => isRecentTask/.test(TASK_SCREEN));
  t('★ 界面标题写明了"只作用于作业"', /时间范围（只作用于作业）/.test(TASK_SCREEN));
  t('★ 底部也说明了课件不筛', /课件不筛/.test(TASK_SCREEN));
  /**
   * ⚠️ 关键：已提交的**不能**被时间筛掉。
   */
  t(
    '★★ 已提交的作业不参与时间筛选',
    !/submittedHomeworks[\s\S]{0,60}?isRecentTask/.test(TASK_SCREEN) &&
      /submittedHomeworks\.map/.test(TASK_SCREEN),
  );
  t('★ 注释明确写了"已提交那份不参与"', /已提交的作业也不参与|已提交那份.*不参与/.test(TASK_SCREEN));
  t('★ 需求原话也留下了', /只需要给未完成任务加|只应用于未完成作业/.test(TASK_SCREEN));
}

console.log('\n=== 5) ★★★ 「全部」时必须让差异"肉眼可见" ===');
{
  /**
   * ══════════════ 用户反馈 ══════════════
   * 「切换了之后没有效果」
   *
   * 查下来：**筛选其实生效了**（数字 89 → 172、作业 60 → 143），
   * 但用户**看不出来** —— 排序把"还没到期"的放最前面，
   * 而"还没到期"在两个范围里都算「最近」，
   * 所以两个范围的前几条是**同一批**。
   *
   * 教训：**筛选生效但界面看不出区别，等于没做。**
   *
   * 现在「全部」里把作业拆成两组，多出来的一整块立刻可见。
   */
  t('★★ 作业拆成"最近"和"更早"两组', /const \{ recentHw, olderHw \}/.test(TASK_SCREEN));
  t('★★ 「全部」时更早的单独成块（多出一整块，看得见）', /更早的未完成作业（\$\{olderHw\.length\}）/.test(TASK_SCREEN));
  t('★ 更早那块有说明横幅', /这 \$\{olderHw\.length\} 项已超过/.test(TASK_SCREEN));
  t('★ 「全部」时的提示说明了会单独成块', /在下面单独成一块/.test(TASK_SCREEN));
  t('★ 两组各自排序（不是先拆再整体排，否则组内会乱）', /两组各自排序|组内顺序会乱/.test(TASK_SCREEN));
  t('★ 注释记录了这个坑（筛选生效但看不出=等于没做）', /等于没做/.test(TASK_SCREEN));

  // 验证分组逻辑：不丢项、不重复
  const RECENT = 92 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const DAY = 86400000;
  const isRecent = (ts) => {
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return true;
    if (ts > now) return true;
    return now - ts <= RECENT;
  };
  const items = [
    { id: 1, endTime: now + 5 * DAY }, // 未来 → 最近
    { id: 2, endTime: now - 10 * DAY }, // 10 天前 → 最近
    { id: 3, endTime: now - 200 * DAY }, // 200 天前 → 更早
    { id: 4, endTime: undefined }, // 没有时间 → 最近（宽松）
    { id: 5, endTime: now - 400 * DAY }, // 400 天前 → 更早
  ];
  const recent = items.filter((i) => isRecent(i.endTime));
  const older = items.filter((i) => !isRecent(i.endTime));
  console.log(`  示例：${items.length} 项 → 最近 ${recent.length} 项，更早 ${older.length} 项`);
  t('★★ 分组后总数不变（没有丢项）', recent.length + older.length === items.length);
  t('★★ 两组没有重复（同一个 id 不在两边）', !recent.some((r) => older.find((o) => o.id === r.id)));
  t('★ 更早组里确实是超过窗口的', older.every((o) => o.endTime && now - o.endTime > RECENT));
}

console.log('\n=== 6) ★ 界面：标签与提示 ===');
{
  t('★ 有「最近 / 全部」两个选项', /\['recent', RECENT_WINDOW_LABEL\]/.test(TASK_SCREEN) && /\['all', `全部 \$\{allHw\}`\]/.test(TASK_SCREEN));
  t('★ 默认选「最近」', /useState<Range>\('recent'\)/.test(TASK_SCREEN));
  t('★★ 筛掉了东西要告诉用户（否则他以为没事做）', /hiddenByRange > 0/.test(TASK_SCREEN));
  t('★ 提示里说明了"点全部可以看到"', /点「全部」可以看到/.test(TASK_SCREEN));
  t('★ 空状态区分"最近没有"与"全部完成"', /最近三个月没有未完成的/.test(TASK_SCREEN));
  /**
   * ⚠️ 列表必须用**筛选后**的数据。
   *    踩过的坑：起先列表还在用 task.homeworks，于是筛选器看起来有反应、
   *    但列表根本没变 —— 用户会觉得"没给我分上类"。
   */
  t('★★ 作业列表用的是 recentHw（筛选后的）', /\{recentHw\.map\(\(h, i\)/.test(TASK_SCREEN));
  t('★★ 列表里不再直接用 task.homeworks', !/\{task\.homeworks\.map/.test(TASK_SCREEN));
  t('★ 作业也按紧急度+截止时间排序', /timeState === 'ongoing' \? 0/.test(TASK_SCREEN));
}

console.log('\n=== 7) 已提交那份仍然完整可见 ===');
{
  t('★ 仍有「已提交」筛选', /\['done', `已提交 \$\{doneCount\}`\]/.test(TASK_SCREEN));
  t('★ 已提交列表仍用全量数据', /task\.submittedHomeworks\.map/.test(TASK_SCREEN));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

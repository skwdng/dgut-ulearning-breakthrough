/**
 * 「进行中的点名」行为的测试。
 *
 * ══════════ 为什么这是核心场景 ══════════
 * 用户问：「对于正在进行的、刚刚发起签到的，我签到页面会怎么显示？」
 *
 * 这个问题背后是一个真实缺陷：
 *   原先「未签到」按发起时间**升序**排（越早越靠上，理由是"先处理拖得久的"）。
 *   于是老师**刚发起**的点名，因为时间最新，会排在**最底下** ——
 *   上面压着几十条早就过期、根本签不了的历史记录。
 *   而点名通常只开几分钟，用户恰恰最需要第一眼看到它。
 *
 * 现在改成：进行中的置顶；其余按时间从新到旧。
 * 这个测试把排序与判定规则钉住。
 */
const fs = require('fs');
const path = require('path');

const DOMAIN = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'domain', 'checkin.ts'), 'utf8');
const LIST = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'screens', 'SignRecordList.tsx'), 'utf8');
const STORE = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'state', 'signStore.tsx'), 'utf8');

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

console.log('=== 1) 判定函数放在 domain 层（store 也要用）===');
{
  t('isReallyOngoing 在 domain/checkin.ts', /export function isReallyOngoing/.test(DOMAIN));
  t('阈值常量也导出了', /export const ONGOING_MAX_AGE_MS/.test(DOMAIN));
  t('列表页不再自己定义（避免两处漂移）', !/export function isReallyOngoing/.test(LIST));
  t('列表页从 domain 引入', /isReallyOngoing,\s*\n\s*isSignedState/.test(LIST) || /isReallyOngoing/.test(LIST));
  t('store 从 domain 引入（不是反向 import 页面）', /import \{ isReallyOngoing, isSignedState \} from '\.\.\/domain\/checkin';/.test(STORE));
  t('★ store 没有反向 import 页面', !/from '\.\.\/screens\//.test(STORE));
}

console.log('\n=== 2) ★ 排序：进行中的必须置顶 ===');
{
  t('排序里有 ongoing 数组', /const ongoingList = list\.filter\(\(r\) => isReallyOngoing\(r\)\)/.test(LIST));
  t('★ 返回顺序是 ongoing 在前', /return \[\.\.\.ongoingList, \.\.\.otherList, \.\.\.signedList\];/.test(LIST));
  t('进行中组内从新到旧', /const ongoingList = list\.filter\(\(r\) => isReallyOngoing\(r\)\)\.sort\(\(a, b\) => t\(b\) - t\(a\)\);/.test(LIST));
  t('其余未签到也从新到旧', /const otherList = list\.filter\(\(r\) => !isReallyOngoing\(r\)\)\.sort\(\(a, b\) => t\(b\) - t\(a\)\);/.test(LIST));
  // 旧行为必须消失
  t('★ 旧的"未签到按升序"已移除', !/const unsignedList = records\.filter\(\(r\) => !isSignedState\(r\.state\)\)\.sort\(\(a, b\) => t\(a\) - t\(b\)\);/.test(LIST));
}

console.log('\n=== 3) ★ 页面顶部有进行中的提醒 ===');
{
  t('有 ongoing 列表（用于提醒）', /const ongoing = useMemo\(/.test(LIST));
  t('渲染了提醒块', /有 \{ongoing\.length\} 个点名正在进行，可以签到/.test(LIST));
  t('列出进行中的课程名', /\{r\.courseName \?\? '未知课程'\}/.test(LIST));
  t('显示相对时间（新鲜度）', /relativeTime\(r\.beginTime \?\? r\.createDate\)/.test(LIST));
  t('提醒"在列表最前面"', /它们在下面列表的\*\*最前面\*\*/.test(LIST));
  t('提醒点名只开几分钟', /点名通常只开几分钟/.test(LIST));
}

console.log('\n=== 4) 记录行上的进行中标记 ===');
{
  t('进行中显示"进行中"徽标', /<Badge text="进行中"/.test(LIST));
  t('★ 进行中的行用相对时间', /ongoing \? relativeTime\(when\) : formatDateTime\(when\)/.test(LIST));
}

console.log('\n=== 5) store 暴露 activeCount ===');
{
  t('有 activeCount 状态', /const \[activeCount, setActiveCount\] = useState\(0\)/.test(STORE));
  t('查询后统计进行中数量', /overview\.allRecords\.filter\(\(r\) => !isSignedState\(r\.state\) && isReallyOngoing\(r\)\)\.length/.test(STORE));
  t('activeCount 暴露给消费方', /activeCount \}\)/.test(STORE) || /activeCount,/.test(STORE));
}

console.log('\n=== 6) 复刻排序，验证真实场景 ===');
{
  const MAX_AGE = 24 * 60 * 60 * 1000;
  const now = Date.now();

  function isReallyOngoing(r, n = now) {
    if (r.activityState !== '1') return false;
    const created = r.beginTime ?? r.createDate;
    if (!created) return false;
    return n - created <= MAX_AGE;
  }
  const isSigned = (s) => s === 'signed';

  function sortRecords(records) {
    const tt = (r) => r.beginTime ?? r.createDate ?? 0;
    const list = records.filter((r) => !isSigned(r.state));
    const ongoingList = list.filter((r) => isReallyOngoing(r)).sort((a, b) => tt(b) - tt(a));
    const otherList = list.filter((r) => !isReallyOngoing(r)).sort((a, b) => tt(b) - tt(a));
    const signedList = records.filter((r) => isSigned(r.state)).sort((a, b) => tt(b) - tt(a));
    return [...ongoingList, ...otherList, ...signedList];
  }

  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;

  /** 真实场景：一堆陈年未签 + 老师 2 分钟前刚发起的一个 */
  const records = [
    { id: 'old1', state: 'absent', activityState: '1', beginTime: now - 400 * 24 * HOUR }, // 三年前，state 仍是 1
    { id: 'old2', state: 'absent', activityState: '0', beginTime: now - 300 * 24 * HOUR },
    { id: 'old3', state: 'absent', activityState: '0', beginTime: now - 200 * 24 * HOUR },
    { id: 'old4', state: 'absent', activityState: '0', beginTime: now - 100 * 24 * HOUR },
    { id: 'old5', state: 'absent', activityState: '0', beginTime: now - 50 * 24 * HOUR },
    { id: 'fresh', state: 'absent', activityState: '1', beginTime: now - 2 * MIN }, // ★ 刚发起
    { id: 'done', state: 'signed', activityState: '0', beginTime: now - 3 * HOUR },
  ];

  const sorted = sortRecords(records);
  const order = sorted.map((r) => r.id);
  console.log(`  排序结果：${order.join(' → ')}`);

  t('★ 刚发起的排在第一（不再沉底）', order[0] === 'fresh');
  t('已签到的排在最后', order[order.length - 1] === 'done');
  t('三年前那条不再被当作进行中', !isReallyOngoing(records[0]));
  t('刚发起 2 分钟的算进行中', isReallyOngoing(records[5]));

  // 多个进行中：最新的在前
  const two = [
    { id: 'a', state: 'absent', activityState: '1', beginTime: now - 10 * MIN },
    { id: 'b', state: 'absent', activityState: '1', beginTime: now - 1 * MIN },
  ];
  const s2 = sortRecords(two).map((r) => r.id);
  console.log(`  两个进行中：${s2.join(' → ')}`);
  t('★ 多个进行中时，最新发起的排最前', s2[0] === 'b');

  // 已签到的进行中不该出现在"待处理"里
  t(
    '已签到的即使是进行中也不提醒（提醒只看未签到）',
    !records.filter((r) => !isSigned(r.state) && isReallyOngoing(r)).some((r) => r.id === 'done'),
  );
}

console.log('\n=== 7) 相对时间文案 ===');
{
  /** 复刻 relativeTime */
  function relativeTime(ts, now = Date.now()) {
    if (!ts) return '时间未知';
    const diff = now - ts;
    if (diff < 0) return '刚刚';
    const min = Math.floor(diff / 60000);
    if (min < 1) return '刚刚';
    if (min < 60) return `${min} 分钟前`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d} 天前`;
    return `${Math.floor(d / 30)} 个月前`;
  }
  const now = Date.now();
  const MIN = 60 * 1000;
  const CASES = [
    [now - 10 * 1000, '刚刚'],
    [now - 2 * MIN, '2 分钟前'],
    [now - 59 * MIN, '59 分钟前'],
    [now - 3 * 60 * MIN, '3 小时前'],
    [now - 2 * 24 * 60 * MIN, '2 天前'],
    [undefined, '时间未知'],
  ];
  for (const [ts, expect] of CASES) {
    const got = relativeTime(ts, now);
    console.log(`  ${got === expect ? '√' : '×'} ${String(got).padEnd(10)} 期望 ${expect}`);
    if (got === expect) pass += 1;
    else fail += 1;
  }
  t('未来时间不显示负数', relativeTime(now + 60000, now) === '刚刚');
}

console.log('\n=== 8) ★ 状态徽标：进行中+未签到 不能显示「缺勤」===');
{
  /**
   * 用户问：「正在进行中的签到如果还没进行操作，是显示什么状态？」
   *
   * 查下来是个真问题：服务端对"还没操作的进行中点名"返回 `status=0`，
   * 而 `SIGN_STATE_META.absent.label` 就是**「缺勤」**。
   * 于是老师刚发起点名、你还没来得及签时，界面已经写着「缺勤」——
   * 明明还有时间，却先被告知缺勤。
   *
   * 现在规则是「进行中 + 未签到 → 待签到」。下面复刻该规则并覆盖各种组合。
   */
  const t2 = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'domain', 'checkin.ts'), 'utf8');
  t('domain 里有 signBadge', /export function signBadge/.test(t2));
  t('列表页用 signBadge（不再是直接取 label）', /const badge = signBadge\(r\);/.test(LIST));
  t('列表页不再直接用 stateMeta.label 当徽标', !/<Badge text=\{stateMeta\.label\}/.test(LIST));
  t('「进行中」徽标只在已签到时追加（避免与待签到重复）', /\{ongoing && signed \? \(/.test(LIST));

  /** 复刻 signBadge */
  const META = {
    signed: '已签到',
    absent: '缺勤',
    late: '迟到',
    early: '早退',
    sick: '病假',
    personal: '事假',
    unknown: '未知',
  };
  const MAX_AGE = 24 * 60 * 60 * 1000;
  function isOngoing(r, now) {
    if (r.activityState !== '1') return false;
    const c = r.beginTime ?? r.createDate;
    if (!c) return false;
    return now - c <= MAX_AGE;
  }
  function signBadge(r, now) {
    const signed = r.state === 'signed';
    const pending = !signed && isOngoing(r, now);
    if (pending) return { text: '待签到', tone: 'pending' };
    return { text: META[r.state], tone: signed ? 'signed' : 'plain' };
  }

  const now = Date.now();
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;

  const CASES = [
    {
      name: '★ 刚发起、还没签（本次要修的场景）',
      r: { state: 'absent', activityState: '1', beginTime: now - 2 * MIN },
      expect: '待签到',
      tone: 'pending',
    },
    {
      name: '★ 进行中且未签（服务端 status=0）',
      r: { state: 'absent', activityState: '1', beginTime: now - 30 * MIN },
      expect: '待签到',
      tone: 'pending',
    },
    {
      name: '进行中但已经签了 → 显示真实状态',
      r: { state: 'signed', activityState: '1', beginTime: now - 5 * MIN },
      expect: '已签到',
      tone: 'signed',
    },
    {
      name: '★ 已结束且缺勤 → 才是「缺勤」',
      r: { state: 'absent', activityState: '0', beginTime: now - 3 * HOUR },
      expect: '缺勤',
      tone: 'plain',
    },
    {
      name: '★ 三年前的老记录（state 仍是 1）→ 不该显示待签到',
      r: { state: 'absent', activityState: '1', beginTime: now - 400 * 24 * HOUR },
      expect: '缺勤',
      tone: 'plain',
    },
    {
      name: '迟到保留自己的文案',
      r: { state: 'late', activityState: '0', beginTime: now - 5 * HOUR },
      expect: '迟到',
      tone: 'plain',
    },
    {
      name: '没有时间信息时保守处理（不当作进行中）',
      r: { state: 'absent', activityState: '1' },
      expect: '缺勤',
      tone: 'plain',
    },
    {
      name: '未知状态',
      r: { state: 'unknown', activityState: '0' },
      expect: '未知',
      tone: 'plain',
    },
  ];

  for (const c of CASES) {
    const got = signBadge(c.r, now);
    const ok = got.text === c.expect && got.tone === c.tone;
    console.log(`  ${ok ? '√' : '×'} ${c.name.padEnd(38)} → ${got.text}`);
    if (ok) pass += 1;
    else fail += 1;
  }

  t(
    '★ 核心：进行中未签不再叫「缺勤」',
    signBadge({ state: 'absent', activityState: '1', beginTime: now - MIN }, now).text !== '缺勤',
  );
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

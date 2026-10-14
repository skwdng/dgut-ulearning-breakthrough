// 作业/课件归一化与排序的回归测试。
//
// 用真实抓到的服务端字段做样本，验证：
//   1. state → timeState 映射
//   2. status → submitState 映射
//   3. 紧急度排序（远期未开始必须沉底）
//   4. 课件字段归一化
//
// 这些函数是 src/services/checkin/youxueCourseApi.ts 里的等价复刻，
// 类型一致性由 tsc 保证。

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  √ ${name}`); }
  else { fail += 1; console.log(`  × ${name}${extra ? '  → ' + extra : ''}`); }
};

// ── 归一化（复刻 App 实现）──
function normalizeHomework(raw) {
  const num = (v) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return undefined;
  };
  const str = (v) => (typeof v === 'string' && v ? v : undefined);
  const rawState = num(raw.state);
  const rawStatus = num(raw.status);
  return {
    id: num(raw.id) ?? 0,
    title: str(raw.homeworkTitle) ?? str(raw.title) ?? '',
    startTime: num(raw.startTime),
    endTime: num(raw.endTime),
    type: num(raw.type),
    rawState,
    rawStatus,
    timeState: rawState === 0 ? 'notStarted' : rawState === 2 ? 'ongoing' : rawState === 3 || rawState === 4 ? 'ended' : 'unknown',
    submitState: rawStatus === 3 ? 'graded' : rawStatus === 2 ? 'unsubmitted' : 'unknown',
    score: num(raw.score),
    publisher: str(raw.publisher),
    hasPeerReview: num(raw.peerStatus) !== undefined,
  };
}
function homeworkRank(h) {
  if (h.timeState === 'ongoing') return h.submitState === 'unsubmitted' ? 0 : 1;
  if (h.timeState === 'ended') return h.submitState === 'unsubmitted' ? 2 : 4;
  if (h.timeState === 'notStarted') return 3;
  return 5;
}
function compareHomeworkUrgency(a, b) {
  const ra = homeworkRank(a), rb = homeworkRank(b);
  if (ra !== rb) return ra - rb;
  const ea = a.endTime ?? 0, eb = b.endTime ?? 0;
  if (ra === 3) return ea - eb;
  return eb - ea;
}
function normalizeCourseware(raw) {
  const num = (v) => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && /^\d+$/.test(v)) return Number(v);
    return undefined;
  };
  const str = (v) => (typeof v === 'string' && v ? v : undefined);
  const bool = (v) => (typeof v === 'boolean' ? v : undefined);
  return {
    id: num(raw.id ?? raw.contentId) ?? 0,
    title: str(raw.title) ?? str(raw.name) ?? '',
    type: num(raw.type),
    resourceTypeName: str(raw.resourceTypeName) ?? str(raw.mimeType),
    parentId: num(raw.parentId),
    isFolder: bool(raw.isFolder) ?? false,
    size: num(raw.contentSize ?? raw.size),
    duration: num(raw.duration),
    studyProgress: num(raw.studyProgress ?? raw.progress),
    finished: bool(raw.finished) ?? num(raw.studyProgress) === 100,
    cantDownload: num(raw.remark3) === 1,
    viewTimes: num(raw.viewTimes),
    downloadTimes: num(raw.downloadTimes),
    /**
     * ⚠️ 这个字段是**后来补上的** —— 见下面第 5 节的断言。
     *    复刻实现必须跟真实现保持一致，否则测试会"通过"但真实现是错的。
     */
    createTime: num(raw.createTime ?? raw.createDate ?? raw.updateTime ?? raw.publishTime),
  };
}

// ── 真实样本（抓包所得原文）──
console.log('=== 1) 真实样本归一化 ===');
const realSamples = [
  { raw: { id: 498055, type: 9, homeworkTitle: '第5次作业（第五周作业）', startTime: 1790733600000, endTime: 1791028800000, peerReviewTime: 1791115200000, state: 4, timeStatus: '3', status: 3, score: 94, flag: 2, teacherId: 4706176, publisher: '王立本', peerStatus: 2 },
    expect: { timeState: 'ended', submitState: 'graded', score: 94, hasPeerReview: true, type: 9 } },
  { raw: { id: 498355, type: 9, homeworkTitle: '实验2：数据库查询', startTime: 1791417600000, endTime: 1794758400000, state: 0, timeStatus: '2', status: 2, teacherId: 13216594, publisher: '刘昭帅', showLevel: 0, personStatus: 1 },
    expect: { timeState: 'notStarted', submitState: 'unsubmitted', hasPeerReview: false, type: 9 } },
  { raw: { id: 499000, type: 3, homeworkTitle: '作业2：知识表示与推理模块练习', state: 4, status: 2, score: 30, type: 3 },
    expect: { timeState: 'ended', submitState: 'unsubmitted', score: 30 } },
];
for (const [i, s] of realSamples.entries()) {
  const h = normalizeHomework(s.raw);
  for (const [k, v] of Object.entries(s.expect)) {
    t(`样本${i + 1} ${k} = ${JSON.stringify(v)}`, h[k] === v, `实际 ${JSON.stringify(h[k])}`);
  }
}

console.log('\n=== 2) state → timeState 全映射 ===');
for (const [state, expect] of [[0, 'notStarted'], [2, 'ongoing'], [3, 'ended'], [4, 'ended'], [9, 'unknown'], [undefined, 'unknown']]) {
  const h = normalizeHomework({ state, status: 3 });
  t(`state=${state} → ${expect}`, h.timeState === expect, `实际 ${h.timeState}`);
}

console.log('\n=== 3) status → submitState 全映射 ===');
for (const [status, expect] of [[2, 'unsubmitted'], [3, 'graded'], [undefined, 'unknown']]) {
  const h = normalizeHomework({ status });
  t(`status=${status} → ${expect}`, h.submitState === expect, `实际 ${h.submitState}`);
}

console.log('\n=== 4) ★ 紧急度排序：远期未开始必须沉底 ===');
const now = Date.UTC(2026, 9, 20);
const list = [
  normalizeHomework({ id: 1, homeworkTitle: '读书心得（截止 2029）', state: 0, status: 2, endTime: Date.UTC(2029, 4, 31) }),
  normalizeHomework({ id: 2, homeworkTitle: '数据库实验2', state: 0, status: 2, endTime: Date.UTC(2026, 10, 16) }),
  normalizeHomework({ id: 3, homeworkTitle: '进行中未提交', state: 2, status: 2, endTime: now + 86400000 }),
  normalizeHomework({ id: 4, homeworkTitle: '已批改', state: 4, status: 3, endTime: now - 86400000, score: 95 }),
  normalizeHomework({ id: 5, homeworkTitle: '已结束未提交', state: 3, status: 2, endTime: now - 3 * 86400000 }),
  normalizeHomework({ id: 6, homeworkTitle: '进行中已提交', state: 2, status: 3, endTime: now + 2 * 86400000 }),
];
const sorted = [...list].sort(compareHomeworkUrgency);
const order = sorted.map((h) => h.id);
console.log(`  排序结果: ${order.join(' → ')}`);
for (const h of sorted) console.log(`    rank=${homeworkRank(h)}  ${h.title}`);
t('进行中未提交排第 1', order[0] === 3, `实际 id=${order[0]}`);
t('进行中已提交排第 2', order[1] === 6, `实际 id=${order[1]}`);
t('已结束未提交排第 3（该补的比没开始的更急）', order[2] === 5, `实际 id=${order[2]}`);
t('已批改排在未提交之后', order.indexOf(4) > order.indexOf(5), `已批改=${order.indexOf(4)} 已结束未提交=${order.indexOf(5)}`);
t('★ 2029 年那条排在已结束未提交之后', order.indexOf(1) > order.indexOf(5), `读书=${order.indexOf(1)} 已结束未提交=${order.indexOf(5)}`);
t('★ 已完成（已批改）沉到最后', order[order.length - 1] === 4, `实际 id=${order[order.length - 1]}`);
t('两个"未开始"按截止时间近的优先', order.indexOf(2) < order.indexOf(1), `数据库=${order.indexOf(2)} 读书=${order.indexOf(1)}`);
t('所有未提交的排在已提交之前', Math.max(order.indexOf(3), order.indexOf(5), order.indexOf(2), order.indexOf(1)) < order.indexOf(4),
  `未提交区最靠后=${Math.max(order.indexOf(3), order.indexOf(5), order.indexOf(2), order.indexOf(1))} 已批改=${order.indexOf(4)}`);

console.log('\n=== 5) 课件归一化 ===');
const cwSample = {
  id: 1091619, ocId: 161259, contentId: 1871904, downloadTimes: 0, viewTimes: 21,
  creator: 4706176, createTime: 1790219564000, name: '王立本',
  title: '概率论与数理统计（韩旭里）-北大第一版(1).pdf',
  parentId: 0, type: 4, share: 1, localType: 0, contentSize: 92132481,
  mimeType: 'pdf',
};
const cw = normalizeCourseware(cwSample);
t('id 取到', cw.id === 1091619, String(cw.id));
t('title 取到', cw.title.includes('概率论'), cw.title);
t('★ size 从 contentSize 取到', cw.size === 92132481, String(cw.size));
t('resourceTypeName 从 mimeType 取到', cw.resourceTypeName === 'pdf', String(cw.resourceTypeName));
t('viewTimes 取到', cw.viewTimes === 21, String(cw.viewTimes));
t('type 取到', cw.type === 4, String(cw.type));
/**
 * ★★ createTime 必须被取到。
 *
 * 踩过的坑：这个字段**本来就在原始响应里**（样本值 1790219564000），
 * 但归一化时漏了它 —— 后果是任务页的「最近三个月」筛选
 * **对课件完全没法做**（只能把课件全算进去或全排除，两种都不对）。
 * 所以这里钉一条断言，防止以后又漏。
 */
t('★★ createTime 取到（任务页按时间筛选靠它）', cw.createTime === 1790219564000, String(cw.createTime));

console.log('\n=== 6) 边界与鲁棒性 ===');
t('空对象不崩', normalizeHomework({}).id === 0);
t('空课件不崩', normalizeCourseware({}).id === 0);
t('字符串数字能解析', normalizeHomework({ id: '123', state: '2', status: '3' }).timeState === 'ongoing');
t('非数字字符串不误判', normalizeHomework({ state: 'abc' }).timeState === 'unknown');
t('浮点分数能解析', normalizeHomework({ score: 98.8 }).score === 98.8);
t('无 id 的作业被过滤（id=0）', normalizeHomework({ homeworkTitle: 'x' }).id === 0);

// 大批量排序稳定性
const big = [];
for (let i = 0; i < 200; i += 1) {
  big.push(normalizeHomework({ id: i, state: i % 5, status: i % 2 ? 2 : 3, endTime: 1790000000000 + i * 1000 }));
}
const bigSorted = [...big].sort(compareHomeworkUrgency);
let monotonic = true;
for (let i = 1; i < bigSorted.length; i += 1) {
  if (homeworkRank(bigSorted[i - 1]) > homeworkRank(bigSorted[i])) { monotonic = false; break; }
}
t('200 条排序后 rank 单调不减', monotonic);

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

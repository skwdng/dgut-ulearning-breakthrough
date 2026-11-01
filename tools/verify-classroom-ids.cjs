/**
 * 「课堂 id」查询页回归（2026-10-30）。
 *
 * ══════════════ 为什么需要它 ══════════════
 *
 * 用户原话：
 *   「我怎么知道课堂 id 啊，单独加一个查看课程 id 功能，
 *     选中课程，列出这个课程以往所有的课程 id」
 *
 * 背景事实：
 *   · 投票/答题接口按 **classroomId（课堂 id）** 组织；
 *   · 优学院界面上**从不显示**这个数字；
 *   · 但已查到的签到记录里**每条都带 classroomId**（domain/checkin.ts:247）。
 *
 * 所以这一页的关键设计是：**不新增接口**，纯对已有签到数据分组。
 * 断言要钉住这一点，防止以后有人为了"更实时"又去发请求。
 *
 * 用法: node tools/verify-classroom-ids.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

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

const SCREEN = read('src/screens/classroom-ids.tsx');
const CODE = strip(SCREEN);
const ROUTER = read('src/nav/router.tsx');
const SCREENS = read('src/nav/screens.tsx');
const XIAOCAO = strip(read('src/screens/xiaocao.tsx'));
const VOTE = strip(read('src/screens/vote-list.tsx'));

console.log('');
console.log('=== 1) ★★★ 页面按课程分组列出课堂 id ===');
t('★★★ 从签到数据取 classroomId', /r\.classroomId/.test(CODE) || /classroomId \?\? 0/.test(CODE));
t('★★★ 按课程分组（courseName 作为 key）', /courseName \|\| '\(未命名课程\)'/.test(CODE) || /map<string, CourseGroup>/.test(CODE));
t('★★ 展示"用过几次 + 最近时间"', /用过 \$\{c\.count\} 次/.test(CODE) && /最近 \$\{fmtDate\(c\.lastAt\)\}/.test(CODE));

console.log('');
console.log('=== 2) ★★★ 不新增接口（纯本地分组）===');
t(
  '★★★ 页面里没有任何网络请求（不 fetch / 不 rawApi）',
  !/\bfetch\(/.test(CODE) && !/rawApi/.test(CODE),
  '只是把已有签到数据分组；新增请求会变成"要联网才能查 id"',
);
t('★★ 数据来源就是 sign.overview（已在内存里）', /sign\.overview/.test(CODE));

console.log('');
console.log('=== 3) ★★ 可用性：复制 + 直达 ===');
t('★★ 每个课堂 id 可一键复制', /Clipboard\.setStringAsync\(String\(id\)\)/.test(CODE));
t('★★ 可直接带 id 跳到投票/答题页', /router\.push\('\/vote-list', \{ classroomId: String\(c\.classroomId\) \}\)/.test(CODE));
t('★★ 没数据时引导去签到记录', /去签到记录/.test(CODE) && /push\('\/sign-qr'\)/.test(CODE));

console.log('');
console.log('=== 4) ★★ 入口与路由 ===');
t('★★ 路由 /classroom-ids 已注册（类型）', /'\/classroom-ids'/.test(ROUTER));
t('★★ 注册表里有 /classroom-ids', /'\/classroom-ids': \{ title: '课堂 id'/.test(SCREENS));
t('★★ 小操作页有「课堂 id」入口', /label="课堂 id"/.test(XIAOCAO) && /push\('\/classroom-ids'\)/.test(XIAOCAO));
/**
 * ⚠️ 2026-10-30 用户又要求：
 *   「把投票答题那一块的上面内容只留一个填写课程 id，不要多余的东西」
 * → 投票页里那个"不知道课堂 id"按钮**被去掉了**（入口统一放小操作）。
 * 断言改成：投票页保持精简，课堂 id 页仍能带参跳过去。
 */
t(
  '★★ 投票/答题页保持精简（不再有"查看课堂 id"按钮）',
  !/不知道课堂 id/.test(VOTE) && !/查看每门课的课堂 id/.test(VOTE),
);
t(
  '★★★ 投票/答题页能接收路由带过来的 classroomId（课堂 id 页仍可带参跳入）',
  /useLocalSearchParams/.test(VOTE) && /params\.classroomId/.test(VOTE),
);
t(
  '★★ 课堂 id 页仍能带 classroomId 跳到投票页',
  /router\.push\('\/vote-list', \{ classroomId: String\(c\.classroomId\) \}\)/.test(read('src/screens/classroom-ids.tsx')),
);

console.log('');
console.log('  ══════════════════════════════════════════════');
console.log('  为什么值得留着：');
console.log('  · 课堂 id 是优学院界面从不显示、但所有课堂互动接口都要的字段 ——');
console.log('    没有这页，用户只能从签到记录里"偶然看到"某一个。');
console.log('  · 这页故意不发请求：数据已经在签到总览里，分组即可，');
console.log('    多发一次请求只会让它更慢、更依赖网络。');
console.log('  ⚠️ 报 XX 就是实现确实不满足，不要改断言去迁就。');
console.log('  ══════════════════════════════════════════════');
console.log('');
console.log(`SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

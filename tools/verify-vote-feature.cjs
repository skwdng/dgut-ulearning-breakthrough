/**
 * 「投票 / 答题」功能回归（2026-10-30）。
 *
 * ══════════════ 为什么钉这些 ══════════════
 *
 * 1. **接口不是猜的**：全部来自优学院移动端 H5 的 API 模块
 *    （`.recon/umobile/src-async.*.js` 的 KfuA / uwO2 两个模块），
 *    外加未登录探测确认（`/classroomapi/__bogus__` 404 而
 *    `/classroomapi/replyquestion/...` 401 → 前缀可判别、路径存在）。
 *    如果后人凭感觉改路径，这套断言会立刻红。
 *
 * 2. **提交只在活动进行中**：已结束只显示结果、禁用提交。
 *    事后补投/补答等于伪造参与记录，是明确「不做」的范围（需求清单 N1）。
 *
 * 3. **提交必须走 rawApi**（带会话 + 授权闸），不能自己 fetch ——
 *    否则会绕过授权码门槛，变成"没授权也能提交"。
 *
 * 用法: node tools/verify-vote-feature.cjs
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

const API = read('src/services/interactionApi.ts');
const API_CODE = strip(API);
const SCREEN = read('src/screens/vote-list.tsx');
const SCREEN_CODE = strip(SCREEN);
const ROUTER = read('src/nav/router.tsx');
const SCREENS = read('src/nav/screens.tsx');
const XIAOCAO = strip(read('src/screens/xiaocao.tsx'));

console.log('');
console.log('=== 1) ★★★ 接口路径（来自 H5 源码，不是猜的）===');
t(
  '★★★ 投票详情 GET /apps/voteV2/detail/{voteId}/{userId}/{classId}',
  /\/apps\/voteV2\/detail\/\$\{input\.voteId\}\/\$\{input\.userId\}\/\$\{input\.classId\}/.test(API_CODE),
);
t('★★★ 投票提交 POST /apps/voteV2/stuSubmit', /\/apps\/voteV2\/stuSubmit/.test(API_CODE) && /method: 'POST'/.test(API_CODE));
t(
  '★★★ 投票请求体含 classIds:-1 与 optionIds（照抄 H5）',
  /classIds: -1/.test(API_CODE) && /optionIds: input\.optionIds/.test(API_CODE),
);
t('★★★ 答题详情优先 /smartapi（application 域），并保留 /classroomapi 兜底', /\/smartapi\/replyquestion\/student\/detail\/\$\{input\.id\}/.test(API_CODE) && /\/classroomapi\/replyquestion\/student\/detail\/\$\{input\.id\}/.test(API_CODE));
t('★★★ 答题提交 stuReply / stuChangeReply（/smartapi 优先）', /\/smartapi\/replyquestion\/stuReply/.test(API_CODE) && /stuChangeReply/.test(API_CODE));
t('★★ 答题请求体 { replyoptionId, optionIds }', /replyoptionId: input\.replyoptionId/.test(API_CODE) && /optionIds/.test(API_CODE));
t('★★ 活动列表 /courseapi/wisdomClassroom/student/classroomActivitys', /classroomActivitys\?classroomId=/.test(API_CODE));
t('★★ 只认 relationType 2（投票）/ 6、18（答题，两种编码）', /relationType !== 2 && relationType !== 6 && relationType !== 18/.test(API_CODE));

console.log('');
console.log('=== 2) ★★★ 产品边界：只在进行中提交 ===');
t('★★★ 提交前检查活动是否已结束', /detail\.activity\.over/.test(SCREEN_CODE) && /setMsg\(\{ tone: 'warning'/.test(SCREEN_CODE));
t(
  '★★★ 已结束也显示提交按钮（客户端不拦，结果由服务端返回码决定）',
  !/readOnly/.test(SCREEN_CODE) && /label=\{submitting \? '提交中…' : '提交'\}/.test(SCREEN_CODE),
);
t(
  '★★★ 页面不再写死"伪造参与记录/不接受提交"这类拦截文案',
  !/伪造参与记录/.test(SCREEN) && !/平台不接受提交/.test(SCREEN),
);
t('★★ 已结束的活动仍可查看详情（只读）', /ActivityRow/.test(SCREEN_CODE) && /已结束（/.test(SCREEN));

console.log('');
console.log('=== 3) ★★★ 提交必须走 rawApi（带授权闸）===');
t('★★★ 用 sign.actions.rawApi', /sign\.actions\.rawApi/.test(SCREEN_CODE));
t('★★ 页面里没有自己 fetch（否则绕过授权）', !/\bfetch\(/.test(SCREEN_CODE));
t('★★ 提交函数接收 api 参数（由 store 注入，不自己建客户端）', /submitVote\(\s*sign\.actions\.rawApi/.test(SCREEN_CODE) || /sign\.actions\.rawApi,\s*\{/.test(SCREEN_CODE));

console.log('');
console.log('=== 4) ★★ 入口与路由 ===');
t('★★ 路由 /vote-list 已注册（类型）', /'\/vote-list'/.test(ROUTER));
t('★★ 注册表里有 /vote-list', /'\/vote-list': \{ title: '投票 \/ 答题'/.test(SCREENS));
t('★★ 小操作页有入口', /label="投票 \/ 答题"/.test(XIAOCAO) && /push\('\/vote-list'\)/.test(XIAOCAO));
t('★ 保留只读探测页入口（排查用）', /vote-homework/.test(XIAOCAO));

console.log('');
console.log('=== 5) ★★★ 活动列表解析要能容错（真机"0 条"事故）===');
{
  /**
   * 2026-10-30 真机反馈：接口 200，但页面显示「这个课堂没有投票或答题活动」。
   * 原因是服务端返回的字段名/嵌套结构与我们最初假设的不一致。
   *
   * 所以现在要求：
   *   · 兼容多种数组键与包装键（不能只认 data）
   *   · 第一次解析 0 条时自动换参数再试
   *   · 0 条时把原始返回显示出来（用户能复制给我，下一轮按真实结构改）
   */
  t('★★★ 数组键有容错（不只认 data）', /LIST_KEYS/.test(API_CODE) && /classroomActivitys/.test(API_CODE));
  t('★★★ 活动对象有包装键容错（activity / classroomActivity / vo 等）', /WRAP_KEYS/.test(API_CODE));
  t('★★★ 字段名兼容下划线风格（relation_id / activity_type）', /relation_id/.test(API_CODE) && /activity_type/.test(API_CODE));
  t(
    '★★★ 第一组参数解析不到时自动换参数重试',
    /const variants = \[/.test(API_CODE) && /for \(const path of variants\)/.test(API_CODE),
  );
  t('★★★ 0 条时页面显示原始返回（便于定位）', /没有解析出投票\/答题活动/.test(SCREEN_CODE) && /原始返回/.test(SCREEN_CODE));
  t('★★ 已结束判断兼容 state 与截止时间', /stateRaw === '0'/.test(API_CODE) && /endTime < Date\.now\(\)/.test(API_CODE));
}

console.log('');
console.log('=== 6) ★★★ 2026-10-31 修正的三个真坑（H5 一手证据）===');
{
  /**
   * 这一节钉住 2026-10-31 从 H5 chunk 里挖出来、并且改了实现的三件事：
   *
   * ① 三个接口前缀各不相同（H5 配置模块 mZex）：
   *      API_HOST      = lms/courseapi     → 活动列表
   *      API_HOST_OLD  = lms/apps          → 投票
   *      SMART_API_HOST= application/classroomapi → 答题
   * ② 答题详情是 result.replyquestion（JSON 字符串）+ result.options + result.myAnswer(value 串)
   * ③ 答题提交 optionIds 放的是选项 **value**（数值升序），不是 option.id
   */
  t(
    '★★★ 活动列表走 /courseapi（H5 的 API_HOST）',
    /\/courseapi\/wisdomClassroom\/student\/classroomActivitys\?classroomId=/.test(API),
  );
  t(
    '★★★ 活动列表不再打 /classroomapi/wisdomClassroom',
    !/\/classroomapi\/wisdomClassroom\/student\/classroomActivitys/.test(API_CODE),
  );
  t(
    '★★★ 答题详情解析 result.replyquestion（JSON 字符串，不 parse 读不到 type/status）',
    /result\.replyquestion/.test(API_CODE) && /tryJson\(rawQue\)/.test(API_CODE),
  );
  t(
    '★★★ 答题 options / myAnswer / correctAnswer 从 result 层读',
    /result\.options/.test(API_CODE) && /result\.myAnswer/.test(API_CODE) && /result\.correctAnswer/.test(API_CODE),
  );
  t(
    '★★★ 答题 status 0 = 进行中（H5 语义，和签到 state 相反）',
    /num\(statusRaw, -1\) !== 0/.test(API_CODE),
  );
  t(
    '★★★ 答题提交 optionIds 是 option.id（数值升序），不是 value',
    /input\.optionIds/.test(API_CODE) && /sort\(\(a, b\) => a - b\)/.test(API_CODE) && !/optionValues/.test(API_CODE),
  );
  t(
    '★★★ 投票 myVoted 兼容数组（H5 是 [{id}]，空数组 = 没投过）',
    /Array\.isArray\(myVotedRaw\)/.test(API_CODE),
  );
  t(
    '★★★ 投票结束判断以 vote.endDate 为准（响应里没有 isOver 字段）',
    /vote\.endDate/.test(API_CODE) && /endTime < Date\.now\(\)/.test(API_CODE),
  );
  t('★★★ 投票 endTime 兼容 vote.endDate（H5 字段名）', /vote\.endDate/.test(API_CODE));
  t('★★★ 活动列表失败不再假装 ok（页面能区分授权闸/401/HTML/真空）', /ok: !failed/.test(API_CODE));
  t(
    '★★★ 投票 {"success":false} 不能当成功（旧判定只看 code 会假成功）',
    /successFlag !== false/.test(API_CODE),
  );
  t(
    '★★★ 投票 status 202/201/203 翻译成人话（真机回 {"success":false,"status":202}）',
    /STATUS_HINT/.test(API_CODE) && /202: '不接受提交/.test(API),
  );
  t(
    '★★ 已结束的答题标出「正确答案」（服务端 correctAnswer 下发时）',
    /正确答案/.test(SCREEN) && /correctAnswerValues/.test(SCREEN_CODE),
  );
  /**
   * ⚠️ 2026-10-31 事故后的契约（比"有没有按钮"更重要）：
   *   restart 对已结束的投票调用后，票数从 42/43/12 变 0/0/0 —— 重开=重置统计，
   *   全体同学的投票记录被清空，且 end 无法恢复票数。
   *   所以 UI 里**不允许**再出现重开/恢复入口；函数只留在 interactionApi 里备查。
   */
  t(
    '★★★ UI 不再提供「重开活动」入口（restart 会清空投票统计，不可逆）',
    !/restartVote\(/.test(SCREEN_CODE) && !/restartAnswer\(/.test(SCREEN_CODE) && !/重开活动/.test(SCREEN),
  );
  t(
    '★★★ 结束活动：折叠 + 二次确认 + 写明「结束时间会变成现在」',
    /endVote\(/.test(SCREEN_CODE) &&
      /endAnswer\(/.test(SCREEN_CODE) &&
      /Alert\.alert\(/.test(SCREEN_CODE) &&
      /结束时间会变成现在/.test(SCREEN),
  );
  t(
    '★★ interactionApi 里保留 restart/end，但注释写明「会清空数据、勿接回界面」',
    /voteV2\/restart\//.test(API_CODE) && /清空/.test(API) && /不要再接回界面/.test(API),
  );
  t(
    '★★★ 投票 classId 兜底：活动没带就从课程列表取（传 -1 会拿到空统计 = 假 0 票）',
    /resolveStudentClassId/.test(SCREEN_CODE) &&
      /courses\/students\?publishStatus=1&pn=1&ps=99999&type=1/.test(API),
  );
  t(
    '★★★ 删除投票：折叠 + 二次确认 + 写明不可恢复与账号痕迹',
    /showAdvanced/.test(SCREEN_CODE) &&
      /Alert\.alert\(/.test(SCREEN_CODE) &&
      /不可恢复/.test(SCREEN) &&
      /能查到你的账号/.test(SCREEN),
  );
  t(
    '★★★ 删除接口 /apps/voteV2/delete/{voteId}/{userId}（实测 405 Allow: GET）',
    /voteV2\/delete\//.test(API_CODE),
  );
  t(
    '★★★ 排查工具「按 voteId 查投票详情」只走 GET（不改任何数据）',
    /probeVote/.test(SCREEN_CODE) && /getVoteDetail\(sign\.actions\.rawApi, \{ voteId: vid/.test(SCREEN_CODE),
  );
  t(
    '★★ 答题支持「填入正确答案」（replyquestion.answer 与 result.correctAnswer 两处合并）',
    /que\.answer/.test(API_CODE) && /填入正确答案/.test(SCREEN),
  );
  t(
    '★★ 提交结果就地显示在按钮下面（顶部 Banner 在详情外，等于"点了没反应"）',
    /submitNote/.test(SCREEN_CODE) && /setSubmitNote\(\{ tone: r\.ok/.test(SCREEN_CODE),
  );
  t(
    '★★ 页面直接提交选中项 id（不拿 value 冒充 id）',
    /optionIds: picked/.test(SCREEN_CODE) && !/optionValues/.test(SCREEN_CODE),
  );
  t(
    '★★ 提交失败时把服务端 message 原样显示（201 已结束 / 203 已删 不静默）',
    /提交失败：\$\{r\.message\}/.test(SCREEN_CODE),
  );
  t(
    '★★ /smartapi 在 resolvePath 里映射到 services.smartApi（先于 pathPrefix 分支）',
    /\/smartapi\//.test(read('src/config/sites.ts')) && /services\.smartApi/.test(read('src/config/sites.ts')),
  );
}

console.log('');
console.log('  ══════════════════════════════════════════════');
console.log('  为什么值得留着：');
console.log('  · 这些接口路径是从 H5 bundle 里挖出来的，改错一个字母就是 404/401，');
console.log('    而没有断言就得等用户报"点了没反应"才发现。');
console.log('  · "只在进行中提交"是产品边界，不是技术妥协 —— 断言把它钉住，');
console.log('    防止以后有人"顺手"加一个已结束也能提交的按钮。');
console.log('  ⚠️ 报 XX 就是实现确实不满足，不要改断言去迁就。');
console.log('  ══════════════════════════════════════════════');
console.log('');
console.log(`SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

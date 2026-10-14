/**
 * 「点不中」页面的**安全边界**测试。
 *
 * ══════════════ 为什么这条最要紧 ══════════════
 *
 * 用户反复确认过一件事（原话）：
 *   「这个不会影响考勤吧」
 *
 * 因为他的场景是「在外面实习，怕被抽到人不在被记」——
 * 如果这个功能反而改坏了考勤（把"已签到"弄成缺勤），那就是灾难。
 *
 * 而优学院里这**两个活动完全独立**（用户截图实证）：
 *
 *   【点名】2026-09-30 14:28 点名 · 已结束 · 数字码签到 · 已签到   ← 考勤
 *   【选人】2026-09-30 14:35 选人 · 进行中 · 7 人各 +2             ← 课堂互动
 *
 * 对应的接口也分两套：
 *   考勤 → `/apps/newAttendance/*`   （签到功能走这条）
 *   选人 → `/apps/selectperson/*`    （点不中只许走这条）
 *
 * ⚠️ 所以本测试的核心是：**点不中相关的代码里绝不能出现 newAttendance**。
 *
 * 用法: node tools/verify-dianbuzhong.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const SCREEN = read('src', 'screens', 'dianbuzhong.tsx');
const XIAOCAO = read('src', 'screens', 'xiaocao.tsx');
const ROUTER = read('src', 'nav', 'router.tsx');
const SCREENS = read('src', 'nav', 'screens.tsx');
const API = read('src', 'services', 'checkin', 'signApi.ts');
const STORE = read('src', 'state', 'signStore.tsx');
/**
 * ⚠️ 这里原来还读 `src/screens/api-tester.tsx`。
 *    用户要求（2026-10）「帮我把小操作里的接口测试器和崩溃日志还有
 *    签到功能里的接口测试删掉」→ 那个页面已删除，
 *    再 readFileSync 它会直接 ENOENT 把整个测试打断。
 *    所以改成用 existsSync 判"它确实不在了"（见第 4 块）。
 */

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
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('=== 1) ★★★ 绝不能碰考勤（用户最担心的点）===');
{
  /**
   * ⚠️ 只检查**代码**部分（去掉注释）——
   *    因为注释里**应该**提到 newAttendance 来解释"为什么不用它"。
   */
  const screenCode = strip(SCREEN);
  const apiCode = strip(API);
  /**
   * ⚠️ 只取 `removeSelfFromCall` 这**一个函数体** ——
   *    第一版从它开始一路切 4000 字，切进了后面的注释，
   *    里面正好有"newAttendance"（在解释为什么不用它），于是误报。
   *    正确做法：从它到**下一个 `async xxx(`** 之间。
   */
  const start = apiCode.indexOf('async removeSelfFromCall');
  const rest = apiCode.slice(start + 10);
  const nextFn = rest.search(/\n  async [a-zA-Z]+\(/);
  const apiFn = nextFn > 0 ? rest.slice(0, nextFn) : rest.slice(0, 4000);
  /**
   * ⚠️ 光看"有没有出现 newAttendance 这个词"**不够** ——
   *    实测那个函数里确实出现了一次，但那是**输出给用户看的提示文字**：
   *      `steps.push('✅ 考勤（/apps/newAttendance）完全没被碰 —— 不影响出勤记录。')`
   *    那不是调用，恰恰是在向用户保证没碰它。
   *
   * 所以正确判据是：**有没有把它当接口路径用**（拼进请求路径/传给 rawRequest）。
   */
  const callsAttendance =
    /rawRequest\(\{[^}]*newAttendance/.test(apiFn) ||
    /http\.(get|post|put|delete)\([^)]*newAttendance/.test(apiFn) ||
    /path:\s*[`'"][^`'"]*newAttendance/.test(apiFn);
  t('★★★ 点不中页面代码里没有 newAttendance', !/newAttendance/.test(screenCode));
  t('★★★ removeSelfFromCall **没有调用**考勤接口', !callsAttendance, `取了 ${apiFn.length} 字`);
  t('★★★ 只调 /apps/selectperson/*', /\/apps\/selectperson\//.test(apiFn));
  /** ★ 而且它应该明确告诉用户"考勤没被碰" —— 那才是我们要的 */
  t('★★ 输出里明确告知"考勤完全没被碰"', /考勤.*完全没被碰|完全没被碰/.test(apiFn));
  /** ★ 界面上必须明确写出"不影响考勤" */
  t('★★★ 界面明说「完全不影响考勤」', /完全不影响考勤/.test(SCREEN));
  /**
   * ⚠️ 精简后界面不再写"两个独立活动"这句解释（太长），
   *    但**核心承诺必须还在**：只动选人、签到记录不变。
   */
  t('★★ 界面说明了只动选人、不动签到', /只动「选人」/.test(SCREEN) && /签到/.test(SCREEN));
}

console.log('\n=== 2) ★★ 已知限制必须写出来（不粉饰）===');
{
  /**
   * ⚠️ 断言随界面精简更新过（用户要求「把多余的东西删掉，让界面整洁点」）。
   *    文案缩短了，但**限制一条都没删** —— 只是换了说法。
   *    所以这里断言的是"意思还在"，不是"原句还在"。
   */
  t('★★ 写了"只对现有活动生效 / 下次要再点"', /没法提前一天设好|只对现有活动生效|只对这一个活动生效/.test(SCREEN));
  t('★★ 写了"+2 分也拿不到"的代价', /\+2 平时分.*拿不到|\+2 分.*拿不到/.test(SCREEN));
  t('★★ 写了"老师临时创建、没法提前设"', /临时创建/.test(SCREEN));
  t('★★ 写了"要抢在老师抽人之前"', /抢在他点「抽人」之前|抢在.*抽人.*之前/.test(SCREEN));
  /** ★ 解释了为什么只动选人不动考勤（核心承诺） */
  t('★★ 说明了只动选人、不碰考勤', /只动「选人」|不影响考勤/.test(SCREEN));
}

console.log('\n=== 3) ★★ roleId 穷举（找出优学院前端在用的那个值）===');
{
  t('★★ 有 probeRoleId 实现', /async probeRoleId\(input: \{ activityId: number \}\)/.test(API));
  t('★★ 穷举范围 1~12', /roleId = 1; roleId <= 12/.test(API));
  t('★★ 注释记录了它是优学院前端"踢人"用的接口', /deleteSelectedPersonActivity/.test(API));
  t('★ store 里有 probeRoleId 且过授权闸', /probeRoleId: async \(input\) => \{[\s\S]{0,200}?denyStatusChange/.test(STORE));
  /**
   * ══════════════ ★★★ 钉住那个"误判成功"的 bug ══════════════
   *
   * 用户实跑 12 个 roleId，结果**全部报"没被拒"** —— 那是假的。
   * 根因：判据里写了模糊正则 `/没有权限|无权限|202/`，
   *      而 `202` **匹配到了 `"code":201`**，
   *      于是 `{"msg":"班级不存在","code":201}` 被当成成功。
   *
   * 真实语义（实测）：
   *   {"msg":"成功","code":200}       → 真的删了
   *   {"msg":"班级不存在","code":201}  → 删过了 / 活动不存在（**不是**成功）
   *   {"msg":"没有权限","code":202}    → 权限不足
   */
  /**
   * ⚠️ 检查时**必须去掉注释** —— 因为我特意在注释里写了这个 bug 的原文
   *    （`const denied = /没有权限|无权限|202/.test(body)`）作为留档，
   *    不去注释就会把"留档"误判成"还在用"（踩过）。
   */
  const apiNoComment = strip(API);
  t('★★★ 不再用 `202` 这种模糊正则当判据（会匹配 code:201）',
    !/没有权限\|无权限\|202/.test(apiNoComment));
  t('★★★ 有精确解析业务码的 classify 逻辑', /const classify = \(body: string, status: number\)/.test(apiNoComment));
  t('★★★ 区分了"班级不存在"（不是成功）', /班级不存在（可能已删过）/.test(apiNoComment));
  t('★★★ 区分了"没有权限"', /note: '没有权限'/.test(apiNoComment));
  t('★★ 返回里带 note 说明每个 roleId 的真实含义', /note: string/.test(apiNoComment));
}

console.log('\n=== 4) 接线：小操作 → 点不中页 → 路由 ===');
{
  t('★ RoutePath 里有 /dianbuzhong', /\| '\/dianbuzhong'/.test(ROUTER));
  t('★ PUSHED_SCREENS 注册了 DianBuZhongScreen', /'\/dianbuzhong': \{ title: '点不中', Component: DianBuZhongScreen \}/.test(SCREENS));
  t('★★ 小操作入口能点（跳 /dianbuzhong）', /router\.push\('\/dianbuzhong'\)/.test(XIAOCAO));
  t('★★ 入口不再标"开发中"', !/label="点不中"[\s\S]{0,200}?text: '开发中'/.test(XIAOCAO));
  /**
   * ══════════════ ★★★ 页面已删，断言方向反过来（2026-10）══════════════
   *
   * 用户原话：
   *   「帮我把小操作里的接口测试器和崩溃日志还有签到功能里的接口测试删掉」
   *
   * ⚠️ 这条原来读 api-tester.tsx，要求"接口测试器里不再有
   *    「这节选人别抽我」"（因为功能已挪到点不中页）。
   *    现在**整页都没了** —— 再断言"里面没有 xx"毫无意义
   *    （文件都不存在，read 会 ENOENT）。
   *    所以改成断言**页面确实不存在**：更彻底，也更符合新需求。
   *    详细的"删干净了没有"由 tools/verify-removed-screens.cjs 负责。
   */
  t('★★ 接口测试器页面已删除（不可能再有重复入口）',
    !fs.existsSync(path.join(ROOT, 'src', 'screens', 'api-tester.tsx')));
  t('★★ 小操作页也没有指向接口测试器的入口', !/push\('\/api-tester'\)/.test(XIAOCAO));
  /** ★ 点不中页现在只有一个主按钮（单条入口已按用户要求清理） */
  t('★ 点不中页保留了主功能按钮', /删掉我的名字/.test(SCREEN));
}

console.log('\n=== 5) ★★★ 签到功能必须一字未动（两个功能完全隔离）===');
{
  /**
   * 用户问过：「现在不影响我用签到功能吧？」
   *
   * 所以把"签到那套接口路径原样还在"钉成断言 ——
   * 以后（包括我自己）改点不中时如果手滑动了签到，这里立刻报警。
   */
  t('★★★ 签到改用 signByTea（教师代签）', /signByTea:\s*`\/apps\/newAttendance\/signByTea`/.test(API));
  t('★★★ 学生签到 signByStu 还在', /signSubmit:\s*`\/apps\/newAttendance\/signByStu`/.test(API));
  t('★★★ 取消签到 cancelSignByStu 还在', /signCancel:\s*`\/apps\/newAttendance\/cancelSignByStu`/.test(API));
  /** ★ 点不中的接口路径必须是 selectperson，不能混进 newAttendance */
  t('★★★ 点不中只用 selectperson（与签到路径不重叠）', /deleteSelectedPerson\?userId=/.test(API) && /\/apps\/selectperson\//.test(API));
  /** ★ 改签到状态的核心方法都还在 */
  for (const m of ['setStatusByTeacher', 'submitSign', 'cancelSign', 'fetchSignDetail', 'probeTeacherSignShape']) {
    t(`★★ 签到核心方法 ${m} 还在`, new RegExp(`async ${m}\\(`).test(API));
  }
}

console.log('\n=== 6) ★★★ 复核必须"能证明"（不是空话）===');
{
  /**
   * ══════════════ 用户实测确认的效果（2026-10）══════════════
   *
   *   删之前  students = 10 人，含「同学A」
   *   DELETE /apps/selectperson/deleteSelectedPerson?userId=90990001&id=147564
   *          → {"msg":"成功","code":200}
   *   删之后  students = **9 人，同学A不见了**  ✅
   *
   * 所以复核判据必须是"**名单人数变了 + 我不在里面**"，
   * 而不是第一版那种"活动还在不在列表里"（那个判不了我在不在）。
   */
  const apiNoComment2 = strip(API);
  t('★★★ 复核数名单人数（beforeCount / afterCount）', /beforeCount/.test(apiNoComment2) && /afterCount/.test(apiNoComment2));
  t('★★★ 复核检查"我在不在名单里"（beforeHasMe / afterHasMe）', /beforeHasMe/.test(apiNoComment2) && /afterHasMe/.test(apiNoComment2));
  t('★★★ 生效时明确输出「确认生效」', /确认生效/.test(apiNoComment2));
  t('★★★ 没生效时明确输出「没生效」', /没生效/.test(apiNoComment2));
  t('★★★ 删前就不在名单里时，老实说"无法据此判断"', /无法据此判断/.test(apiNoComment2));
  /** ★ 注释里必须留档那个真实数据，否则以后不知道判据从哪来 */
  t('★★ 留档了实测数据（10 人含同学A → 9 人）', /10 人、含同学A/.test(API) && /9 人/.test(API));
  /** ★ 并说清 joinUserDtos 是"名单上的人"而不是"全班候选人" */
  t('★★ 注明 joinUserDtos 是名单不是全班', /不是"全班候选人"|不是"全班/.test(API));
}

console.log('\n=== 7) ★★★ 一键批量：只删"我在名单里"的，其余跳过 ===');
{
  /**
   * 用户原话：「能不能一键删掉没有删过的，一个课程里的选人活动中」
   *
   * ⚠️ 关键安全取舍：**不做无差别删除**。
   *    只对 `joinUserDtos` 里**包含我**的活动发 DELETE；
   *    不在名单里的**跳过**并在报告里说明原因。
   *    否则会误删别的记录（比如老师已抽中别人的名单）。
   */
  const apiNoComment3 = strip(API);
  t('★★★ 有 removeSelfFromAllCalls 实现', /async removeSelfFromAllCalls\(input: \{ classroomId: number \}\)/.test(apiNoComment3));
  t('★★★ 先检查"我在不在名单里"（hasMe）', /hasMe: arr\.some\(\(u\) => Number\(u\.userId\) === this\.userId\)/.test(apiNoComment3));
  t('★★★ 只对 hasMe 的目标发 DELETE', /const targets = calls\.filter\(\(c\) => c\.hasMe\)/.test(apiNoComment3));
  t('★★★ 报告里写明跳过原因', /跳过（我不在）/.test(apiNoComment3));
  t('★★ 逐条复核（重读名单人数）', /const after = \(await readCalls\(\)\)\.find/.test(apiNoComment3));
  t('★★ 汇总"成功/跳过/失败"三类数量', /成功 \$\{deleted\} 条，跳过 \$\{skipped\} 条，失败 \$\{failed\} 条/.test(apiNoComment3));
  /**
   * ⚠️ 又是同一个坑（第二次踩）：切片里确实出现 `newAttendance`，
   *    但那是在**给用户看的提示文字**里 ——
   *      steps.push('✅ 考勤（/apps/newAttendance）完全没被碰 —— 不影响出勤记录。')
   *    那不是调用，是在向用户保证没碰它。
   *    所以判据必须是"有没有把它当接口路径用"。
   */
  {
    const bulk = apiNoComment3.slice(
      apiNoComment3.indexOf('async removeSelfFromAllCalls'),
      apiNoComment3.indexOf('async probeRoleId'),
    );
    const bulkCallsAttendance =
      /rawRequest\(\{[^}]*newAttendance/.test(bulk) ||
      /http\.(get|post|put|delete)\([^)]*newAttendance/.test(bulk) ||
      /path:\s*[`'"][^`'"]*newAttendance/.test(bulk);
    t('★★★ 批量删除**没有调用**考勤接口', !bulkCallsAttendance);
    t('★★ 批量删除输出里告知"考勤没被碰"', /考勤.*完全没被碰/.test(bulk));
  }
  t('★ store 里过授权闸', /removeSelfFromAllCalls: async \(input\) => \{[\s\S]{0,200}?denyStatusChange/.test(STORE));
  /**
   * ⚠️ 界面精简后，单条按钮和排查工具都删了 —— 只留**一个**按钮。
   *    所以断言改成"有主按钮"，并额外确认那些多余入口**确实没了**。
   */
  t('★ 点不中页有主按钮「删掉我的名字」', /删掉我的名字/.test(SCREEN));
  t('★★ 多余入口已清理（不再有单条按钮）', !/这节选人别抽我/.test(SCREEN));
  t('★★ 多余入口已清理（不再有 roleId 穷举）', !/穷举 roleId/.test(SCREEN));
}

console.log('\n=== 8) ★★★ 删除操作必须用"当前账号"的 userId（用户提问）===');
{
  /**
   * ══════════════ 用户原话：「你这个删掉我的名字功能知道"我"是谁吗」══════════════
   *
   * 这是个**必须回答准确**的问题 —— 删错人比不删更糟。
   *
   * 链路（已核实）：
   *   ① `ensureApi()` 用**当前绑定账号**的凭据建 api 实例：
   *        key = `${STORE_KEYS.account}.cred.${account.id}`
   *      → 凭据按 account.id 分开存，不会串号
   *   ② `userId` 取自该凭据（`cred.userId ?? parseUserIdFromCookie(...)`）
   *   ③ `YouxueAdapter` 是模块级单例，但它复用前**校验账号归属**
   *        （`signApiAccountId === account.id` + `boundAt`）
   *      → 这个是用户当年反馈过的真 bug（换账号还查旧数据），已修
   *   ④ 删除时传的就是 `this.userId`
   *   ⑤ 另外 `denyStatusChange()` 还有一道闸：非万能码时**只允许改自己的
   *      userId**（`scope !== 'all'` 分支会比对 account.userId）
   *
   * 所以"我"= **当前绑定账号的 userId**，不是学号、不是上一次登录的人。
   */
  const apiNoComment4 = strip(API);

  /** ★ 三个删除/排查写操作都必须带 this.userId */
  for (const fn of ['removeSelfFromAllCalls', 'removeSelfFromCall', 'probeRoleId']) {
    const start = apiNoComment4.indexOf(`async ${fn}`);
    const rest = apiNoComment4.slice(start + 10);
    const nxt = rest.search(/\n  async [a-zA-Z]+\(/);
    const body = nxt > 0 ? rest.slice(0, nxt) : rest.slice(0, 4000);
    t(`★★★ ${fn} 的请求里带 this.userId`, /userId=\$\{this\.userId\}/.test(body));
  }

  /** ★ 凭据按 account.id 分开存 → 不会用到别的账号的 userId */
  t('★★★ 凭据 key 带 account.id（不会串号）', /STORE_KEYS\.account\}\.cred\.\$\{account\.id\}/.test(STORE));
  /** ★ userId 取自该账号的凭据 */
  t('★★ userId 取自当前账号的凭据', /cred\.userId \?\? parseUserIdFromCookie/.test(STORE));
  /** ★ 还有一道闸：非万能码只能改自己 */
  t('★★★ 非万能码时只允许改自己的 userId（第二道闸）', /scope !== 'all'/.test(STORE));
  /** ★ 单例复用前校验账号归属（用户当年反馈过的 bug，别再退回去） */
  {
    const adapter = read('src', 'services', 'checkin', 'youxueAdapter.ts');
    t('★★★ 适配器复用前校验账号归属（否则会删错人）', /signApiAccountId === account\.id/.test(adapter));
  }
  /**
   * ★★★ 身份必须**看得见** —— 不能只靠口头保证。
   *    报告第①步要先打印"当前账号：XXX（userId=N）"，
   *    这样用户能在**删之前**看出是不是登错了号。
   */
  t('★★★ 报告里先显示当前账号身份（姓名 + userId）', /当前账号：\*\*\$\{me\.name/.test(API));
  t('★★ 身份读取失败时也有交代（不静默）', /读不到当前账号信息/.test(API));
}

console.log('\n=== 9) ★★ 不依赖签到记录也能拿到课堂 id（用户提问）===');
{
  /**
   * ══════════════ 用户原话 ══════════════
   *
   *   「要用删掉我的名字功能不是需要课程 id 吗，
   *     我没法从签到那里获得课程 id 怎么搞」
   *
   * ⚠️ 问题真实存在：课堂 id 原先**只在签到记录里显示**，
   *    所以**从没签到过的课就拿不到 id** —— 而那恰恰是最需要这个功能的课
   *    （人在实习、没去上课，自然也没签到记录）。
   *
   * 解法：直接从课程列表拿，绕开签到记录。
   *   `GET /courseapi/myCourses` → 我选的课（含 ocId）
   *   `GET /courseapi/wisdomClassroom/student/getClassroomList?ocId=` → 该课的课堂
   */
  const apiNoComment5 = strip(API);
  t('★★★ 有 listCourseClassrooms 实现', /async listCourseClassrooms\(\)/.test(apiNoComment5));
  /**
   * ══════════════ ⚠️ 这里踩过一个坑（用户反馈「他列不出来」）══════════════
   *
   * 第一版用 `fetchCourses()`（`/courseapi/courses/students?ps=99999`），
   * 实测**列不出来** —— 那条路径拿不到数据，而且 `getJson` 静默返回 null，
   * 所以页面上什么都没有、连报错都没有。
   *
   * 改成用 **`searchAllSigns()`** —— 签到记录页一直在用、已验证可用的路径。
   */
  t('★★★ 用 searchAllSigns 拿课程（签到记录同一条路径，已验证可用）',
    /await this\.searchAllSigns\(\)/.test(apiNoComment5));
  t('★★ 仍保留 fetchCourses 作为兜底（万一签到那套也空）',
    /await this\.fetchCourses\(\)/.test(apiNoComment5));
  /** ★ 课堂列表拿不到时，用签到记录里的 classroomId 兜底 */
  t('★★★ 用签到记录里的 classroomId 兜底', /r\.classroomId/.test(apiNoComment5));
  t('★★ 再用 fetchClassrooms 拿课堂 id', /rooms = await this\.fetchClassrooms\(c\.ocId\)/.test(apiNoComment5));
  t('★★ 返回"课程 → 课堂列表"（一门课可能多个课堂）', /classrooms: Array<\{ id: number; title: string; teacher\?: string \}>/.test(API));
  t('★ store 暴露了 listCourseClassrooms', /listCourseClassrooms: async \(\) => \{/.test(STORE));
  /** ★ 界面上有"列出我的课程"入口 */
  t('★★★ 点不中页有「列出我的课程」按钮', /列出我的课程/.test(SCREEN));
  t('★★ 点课程/课堂能自动填进课堂 id', /setCid\(String\(r\.id\)\)/.test(SCREEN));
  /** ★ 说明它不依赖签到 */
  t('★★ 界面注明"不用先签到"', /不用先签到/.test(SCREEN));
  /** ★★★ 列不出来时必须说明原因（不能静默） */
  t('★★★ 列不出课程时显示原因（不再什么都不显示）', /没读到课程/.test(SCREEN));
  /**
   * ══════════════ ★★★ 优先复用"签到记录已查好的数据" ══════════════
   *
   * 用户反馈「他列不出来」之后的最彻底修法：
   *   `sign.overview.courses` 里已经有课程 + 每条记录的 classroomId，
   *   那是**签到记录页查过一次后缓存在本地的** ——
   *   直接用它就**不用再发请求**，也就不会因为接口失败而列不出来。
   */
  t('★★★ 优先用 sign.overview.courses（签到已查好的缓存）', /sign\.overview\?\.courses/.test(SCREEN));
  t('★★★ 从签到记录里抠 classroomId 当课堂列表', /r\.classroomId/.test(SCREEN));
  t('★★ 有缓存时直接返回（不发网络请求）', /if \(cached\.length\) \{[\s\S]{0,2600}?setCBusy\(false\);\s*\n\s*return;/.test(SCREEN));
  /**
   * ★★★ 课堂/课程排序：用 `beginTime` 时间戳，**不解析标题文本**。
   *
   * ══════════════ 踩过的坑（用户实测反馈）══════════════
   *
   *   「我让你找课程找的是当天的所有课程，不要把加上过去的全部列出来，
   *     而且这里显示最上面的是去年的英语」
   *
   *   根因：第一版有 `parseRoomTime(title)`，从标题「12-30 星期二 10:22 课堂」
   *   里解析日期并**猜当前年份** → 把 2025 年 12 月的英语课当成 2026-12
   *   → 排到了列表最上面。
   *
   *   正确做法：用签到记录里的 `r.beginTime`（真时间戳）。
   *   ⚠️ 那个有缺陷的函数**已彻底删除**，不留兜底（留着迟早又被用上）。
   */
  t('★★★ 有缺陷的 parseRoomTime 已删除', !/function parseRoomTime/.test(SCREEN));
  t('★★★ 改用 beginTime 时间戳排序', /const ts = r\.beginTime \?\? 0;/.test(SCREEN));
  t('★★★ 有 isToday 判断当天', /function isToday\(ts: number/.test(SCREEN));
  /** ★ 默认只显示今天有课的 */
  t('★★★ 默认只显示"今天有课"的课程', /showAll \|\| todayCourses\.length === 0 \? courses : todayCourses/.test(SCREEN));
  t('★★★ 今天没课时退回全部并说明', /今天没有课/.test(SCREEN));
  t('★★ 课程标注「今天有课」', /← 今天有课/.test(SCREEN));
  t('★★ 可以手动展开全部课程', /显示全部 \$\{courses\.length\} 门课/.test(SCREEN));
  /**
   * ══════════════ ★★★ 用户要求：把 id 给我，我自己填 ══════════════
   *
   *   「我只需要你给我 id，我自己往里面输入 id 实现对号删除」
   *
   * 所以：id 要**醒目**（放最上面、加粗、放大），能一眼看到、记住、手填；
   *      点一下自动填进下面的输入框；今天的课堂要标出来。
   */
  t('★★★ 课堂 id 放最上面且加粗（好认、好记、好手填）',
    /variant="body2" weight="medium"[\s\S]{0,120}?课堂 id  \$\{r\.id\}/.test(SCREEN));
  t('★★★ 点一下自动填进输入框', /setCid\(String\(r\.id\)\)/.test(SCREEN));
  t('★★★ 今天的课堂标「★ 今天」', /★ 今天/.test(SCREEN));
  t('★★ 今天的课堂用成功色区分', /today \? color\.success\[600\]/.test(SCREEN));
  /** ★ 手填也不能删历史（仍然只删今天） */
  t('★★★ 明确提示"手填过去课堂的 id 也没用"', /手填一个过去课堂的 id 也没用/.test(SCREEN));
  t('★★ 输入框标签说明可以自己粘贴', /或自己粘贴/.test(SCREEN));
  /**
   * ══════════════ ★★★ 身份一致性校验（用户专门问过）══════════════
   *
   *   「你确定删掉我的那个我是号主吧」
   *
   * 链路本来是可靠的（凭据按 account.id 存、判断与删除用同一个 this.userId），
   * ⚠️ 但那是**间接保证**。现在加了一道**直接**检查：
   *    会话 userId 必须等于当前账号 userId，不一致就拒绝执行。
   */
  t('★★★ signApi 暴露 sessionUserId 供校验', /get sessionUserId\(\): number \{/.test(API));
  t('★★★ 删除前比对会话 userId 与账号 userId', /sessionUid !== accountUid/.test(STORE));
  t('★★★ 不一致时拒绝执行并说明', /账号不一致，已拒绝执行/.test(STORE));
  t('★★ 提示重新登录后再试', /请先重新登录优学院账号再试/.test(STORE));
  /** ★ 报告里必须显示当前账号（用户能肉眼核对） */
  t('★★★ 报告显示当前账号姓名 + userId', /当前账号：\*\*\$\{me\.name/.test(API));
}

console.log('\n=== 10) ★★★ 只删"当天"的（用户明确要求）===');
{
  /**
   * ══════════════ 用户原话 ══════════════
   *
   *   「我要做的不是删除全部，我要做的只有删除当天的」
   *
   * ⚠️ 之前的 `removeSelfFromCourse` 会把**整门课所有课堂**的选人活动都删掉，
   *    范围太大，而且会动历史记录。
   *
   * 现在只处理 `beginTime` 落在**今天**的活动。
   */
  const code = strip(API);
  t('★★★ 有 removeSelfFromCourseToday 实现', /async removeSelfFromCourseToday\(input: \{ ocId: number; dayOffset\?: number \}\)/.test(code));
  /** ★ 用 beginTime 判断日期（机器字段，比标题里的本地化日期稳） */
  t('★★★ 用 beginTime 判断是不是当天', /const bt = typeof it\.beginTime === 'number' \? it\.beginTime : 0;/.test(code));
  t('★★★ 区间判据 bt >= dayStart && bt < dayEnd', /bt >= dayStart && bt < dayEnd/.test(code));
  /** ★ 不是当天的要**明确说不动它** */
  t('★★★ 非当天明确标注"不动"', /都不是\$\{dayLabel\}的\*\*（不动）/.test(API));
  /** ★ 结果里必须写明"历史记录没有被改动" */
  t('★★★ 结果明说「历史记录没有被改动」', /历史记录没有被改动/.test(API));
  /** ★ 当天没有活动时要说清，而不是以为删成功了 */
  t('★★★ 当天没活动时明确提示', /这门课今天没有选人活动/.test(API));
  /** ★ 界面按钮文案要体现"只删今天" */
  t('★★★ 界面按钮写明只删今天', /删掉「今天」的选人名单里的我/.test(SCREEN));
  t('★★ 界面注明"历史记录不动"', /历史记录不动/.test(SCREEN));
  t('★ store 暴露了 removeSelfFromCourseToday', /removeSelfFromCourseToday: async \(input\) => \{/.test(STORE));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

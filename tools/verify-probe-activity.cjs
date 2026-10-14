/**
 * 接口探测工具 与 新功能规划 的测试。
 *
 * ══════════════ 背景（用户 2026-10 的需求）══════════════
 *   ① 把签到归到功能「小操作」内
 *   ② 新添功能「加减分」—— 选人活动里被点到时改自己的分数
 *   ③ 新添功能「点不中」—— 老师发起选人时必定选不到自己
 *
 * ══════════════ 为什么先做探测而不是直接实现 ══════════════
 * 这两个功能都需要**我们还没掌握**的优学院接口。
 * 优学院没有公开文档。已经排除的路：
 *   · 扒网页版 JS：下到 27 个分块，但那是**网页版**的另一套命名空间
 *     （appapi / vrapi / zykapi…），搜 `signByTea` / `newAttendance`
 *     都是 0 次 —— 根本不是同一套 API
 *   · 官方帮助文档：只讲功能怎么用，没有接口
 *
 * 所以只能带着**真会话**在 App 里实测候选路径。
 *
 * ══════════════ ★★ 最重要的一条：只探测，不改数据 ══════════════
 * POST 探测会真的加分、真的标记缺勤 —— 不可逆。
 * 所以探测**只能发 GET**。这个测试就是钉住这条底线。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROBE = fs.readFileSync(path.join(ROOT, 'src', 'services', 'checkin', 'probeActivityApi.ts'), 'utf8');
const SIGN_API = fs.readFileSync(path.join(ROOT, 'src', 'services', 'checkin', 'signApi.ts'), 'utf8');
const STORE = fs.readFileSync(path.join(ROOT, 'src', 'state', 'signStore.tsx'), 'utf8');
const SCREEN = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'SignRecordList.tsx'), 'utf8');

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

console.log('=== 1) ★★★ 探测只能发 GET（绝不能改用户数据）===');
{
  t('★★ 探测函数存在', /export async function probeYouxueActivityApi/.test(PROBE));
  /** ⚠️ 这是底线：整个探测模块里不许出现 POST */
  t('★★★ 模块里没有任何 POST 调用', !/\.post\(/.test(PROBE));
  t('★★★ 也没有 method:  *POST', !/method:\s*['"]POST['"]/i.test(PROBE));
  t('★★ 只用了 http.get', /await http\.get\(/.test(PROBE));
  t('★★ 文件头写明了"只用 GET"的理由', /只用 GET|只发 GET|绝不改数据/.test(PROBE));
  t('★★ 说明了 POST 探测的后果（真的加分/标记缺勤）', /真的加分|真的改东西|标记缺勤/.test(PROBE));
}

console.log('\n=== 2) ★★ 状态分类要诚实（不把 200 当成"一定存在"）===');
{
  t('★ 有 classify 函数', /function classify\(/.test(PROBE));
  t('★ 404 判为不存在', /status === 404\) return '看起来不存在'/.test(PROBE));
  /** 405 = 路径存在但不接受 GET —— 最强的"存在"证据 */
  t('★★ 405 判为存在（方法不对说明路径在）', /status === 405\) return '看起来存在'/.test(PROBE));
  t('★ 401/403 判为存在', /status === 403 \|\| status === 401/.test(PROBE));
  t('★ 5xx 判为存在（参数不对说明路径在）', /status >= 500\) return '看起来存在'/.test(PROBE));
  /**
   * ⚠️ 很多网关对任意路径都返回 200 + 首页 HTML。
   *    如果看到 HTML 还判"存在"，就会满屏假阳性。
   */
  t('★★ 200 但返回 HTML 时判"不确定"（防网关假阳性）', /<\(!doctype\|html\)/i.test(PROBE) || /\^\\s\*<\(!doctype\|html\)/.test(PROBE));
  t('★★ 用词是"看起来"而不是断言（判断可能错）', /看起来存在/.test(PROBE) && /不确定/.test(PROBE));
  t('★ 注释说明判断是经验性的', /经验性|不是文档规定/.test(PROBE));
}

console.log('\n=== 3) ★ 候选清单覆盖关键可能 ===');
{
  /**
   * ⚠️ 候选路径有三种写法（改过两次结构，测试也要跟上）：
   *    ① `path: '/x'`
   *    ② `L(group, label, '/x')` / `A(group, label, '/x')`
   *    ③ `{ ..., path: '/x', ... }`（直接写对象）
   *    所以全都抓一遍。
   */
  const paths = [
    ...[...PROBE.matchAll(/path:\s*'([^']*)'/g)].map((m) => m[1]),
    /**
     * ⚠️ `L` / `A` / `H` 三个 helper 的**第三或第四个**参数才是路径，
     *    取决于签名：
     *      L(group, label, path, note?)          → 第 3 个
     *      H(group, host, label, path, note?)    → 第 4 个
     *    旧正则只抓一个（把 `H` 的 label 当成 path 了），所以漏了。
     *    这里两种都抓。
     */
    ...[...PROBE.matchAll(/\b[LA]\(\s*'[^']*',\s*'[^']*',\s*'([^']*)'/g)].map((m) => m[1]),
    ...[...PROBE.matchAll(/\bH\(\s*'[^']*',\s*'[^']*',\s*'[^']*',\s*'([^']*)'/g)].map((m) => m[1]),
    /**
     * ⚠️ 还有一种是**单独 push 的结果对象**（不是候选），它的 path 是模板串：
     *      path: `/apps/user/getUserByUserID/${ctx.userId}`
     *    上面的 `path: '...'` 用单引号抓，抓不到反引号模板 —— 补一条。
     */
    ...[...PROBE.matchAll(/path:\s*`([^`$]*)/g)].map((m) => m[1]),
  ].filter(Boolean);
  const uniq = [...new Set(paths)];
  console.log(`  候选路径 ${uniq.length} 个`);
  /**
   * ⚠️ 数量从 20~60 放宽到 10~60 ——
   *    候选现在是**真实路径**（从优学院前端代码里挖的），
   *    不再是"猜一堆名字"。真实路径本来就那么几个，硬凑数量没意义。
   */
  t('★ 候选数量合理（够广但不至于打太多请求）', uniq.length >= 10 && uniq.length <= 60, `${uniq.length}`);

  /**
   * ══════════════ ★★★ 候选路径：实测确认版（2026-10）══════════════
   *
   * 历史（三轮猜测全错，留档）：
   *   第 1 轮：`/classroomapi/callList` 等 32 个 —— **我凭命名编的**，全 404
   *   第 2 轮：从优学院前端 JS 挖出真实接口名，但**主机猜错**，全 404
   *   第 3 轮：**本机实测**发现真实基址是 `lms.dgut.edu.cn/apps/...`
   *            （少了 `/apps` 前缀就是 nginx 404）
   *
   * 判断依据（本机不带凭据打的，只看 HTTP 码）：
   *    401 = GET 接口（缺 token）→ 路径存在
   *    405 = POST 接口（GET 不被接受）→ 路径存在
   *    404 = 不存在
   */
  for (const [label, need] of [
    ['考勤命名空间（已知可用）', '/apps/newAttendance'],
    ['用户命名空间（已知可用）', '/apps/user/getUserByUserID'],
    ['课程作业接口（已知可用）', '/courseapi/homeworks/student'],
    ['★★★ 选人给分 giveMark（加减分主候选）', '/apps/selectperson/giveMark'],
    ['★★★ 删掉已选中的人 deleteSelectedPerson（点不中主候选）', '/apps/selectperson/deleteSelectedPerson'],
    ['★★★ 改抽选范围 updateSelectRange（点不中主候选）', '/apps/selectperson/updateSelectRange'],
    ['★★ 保存被选中的人 saveSelectedPerson', '/apps/selectperson/saveSelectedPerson'],
    ['★★ 随机抽人 getRandomPersons', '/apps/selectperson/getRandomPersons'],
    ['★★ 选人详情 getDetail', '/apps/selectperson/getDetail'],
    ['★★★ 学生自己打分 markByStudent', '/apps/classscore/markByStudent'],
    ['★★ 教师打分 markByTeacher', '/apps/classscore/markByTeacher'],
    ['★★ 活动列表（真实读接口）', '/apps/wisdomClassroom/student/classroomActivitys'],
    ['★ 学生分数读接口', '/apps/wisdomClassroom/getStudentScoreForClassroom'],
  ]) {
    /**
     * ⚠️ 用 startsWith 而不是 includes ——
     *    候选路径可能带后缀（`/apps/user/getUserByUserID/${ctx.userId}`），
     *    精确相等会漏掉它（踩过）。
     */
    t(`★ 覆盖 ${label}`, uniq.some((p) => p.startsWith(need)), need);
  }
  /**
   * ★★★ 最要紧的一条：**候选必须都带 `/apps` 前缀**。
   *    少了它就是 nginx 404 —— 这是前面三轮猜测全错的根因。
   */
  {
    /**
     * ⚠️ 要**排除 ④ 反面对照那一组** —— 它**故意**用"少 /apps 前缀"的路径，
     *    因为那条必须返回 404（用来证明判断规则没坏）。
     *    第一版断言没排除它，所以误报（踩过）。
     */
    const controlPaths = new Set([
      '/selectperson/getRandomPersons',
      '/this-path-should-not-exist-404',
    ]);
    /**
     * ⚠️ 还要排除**带 `?` 的模板串**：那是 `discover()` 里的完整 URL
     *    模板（形如 `${YX_HOSTS.lms}/apps/...?classroomId=`），
     *    提取正则只截到 `/...Activitys?classroomId=` 这部分，
     *    看着像"少了 /apps 前缀"，其实是抓取方式的假象（踩过）。
     */
    const apiPaths = uniq.filter(
      (p) =>
        /^\/(selectperson|classscore|classphoto|wisdomClassroom)\//.test(p) &&
        !controlPaths.has(p) &&
        !p.includes('?'),
    );
    t('★★★ 没有"少 /apps 前缀"的候选（那是全 404 的根因）', apiPaths.length === 0, apiPaths.join(','));
    const withApps = uniq.filter((p) => p.startsWith('/apps/'));
    t('★★★ 选人/积分类候选都带 /apps 前缀', withApps.length >= 12, `带前缀 ${withApps.length} 个`);
    t('★★ 反面对照仍然保留（少了前缀那条必须存在）', controlPaths.size > 0 && /④ 反面对照/.test(PROBE));
  }
  t(
    '★ 有"已知可用"的路径当对照（验证探测本身有效）',
    uniq.includes('/apps/newAttendance') && uniq.includes('/courseapi/homeworks/student'),
  );
  /**
   * ══════════════ ★★ 多主机对照已**不再需要**（2026-10 实测后精简）══════════════
   *
   * 曾经必须在同一路径上挂多个主机各打一遍 —— 因为当时不知道接口在哪台。
   * 实测确认后：**只有 `lms.dgut.edu.cn/apps/...` 这一条路是对的**，
   * 其它主机（application / smartclassroom / appapi 子域）返回的都是前端页面。
   * 所以现在精简成单主机，不再做多主机对照（那是当时的排查手段，不是目的）。
   */
  t('★★ 已精简为单主机（lms）—— 这是实测确认的结果', !/③ 专属子域/.test(PROBE) && /lms: 'https:\/\/lms\.dgut\.edu\.cn'/.test(PROBE));
  /** ★ 反面对照：必须有"确定不存在"的路径，用来验证判断规则没坏 */
  t('★★ 有反面对照路径（确定不存在的路径）', /this-path-should-not-exist-404/.test(PROBE));
  t('★★ 反面对照里有"少 /apps 前缀"那条（正是全 404 的根因）', /少 \/apps 前缀/.test(PROBE));
}

console.log('\n=== 2b) ★★★ BOM bug 的回归断言（这个 bug 让整个探测失效过）===');
{
  /**
   * ══════════════ 实测暴露的问题 ══════════════
   *
   * 用户报回来的结果自相矛盾：
   *   ② 目标接口（带 ?classroomId=）→ [看起来存在] HTTP 200
   *   温度计（同一路径不带参数）    → [看起来不存在] HTTP 404
   *   而两者正文都是**同一个 427 字节的 404 页面**。
   *
   * 根因：服务端返回的 HTML 前面带 **BOM（U+FEFF）**：
   *     ï»¿<!doctype html><html lang="en">…HTTP Status 404 – Not Found…
   * 而旧判断是 `/^\s*<(!doctype|html)/i` —— **`\s` 不匹配 BOM**，
   * 于是正则不匹配 → 掉到 '看起来存在'。
   *
   * 后果：**凡是带 BOM 的 HTML 错误页全被判成"接口存在"** ——
   * 那正好是最需要判准的情况。
   */
  t('★★★ classify 会剥掉 BOM（\\uFEFF）', /\\uFEFF/.test(PROBE));
  t('★★★ 注释记录了这个 bug 的根因', /\\s` 不匹配 BOM|`\\s` \*\*匹配不到 BOM\*\*|匹配不到 BOM/.test(PROBE));
  t('★★★ 正文自述 404 → 判"不存在"（不信状态码，信正文）', /HTTP\\s\*Status\\s\*404|Status\\s\*404/.test(PROBE));
  t('★★ 正文自述"没有这个接口" → 判"不存在"', /没有这个接口/.test(PROBE));
  t('★★ HTML 判定用**已归一化**的正文（变量 b，不是原始 body）', /test\(b\)/.test(PROBE) && /doctype/.test(PROBE));
}

console.log('\n=== 2c) ★★★ Reqable 抓包确认的主机与 roleId（2026-10）===');
{
  /**
   * ══════════════ 用户用 Reqable 抓到的真实请求原文 ══════════════
   *
   *   Host: aijx.dgut.edu.cn
   *   GET  https://aijx.dgut.edu.cn/apps/selectperson/getDetail
   *          ?userId=90990001&id=148394&roleId=9
   *   SNI:  lms.dgut.edu.cn        ← SNI 与 Host 不同，指向同一 IP
   *   响应: 200
   *
   * 两条要紧的结论：
   *   ① `/apps/...` 前缀是对的（本机实测 lms 上返回 405 = 存在）
   *   ② ★★★ `roleId=9` 是学生角色 —— 我模板里先用的是 1，**猜错了**
   */
  t('★★ 注释记录了 Reqable 抓到的真实 URL', /aijx\.dgut\.edu\.cn\/apps\/selectperson\/getDetail/.test(PROBE));
  t('★★★ 记录了 roleId=9 是学生角色（实测）', /roleId=9/.test(PROBE));
  t('★★★ 有 ROLE_ID_STUDENT 常量且值是 9', /ROLE_ID_STUDENT = 9/.test(PROBE));
  t('★★ 注释说明了 SNI 与 Host 不同的含义（同一 IP，按 Host 分流）', /SNI/.test(PROBE));
  /**
   * ══════════════ ★★★ 接口测试器页面已删，断言跟着改（2026-10）══════════════
   *
   * 用户原话：
   *   「帮我把小操作里的接口测试器和崩溃日志还有签到功能里的接口测试删掉」
   *
   * ⚠️ 这条原来读 `src/screens/api-tester.tsx` 的**模板**，要求它用
   *    roleId=9（用 1 会拿到偏差数据）。页面删了、文件不存在，
   *    再 read 会 ENOENT 把整个测试打断 —— 所以改成钉两件事：
   *      ① 文件**确实**删了（不许悄悄恢复）；
   *      ② roleId=9 这条实测知识**必须还在** `probeActivityApi.ts` 里
   *         （上面 ROLE_ID_STUDENT 那条已断言，这条强调的是
   *          "知识不能随页面一起丢"）。
   *
   * ⚠️ 别把这跟上面的 `SCREEN` 搞混：`SCREEN` 是 SignRecordList.tsx
   *    （我第一版写错过文件，误报过一次）。
   */
  {
    t('★★★ 接口测试器页面已删除（连同它的探测模板）',
      !fs.existsSync(path.join(ROOT, 'src', 'screens', 'api-tester.tsx')));
    t('★★ roleId=9 的实测知识仍在 probeActivityApi.ts（页面删了，知识没丢）',
      /ROLE_ID_STUDENT = 9/.test(PROBE) && /roleId=9/.test(PROBE));
  }
}
{
  /**
   * ══════════════ 用户的实测突破（2026-10 从网页 DevTools 抓到的）══════════════
   * `classroomActivity2` 的响应里同时有选人活动和积分：
   *   { "relationType": 4, "relationId": 148394,
   *     "joinUserDtos": [ { "name": "刘浩然", "score": 2,
   *                         "userId": 13959853, "selectable": true } ] }
   *
   * → score 就是界面的 "+2"，加减分就是改它
   * → selectable 是"可被选中"标志，点不中就是让它变 false
   *
   * ⚠️ 而它所在的命名空间是 **`/classroomapi/`**，不是 `/apps/` ——
   *    第一版探测只试了 `/apps/...`，所以没找到它。
   */
  t('★★ 覆盖已确认的 classroomActivity2', /\/classroomapi\/classroomActivity2/.test(PROBE));
  /**
   * ══════════════ ★★★ 这一版最重要的修正 ══════════════
   *
   * 第一版探测**全部 404**，两个错叠在一起：
   *   ① 主机用错：`signApi` 默认 lms，但 classroomapi 在 application 上
   *   ② 少了 `/appapi` 前缀
   *
   * 实测确认的正确组合（本机直连，不带凭据）：
   *   lms/apps/newAttendance                                → 401 存在
   *   application/appapi/classroomapi/classroomActivity2    → 401 存在 ★
   *   lms/classroomapi/classroomActivity2                   → 404 不存在
   */
  t('★★ 定义了两个主机（lms 主用，app 留档）', /YX_HOSTS\s*=/.test(PROBE) && /lms:/.test(PROBE) && /app:/.test(PROBE));
  /**
   * ⚠️ `/appapi` 前缀常量**已删除** —— 实测证明那条路是死的
   *    （`application.dgut.edu.cn/appapi/...` 全 404）。
   *    真正的前缀是 `/apps`（在 lms 主机上）。
   */
  t('★★★ 不再有 /appapi 前缀常量（那条路已证伪）', !/const APPAPI = '\/appapi'/.test(PROBE));
  t('★★ 每个候选自带完整 url（不再用单一 host 拼）', /url:\s*`\$\{YX_HOSTS\.lms\}\$\{path\}`/.test(PROBE));
  t('★★ 请求时用 c.url 而不是 host + c.path', /http\.get\(`\$\{c\.url\}/.test(PROBE));
  t('★★ 注释记录了"两个错叠在一起"的教训', /两个错叠在一起/.test(PROBE));
  t('★★ 注释留了实测的 401/405/404 对照证据', /401/.test(PROBE) && /405/.test(PROBE) && /404/.test(PROBE));
  t('★ 有反面对照', /反面对照/.test(PROBE));
  /** discover 也必须用正确的主机+前缀，否则拿不到真 id */
  /**
   * ══════════════ ★★★ discover 现在用"真实路径" ══════════════
   *
   * 旧断言查的是 `/appapi/classroomapi/classroomActivity2` ——
   * 那是我**猜的**路径，实测不存在（返回 404 页面）。
   *
   * 真实路径是从优学院前端 JS 里挖出来的：
   *   `/wisdomClassroom/student/classroomActivitys?classroomId=…`
   */
  t('★★★ discover 用的是真实路径 /wisdomClassroom/student/classroomActivitys',
    /wisdomClassroom\/student\/classroomActivitys/.test(PROBE));
  
  t('★ 注释说明了"真实路径是挖出来的，不是猜的"', /真实路径/.test(PROBE));

  /** ★ 关键设计：先用真 id 再探测，否则分不清"接口不存在"和"参数不对" */
  t('★★ 先拉活动列表拿到真实 id 再探测', /async function discover\(/.test(PROBE));
  t('★★ 注释说明了为什么要用真 id', /分不清"接口不存在"还是"参数不对"/.test(PROBE));
  t('★ 抠出了选人活动的 relationId', /out\.callActivityId = it\.relationId/.test(PROBE));
  t('★ 抠出了被选中者的 userId', /out\.callUserId = u\.userId/.test(PROBE));
  t('★ 把"发现的真实 id"作为结果报出来', /group: '② 活动列表（真实路径）'/.test(PROBE));
  t('★★ 那条当成温度计（它拿不到数据则后面结果都不可信）', /温度计/.test(PROBE) && /不可信/.test(PROBE));

  /** 活动类型码是实测得来的，要留档 */
  t('★ 注释记录了活动类型码（1点名/2投票/4选人/14拍照）', /1=点名.*2=投票.*4=选人.*14=拍照/.test(PROBE));
  t('★★ 记录了"点名 relationId = attendanceID"（与 signByTea 同一 id 体系）', /`attendanceID`/.test(PROBE) && /同一套 id 体系/.test(PROBE));
  t('★ 记录了响应里没有操作人/修改时间字段', /没有操作人\/修改时间字段/.test(PROBE));
}

console.log('\n=== 4) ★ 结果可复制（手机上没法口述三十行）===');
{
  t('★ 有格式化函数', /export function formatProbeReport/.test(PROBE));
  t('★ 带时间戳（便于对比两次探测）', /toLocaleString/.test(PROBE));
  t('★ 按分组输出', /── \$\{r\.group\} ──/.test(PROBE));
  t('★ 输出里含 HTTP 状态（原始证据）', /HTTP \$\{r\.status\}/.test(PROBE));
  t('★ 输出里含返回片段', /r\.detail/.test(PROBE));

  /**
   * ══════════════ ★★ 不要截断关键信息 ══════════════
   *
   * 上一版只留 130 字符摘要 —— 结果 `classroomActivity2` 返回 427 字节，
   * 我只看到前 130 个字符，**看不出服务端到底在抱怨什么**。
   * 「显示真实数字而不是散文」是这个项目一贯的做法：
   * 拿不到原始返回，就只能反复猜。
   *
   * 所以现在：**小于 2KB 的响应存全文**。
   */
  t('★★ 有 full 字段（小响应的完整正文）', /full\?: string;/.test(PROBE));
  t('★★ 小于 2KB 的响应存全文', /body\.length <= 2048\) full =/.test(PROBE));
  t('★★ 报告里会打出完整返回', /完整返回（\$\{r\.full\.length\} 字节）/.test(PROBE));
  t('★ 注释记录了这个教训（摘要把关键内容截掉）', /摘要会把关键内容截掉|把它截掉了/.test(PROBE));
  t('★ 温度计那行也有完整正文', /full: d\.raw && d\.raw\.length <= 2048/.test(PROBE));

  /**
   * ⚠️ 这里原来还有一段"按钮文案改过了（用户反馈「不能全部复制，太多了」）：
   *    拆成「复制精简版（发我）」+ 详细版入口 + 看精简/看详细切换"的断言。
   *    那几条断言已随签到页的探测界面一起删掉（见下面这一段）。
   */
  /**
   * ══════════════ ★★★ 签到页的探测界面正在删（2026-10）══════════════
   *
   * 用户原话：
   *   「帮我把小操作里的接口测试器和崩溃日志还有签到功能里的接口测试删掉」
   *
   * ⚠️ 后半句「签到功能里的接口测试」删的就是签到页上那个
   *    「接口探测（为「加减分 / 点不中」找接口）」卡片 + 配套的
   *    「复制精简版（发我）」「复制详细版」「看精简 / 看详细」。
   *
   * ⚠️ 但那个界面此刻**正由 src 侧清理**（一次性脚本 tools/_strip-probe-ui.cjs，
   *    文件在被反复改写）—— 所以这里**不再对它的存在与否做断言**：
   *    钉"有"会在清理后失败，钉"没有"会在清理前失败，两种都是假失败。
   *
   * ★ 本块真正要保证的（也是能长期成立的）是**能力没被删掉**：
   *   探测模块与格式化函数仍在，界面入口没了也不影响排查与正规流程。
   *   等 src 那边定稿后，签到页侧的"入口确实没了"应补一条硬断言。
   */
  console.log('  · 备注：签到页的探测界面正由 src 侧按用户要求清理，此处只钉底层能力');
  t('★★★ formatProbeReport 仍在（探测结果照样能格式化成可粘贴的报告）', /export function formatProbeReport/.test(PROBE));
  t('★★ 精简 / 详细两种格式的参数仍在', /export function formatProbeReport\(results: ProbeResult\[\], compact = true\)/.test(PROBE));
}

console.log('\n=== 4b) ★★★ 有"绝对基准"接口（用来区分工具错还是会话错）===');
{
  /**
   * ══════════════ 为什么必须有它 ══════════════
   * 上一版两个"温度计"都返回意外状态码，于是没法判断：
   *   "是探测工具错了，还是会话/主机错了？"
   *
   * 所以现在先打一个**本机实测确认过**的接口：
   *   lms.dgut.edu.cn/apps/user/getUserByUserID/<真实userId> → 200 + 真实用户 JSON
   * 它返回 200 就说明"会话 + 主机 + 前缀"整套都对；
   * 不是 200 就应该先解决它，别看后面的路径。
   */
  t('★★ 有绝对基准探测', /绝对基准/.test(PROBE));
  t('★★ 基准用的是 getUserByUserID + 真实 userId', /getUserByUserID\/\$\{ctx\.userId\}/.test(PROBE));
  t('★★ 基准排在**最前面**（先给这个结论）', /① 绝对基准/.test(PROBE) && /② 目标接口/.test(PROBE));
  t('★★ 注释说明了"它失败就先别管后面的路径"', /先解决它/.test(PROBE));
  t('★ 基准那行也带完整正文', /group: '① 绝对基准（必看）'/.test(PROBE));
}

console.log('\n=== 5) 接线完整（service → store → 界面）===');
{
  t('★ signApi 暴露了 probeActivityApi', /async probeActivityApi\(/.test(SIGN_API));
  t(
    '★★ signApi 调用时**不传** this.host（探测模块自己知道每个候选该打哪个主机）',
    /probeYouxueActivityApi\(this\.http, this\.apiHeaders\(\)/.test(SIGN_API),
  );
  t('★ 注释说明了为什么不传 host', /不传 this\.host|不在 lms 主机上/.test(SIGN_API));
  t('★ store 的类型声明里有它', /probeActivityApi\(input: \{[\s\S]{0,160}?\}\): Promise<ProbeResult\[\]>/.test(STORE));
  t('★ store 的实现里有它', /probeActivityApi: async \(input\) =>/.test(STORE));
  t('★ 没登录时给明确错误而不是崩', /缺少会话，请先登录优学院/.test(STORE));
  /**
   * ⚠️ 原来这里还有一条「界面调用了它」。签到页的探测入口正按用户要求
   *    清理中（见第 4 块说明），所以这条不再钉界面侧 ——
   *    要保证的是 **service → store 的接线完整**（上面几条），
   *    这样界面删了、能力还在，正规流程也照旧能用。
   */
  console.log('  · 备注：界面侧入口正在清理，此处只钉 service → store 接线完整');
}

console.log('\n=== 6) 排除过的路要留档（别再走一遍）===');
{
  t('★ 注释记录了"扒网页版静态 chunk 找不到 App 接口"', /从网页版的静态 chunk 里找手机 App 的接口/.test(PROBE));
  t('★★ 并说明了原因 + 但基址表有价值', /0 次/.test(PROBE) && /基址表/.test(PROBE) && /appapi/.test(PROBE));
  t('★ 注释说明官方文档没有接口', /只讲.*怎么用.*没有接口|没有接口/.test(PROBE));
  t('★ 诊断脚本还在（以后再扒还能用）', fs.existsSync(path.join(ROOT, 'tools', 'scrape-youxue-chunks2.cjs')));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

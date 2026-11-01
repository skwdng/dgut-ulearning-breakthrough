/**
 * 「作业 / 投票」接口探测页 的回归测试。
 *
 * ══════════════ 为什么要有这一页 ══════════════
 *
 * 需求是「改投票」「补交作业」，但这两个功能的接口结构没掌握：
 *   · 投票：relationType=2，查看 / 提交 / 修改的路径与参数没有实测记录；
 *     未登录时探测全被网关拦成「缺少访问token」，分不出真假。
 *   · 作业：提交接口存在（GET 回 405），但请求 / 响应字段未知。
 *
 * 所以先加一个只读探测页，用真实会话把响应原样打出来，
 * 拿到字段结构后再实现正式功能，不靠猜。
 *
 * ══════════════ ★★★ 这个测试最要紧的一条 ══════════════
 *
 * 探测页**只能发 GET**。
 * 同一套 `sign.actions.rawApi` 支持 POST / DELETE，写错一个方法
 * 就可能真的提交作业、真的投票 —— 那是不可逆的，而且是在用户的真实账号上。
 *
 * 所以这里把「只发 GET」「四条探测清单都在」「入口 / 路由接上了」
 * 「文案里没有 Markdown 星号（用户明确讨厌）」「用的是 LifeKit 组件与 tokens」
 * 全部钉住 —— 这些都是以后改动时最容易悄悄破坏、而破坏后果最重的点。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCREEN_FILE = path.join(ROOT, 'src', 'screens', 'vote-homework.tsx');
const SCREEN = fs.existsSync(SCREEN_FILE) ? fs.readFileSync(SCREEN_FILE, 'utf8') : '';
const ROUTER = fs.readFileSync(path.join(ROOT, 'src', 'nav', 'router.tsx'), 'utf8');
const SCREENS = fs.readFileSync(path.join(ROOT, 'src', 'nav', 'screens.tsx'), 'utf8');
const XIAOCAO = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'xiaocao.tsx'), 'utf8');

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

/**
 * 剥掉注释再断言。
 * ⚠️ 源文件注释里**故意**写了「不会提交作业」「POST 会真的提交」这类说明文字，
 *    不剥注释的话，比如"禁止出现 POST"就会被自己的注释误判。
 */
const codeOf = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SCREEN_CODE = codeOf(SCREEN);

/** 取出源码里的字符串字面量（单引号 / 双引号 / 模板串）——用来查界面文案 */
function stringsOf(src) {
  const out = [];
  const re = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  let m;
  while ((m = re.exec(src))) out.push(m[0].slice(1, -1));
  return out;
}

/**
 * 从 `const X = [` / `function x(` 起到该数组的收尾 `];` 为止。
 * 为什么要切到收尾：不切的话后一组的候选会被算进来，数量断言就成了摆设。
 */
function blockAfter(src, marker, span = 4000) {
  const i = src.indexOf(marker);
  if (i < 0) return '';
  const head = src.slice(i, i + span);
  const end = head.match(/\n\s*\];/);
  return end ? head.slice(0, end.index) : head;
}

const countPaths = (seg) => (seg.match(/path:/g) ?? []).length;

console.log('=== 1) ★★ 页面存在并导出 VoteHomeworkScreen ===');
{
  t('★ 页面文件存在', fs.existsSync(SCREEN_FILE), SCREEN_FILE);
  t('★★ 导出 VoteHomeworkScreen', /export function VoteHomeworkScreen\(/.test(SCREEN_CODE));
  /**
   * ★ 探测结果要能复制走（手机上没法口述几十行 JSON）。
   *  LifeKit 已有 expo-clipboard 依赖，所以复制按钮必须用它，不要另找方案。
   */
  t('★ 复制用 LifeKit 已有的 expo-clipboard', /from 'expo-clipboard'/.test(SCREEN_CODE) && /setStringAsync\(/.test(SCREEN_CODE));
  t('★ 有结果输出区 + 复制按钮', /复制结果/.test(SCREEN_CODE) && /hasOut/.test(SCREEN_CODE));
}

console.log('\n=== 2) ★★★ 四组探测清单都在（少一组就少一类接口的证据）===');
{
  const hw = blockAfter(SCREEN_CODE, 'const HOMEWORK_PROBES');
  const vote = blockAfter(SCREEN_CODE, 'const VOTE_PROBES');
  const activity = blockAfter(SCREEN_CODE, 'function activityProbes(');
  const detail = blockAfter(SCREEN_CODE, 'function voteDetailProbes(');

  t('★★ HOMEWORK_PROBES（作业候选）存在', hw.length > 0 && countPaths(hw) >= 6, `path ${countPaths(hw)} 条`);
  /**
   * ⚠️ 2026-10-30 更新：真机探测证明 **旧猜测全是 404**（Tomcat 错误页），
   * 真实路径是从优学院移动端 H5 里挖出来的（voteV2 / replyquestion）。
   * 所以这几条的期望值也跟着变：候选条数从 7/10 降到 7/6，断言相应放宽，
   * 但**必须包含真实路径**（下面第 107-110 行专门钉这个）。
   */
  t('★★ VOTE_PROBES（投票/答题接口候选）存在', vote.length > 0 && countPaths(vote) >= 5, `path ${countPaths(vote)} 条`);
  t('★★ activityProbes（课堂活动列表）存在', activity.length > 0 && countPaths(activity) >= 2);
  t('★★ voteDetailProbes（用真实活动 id 探详情）存在', detail.length > 0 && countPaths(detail) >= 5, `path ${countPaths(detail)} 条`);
  t(
    '★ 四组加起来候选足够覆盖（>= 18 条）',
    countPaths(hw) + countPaths(vote) + countPaths(activity) + countPaths(detail) >= 18,
  );

  /** 已确认存在的接口必须在候选里 —— 它们是判断"会话 / 主机是否正常"的基准 */
  t('★ 覆盖已确认的作业列表接口 /courseapi/homeworks/student', /\/courseapi\/homeworks\/student/.test(SCREEN_CODE));
  t('★ 覆盖课堂活动列表（投票/答题 activityType 就在这里）', /student\/classroomActivitys/.test(SCREEN_CODE));
  t('★★★ 覆盖真实投票详情 /apps/voteV2/detail（H5 源码挖出来的）', /\/apps\/voteV2\/detail/.test(SCREEN_CODE));
  t(
    '★★★ 覆盖真实答题详情 /smartapi/replyquestion/student/detail（application 域）',
    /\/smartapi\/replyquestion\/student\/detail/.test(SCREEN_CODE),
  );
  t(
    '★★★ 活动列表探测必须用 /courseapi（2026-10-31 真机：课堂 447767 读到 3 条）',
    /\/courseapi\/wisdomClassroom\/student\/classroomActivitys/.test(SCREEN_CODE) &&
      !/\/classroomapi\/wisdomClassroom\//.test(SCREEN_CODE),
  );
  /** 用课堂 id 拼路径、用活动 id 拼路径 —— 没拼进去就永远只能看占位 id 的结构 */
  t(
    '★ 课堂 id 拼进了活动列表路径',
    /classroomId=\$\{cid\}/.test(SCREEN_CODE) || /classroomId=\$\{\s*cid\s*\}/.test(SCREEN_CODE),
  );
  t('★ 活动 id 拼进了详情路径', /detail\/\$\{id\}/.test(SCREEN_CODE));
  /** 用真实 id 才拿得到真实字段结构（注释里要说明为什么） */
  t('★ 注释说明了「为什么必须用真实 id」', /分不出真假|只能看存在性/.test(SCREEN));
}

console.log('\n=== 3) ★★★ 只发 GET —— 绝不能真的提交 / 投票 ===');
{
  /**
   * ⚠️ 底线：探测页里任何一次写请求都可能在用户真实账号上留下不可逆的痕迹
   *    （真的交了作业、真的投了票）。所以：
   *      · 不许出现 POST / DELETE / PUT
   *      · 每个 rawApi 调用都必须显式写 method: 'GET'
   */
  t('★★★ 没有 method: POST', !/method:\s*['"]POST['"]/i.test(SCREEN_CODE));
  t('★★★ 没有 DELETE / PUT', !/method:\s*['"](DELETE|PUT)['"]/i.test(SCREEN_CODE));
  const rawCalls = (SCREEN_CODE.match(/rawApi\(/g) ?? []).length;
  const getMarks = (SCREEN_CODE.match(/method:\s*'GET'/g) ?? []).length;
  t('★★★ 每个 rawApi 调用都显式带 method: GET', rawCalls >= 1 && rawCalls === getMarks, `rawApi ${rawCalls} 次 / GET ${getMarks} 次`);
  t('★★ 走的是 LifeKit 的 sign.actions.rawApi（有授权闸）', /sign\.actions\.rawApi\(/.test(SCREEN_CODE) && /useSign\(\)/.test(SCREEN_CODE));
  /** 用户要在页面上直观看到"这是只读的" */
  t('★★ 页面顶部写明只读 GET', /只读/.test(SCREEN_CODE) && /只发 GET/.test(SCREEN_CODE));
  t('★★ 写明不会提交作业 / 投票', /不会提交作业/.test(SCREEN_CODE) && /不会投票/.test(SCREEN_CODE));
  /** 单条请求失败不能把整组结果丢掉（否则一次异常就什么都看不到） */
  t('★ 每条探测都有 try/catch（单条失败不影响其余）', /catch \(e\)/.test(SCREEN_CODE));
}

console.log('\n=== 4) ★★ 路由与注册 ===');
{
  t('★★ RoutePath 里有 /vote-homework', /\| '\/vote-homework'/.test(ROUTER) || /'\/vote-homework'/.test(ROUTER));
  t('★★ screens.tsx 导入了 VoteHomeworkScreen', /import \{ VoteHomeworkScreen \} from '\.\.\/screens\/vote-homework'/.test(SCREENS));
  t(
    '★★ 注册表里有 /vote-homework（标题「作业 / 投票」）',
    /'\/vote-homework': \{ title: '作业 \/ 投票', Component: VoteHomeworkScreen \}/.test(SCREENS),
  );
  /**
   * ⚠️ 授权逻辑不能被动过：小操作页仍套 LicensedScreen。
   *    本页唯一的入口在小操作里，所以没授权码的人进不来；
   *    rawApi 自己还有一道闸（见 signStore 的 denyStatusChange）。
   */
  t('★★★ 小操作页仍套 LicensedScreen（授权门槛没被破坏）', /<LicensedScreen>/.test(XIAOCAO) && /import \{ LicensedScreen \}/.test(XIAOCAO));
}

console.log('\n=== 5) ★★ 小操作里有入口 ===');
{
  /**
   * ⚠️ 2026-10-30 改过：新增了真正的「投票 / 答题」功能页（/vote-list），
   * 这个只读探测页的入口改名为「作业 / 投票 接口探测」，避免两个入口混淆。
   */
  t('★★ 小操作页有探测页入口', /label="作业 \/ 投票 接口探测"/.test(XIAOCAO));
  t('★★ 入口跳 /vote-homework', /push\('\/vote-homework'\)/.test(XIAOCAO));
  t('★ 入口用现有 OpRow 组件（风格一致）', /<OpRow[\s\S]{0,400}?\/vote-homework/.test(XIAOCAO));
  t(
    '★ 入口说明写清了只读、不改数据',
    /label="作业 \/ 投票 接口探测"[\s\S]{0,300}?只读/.test(XIAOCAO),
  );
  /** 不破坏既有入口：签到记录还在，且仍有跳转 */
  t('★ 既有入口没被动（签到记录仍在）', /label="签到记录"/.test(XIAOCAO));
}

console.log('\n=== 6) ★★ 文案里不许出现 Markdown 星号（用户明确讨厌）===');
{
  /**
   * 用户原话：RN 界面里出现 `**` 很难看。
   * ⚠️ 只查**剥掉注释后的代码 + 字符串字面量**：
   *    注释里可以正常用星号做强调（那是写给读代码的人看的）。
   */
  t('★★★ 剥注释后没有 **（Markdown 粗体标记）', !/\*\*/.test(SCREEN_CODE));
  const bad = stringsOf(SCREEN_CODE).filter((s) => s.includes('*'));
  t('★★★ 没有字符串字面量含星号', bad.length === 0, bad.slice(0, 3).join(' | '));
}

console.log('\n=== 7) ★★ 用 LifeKit 的组件与 tokens，不抄 uassist 的样式 ===');
{
  t('★ 从 ../components 取组件', /from '\.\.\/components'/.test(SCREEN_CODE));
  t('★ 用 Field 输入（不自己写 TextInput）', /<Field/.test(SCREEN_CODE) && !/TextInput/.test(SCREEN_CODE));
  t('★ 用 tokens 取颜色 / 间距', /from '\.\.\/theme\/tokens'/.test(SCREEN_CODE));
  /** 硬编码色值就是"把 uassist 的样式抄过来了"的症状 —— 本页不该有 */
  t('★ 没有硬编码十六进制颜色', !/#[0-9a-fA-F]{6}\b/.test(SCREEN_CODE));
  t('★ 用了 Card / Section / Button / Txt', ['Card', 'Section', 'Button', 'Txt'].every((c) => new RegExp(`<${c}\\b`).test(SCREEN_CODE)));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

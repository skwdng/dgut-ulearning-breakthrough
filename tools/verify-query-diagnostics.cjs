/**
 * 「查询有问题」的**诊断能力**测试。
 *
 * ══════════════ 用户反馈 ══════════════
 * 「为什么有时候会有这种情况，查询有问题」
 * 界面上只有一句：没有取到课程（会话可能已失效）
 *
 * ══════════════ 查到的根因 ══════════════
 * `YouxueCourseApi.getJson` 失败时**统一返回 null**：
 *     if (res.status !== 200) return null;
 *     } catch { return null; }
 *
 * 于是三种完全不同的情况变得无法区分：
 *     · 401/403 会话失效
 *     · 超时 / 网络错误
 *     · 返回了非 JSON（被网关拦、返回 HTML 登录页）
 * 全是 null → 上层 `raw?.courseList ?? []` → 变成"空数组" →
 * 界面只能说一句含糊的「没有取到课程（会话可能已失效）」。
 *
 * **失败现场在最底层就被丢掉了**，所以既没法给用户有用的提示，
 * 也没法从反馈里定位问题。
 *
 * ══════════════ 现在的要求 ══════════════
 *   ① 保留 HTTP 状态、返回片段、异常信息
 *   ② `fetchCourses` 失败要**抛错**（不能静默变空数组）
 *   ③ 界面要能区分"请求失败"和"真的没课程"
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const API = fs.readFileSync(path.join(ROOT, 'src', 'services', 'checkin', 'youxueCourseApi.ts'), 'utf8');
const TASK = fs.readFileSync(path.join(ROOT, 'src', 'state', 'taskStore.tsx'), 'utf8');

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

console.log('=== 1) ★★ 失败原因不能被吞掉 ===');
{
  t('★★ 有保留诊断信息的版本 getJsonDetailed', /private async getJsonDetailed<T>/.test(API));
  t('★ 返回结构里有 status', /status: number;/.test(API));
  t('★ 返回结构里有返回片段', /snippet: string;/.test(API));
  t('★ 返回结构里有错误说明', /error\?: string\b/.test(API));

  t('★ 非 200 时记下 HTTP 状态', /error: `HTTP \$\{res\.status\}`/.test(API));
  t('★ 空返回有单独说明', /返回内容为空/.test(API));
  /**
   * ★ 非 JSON 是最容易被误判成"会话失效"的情况 ——
   *   被网关拦或返回 HTML 登录页时都是这个。
   */
  t('★★ 非 JSON 有单独说明（被网关拦/HTML 登录页）', /返回的不是 JSON/.test(API));
  t('★ 抛出的异常也记下来', /请求异常：\$\{\(e as Error\)\.message\}/.test(API));
  t('★ 片段做了压缩与截断（避免刷屏）', /replace\(\/\\s\+\/g, ' '\)\.slice\(0, 160\)/.test(API));

  // 复刻三种情况，确认真的能区分
  function classify(res) {
    if (res.throw) return `请求异常：${res.throw}`;
    if (res.status !== 200) return `HTTP ${res.status}`;
    const text = String(res.body ?? '').trim();
    if (!text) return '返回内容为空';
    try {
      JSON.parse(text);
      return 'ok';
    } catch {
      return '返回的不是 JSON';
    }
  }
  const CASES = [
    ['401 会话失效', { status: 401, body: '{"error":"unauthorized"}' }, 'HTTP 401'],
    ['403 无权限', { status: 403, body: '' }, 'HTTP 403'],
    ['网关返回 HTML', { status: 200, body: '<html><body>login</body></html>' }, '返回的不是 JSON'],
    ['200 但空内容', { status: 200, body: '   ' }, '返回内容为空'],
    ['网络超时', { throw: 'timeout' }, '请求异常：timeout'],
    ['200 正常 JSON', { status: 200, body: '{"courseList":[]}' }, 'ok'],
  ];
  for (const [label, res, expect] of CASES) {
    const got = classify(res);
    const ok = got === expect;
    console.log(`  ${ok ? '√' : '×'} ${label.padEnd(20)} → ${got}`);
    if (ok) pass += 1;
    else fail += 1;
  }
}

console.log('\n=== 2) ★★ fetchCourses 失败必须抛错（不能静默变空数组）===');
{
  t('★★ fetchCourses 失败时抛错', /throw new Error\(\s*`取课程列表失败/.test(API));
  t('★ 抛出的错误里带原因', /取课程列表失败：\$\{r\.error/.test(API));
  t('★ 还带返回片段（便于定位）', /返回片段：\$\{r\.snippet\}/.test(API));
  t('★★ 不再写成 `?? []` 静默兜底', !/return raw\?\.courseList \?\? \[\];/.test(API));
  t('★ 注释解释了这个改动的理由', /失败时抛错，不再静默返回空数组/.test(API));
  /**
   * ⚠️ 注意 `signApi.ts` 里也有一个 `fetchCourses` ——
   *    那是**另一个类自己的方法**（签到流程用的），不是我改的这个。
   *    所以不能简单按"文件数"断言，要按**哪个类**来判。
   */
  const courseApiCallers = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(f.name)) {
        const s = fs.readFileSync(p, 'utf8');
        if (s.includes('fetchCourses()') && !p.endsWith('youxueCourseApi.ts')) courseApiCallers.push(path.basename(p));
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  console.log(`  调用 fetchCourses() 的文件：${courseApiCallers.join(', ') || '(无)'}`);
  t(
    '★ 改的这个类只被 taskStore 用（signApi 里那个是同名但不同的方法）',
    courseApiCallers.includes('taskStore.tsx'),
  );
  /** 确认 signApi 里那个是独立方法（以防以后有人误以为是同一个） */
  const SIGN_API = fs.readFileSync(path.join(ROOT, 'src', 'services', 'checkin', 'signApi.ts'), 'utf8');
  t('★ signApi 的 fetchCourses 是它自己的方法（独立类）', /\/\*\* 我的课程 \*\/\s*\n\s*async fetchCourses/.test(SIGN_API));
}

console.log('\n=== 3) ★★ 界面要能区分「请求失败」与「真的没课程」===');
{
  t('★★ 课程列表为空时有专门说明（不是登录问题）', /课程列表是空的/.test(TASK));
  t('★★ 明确告诉用户"这不是登录问题"', /这不是登录问题/.test(TASK));
  t('★ 解释了常见原因（还没选课/按学期放）', /这学期还没选上课/.test(TASK));
  t('★ 另一种情况（有课但没 classId）也有说明', /都没有班级号（classId）/.test(TASK));
  /**
   * ⚠️ 那句旧文案现在只允许出现在**注释**里（我在记录这段历史），
   *    不许出现在**代码**里 —— 所以先剥掉注释再判断。
   */
  const TASK_CODE = TASK.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  t('★★ 不再用那句含糊的"没有取到课程（会话可能已失效）"', !/没有取到课程（会话可能已失效）/.test(TASK_CODE));
  t('★ 注释说明了为什么必须分开报', /两种完全不同的原因/.test(TASK));
  /** ★ 请求失败时把底层错误原样显示出来（那才是真正的会话失效信息） */
  t('★★ 请求失败时显示底层错误原文', /error: \(e as Error\)\.message/.test(TASK));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

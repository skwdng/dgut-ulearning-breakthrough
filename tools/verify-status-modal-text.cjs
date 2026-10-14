/**
 * 「改签到状态」弹窗的**界面文案**测试。
 *
 * ══════════════ 用户需求（2026-10）══════════════
 * 「帮我把多余的字删掉，比如学生端权限，教师权限，和已签到上面的那段话」
 *
 * 他要删三处：
 *   ① 每个选项右边的「学生端可改」/「教师权限」（`studentPossible` 的产物）
 *   ② 「已签到」上方那段解释（"App 会依次尝试学生接口与教师接口…"）
 *   ③ 顺带：页面底部那段同类说明（"学生端只能把状态改成「已签到」…"）
 *
 * ══════════════ ⚠️ 删掉「教师权限」不只是去冗余 —— 那句话**本身是错的** ══════════════
 *
 * 当初按"学生端接口 vs 教师端接口"划分，把未签到/迟到/早退/病假/事假
 * 都标成"教师权限"（`studentPossible: false`）。
 *
 * 但实测下来这个划分**不成立**：
 *   · `signByTea` 是教师端代签接口，可**对普通学生账号没有权限校验**
 *   · 它甚至**不做时间校验** —— 在 2022 年"已结束"的记录上也改成功了
 *     （而学生接口对同样记录返回 202 拒绝）
 *
 * 也就是说那些"教师权限"的状态**实际都能改**。
 * 所以标它是**误导用户**（让他以为点不了、不敢点），删掉是对的。
 *
 * 这个测试同时钉住"删干净"和"别再加回来"。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCREEN = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'SignRecordList.tsx'), 'utf8');
const API = fs.readFileSync(path.join(ROOT, 'src', 'services', 'checkin', 'signApi.ts'), 'utf8');

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

/** 剥掉注释 —— 注释里允许出现这些词（那是文档），代码里不允许（那是 UI） */
const codeOf = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const SCREEN_CODE = codeOf(SCREEN);

console.log('=== 1) ★★ 删掉的三处文案不许回来（界面代码里）===');
{
  t('★★ 没有「学生端可改」', !SCREEN_CODE.includes('学生端可改'));
  t('★★ 没有「教师权限」', !SCREEN_CODE.includes('教师权限'));
  t(
    '★★ 没有「App 会依次尝试学生接口与教师接口」那段',
    !SCREEN_CODE.includes('App 会依次尝试学生接口与教师接口'),
  );
  t(
    '★ 页面底部也不再写「学生端只能把状态改成」',
    !SCREEN_CODE.includes('学生端只能把状态改成'),
  );
  t('★ 底部仍然保留"只列出确实发起过点名的课程"这句（那是有用的）', /只列出优学院确实发起过点名的课程/.test(SCREEN_CODE));
}

console.log('\n=== 2) ★★ 不再用 studentPossible 决定界面文案 ===');
{
  /** 这是当初产生那两句标签的根源 —— 必须断掉 */
  t('★★ 界面里不再引用 studentPossible', !/studentPossible/.test(SCREEN));
  /**
   * ⚠️ 断言不能写成"不许用 color.success" ——
   *    那是过宽的写法：`color.success` 现在**合法地**用在
   *    「✓ 已修改」上（改成功的反馈）。
   *    要断的是"不再用它标**谁能改**"这个旧用法。
   */
  t(
    '★★ 不再用 color.success 标"谁能改"（但可用于"已修改"反馈）',
    !/g\.studentPossible \? color\.success/.test(SCREEN),
  );
  t('★ color.success 确实用在"已修改"上（新的合法用法）', /✓ 已修改/.test(SCREEN) && /color\.success\[600\]/.test(SCREEN));
  /**
   * ⚠️ 字段本身留着（历史数据/测试还在引用），但必须带上"假设是错的"警告，
   *    否则以后有人看到它会照原样标回 UI。
   */
  t('★★ 字段注释里点明了"这个假设是错的"', /这个字段的假设是\*\*错的\*\*/.test(API));
  t('★★ 说明了不许拿它决定界面文案', /不许再拿它决定界面文案/.test(API));
  t('★★ 记录了实测反证（signByTea 无权限校验、2022 年纪录也能改）', /2022 年"已结束"的记录上也改成功了/.test(API));
  t('★ 说明标它是误导', /误导/.test(API));
}

console.log('\n=== 3) 弹窗结构仍然完整（删字不能把功能删掉）===');
{
  t('★ 弹窗还在', /改签到状态/.test(SCREEN_CODE));
  t('★ 关闭按钮还在', /closeStatusModal/.test(SCREEN_CODE));
  t('★ 课程名/课堂名那行还在（那是有用信息）', /statusTarget\?\.courseName/.test(SCREEN_CODE));
  t('★★ 三个主选项都还在', /SIGN_STATUS_GROUPS\.map/.test(SCREEN_CODE));
  t('★ 「其他」仍能展开子选项', /g\.subs && subOpen/.test(SCREEN_CODE));
  /**
   * ⚠️ 这条**原本是反向**的（曾经要求"诊断按钮还在，留着排查"）。
   *    2026-10 用户改口：「把……签到功能里的接口测试删掉」→
   *    按钮已删，断言随之反转。
   *
   *    当前源码里那句按钮文字只剩在**注释**里（留档说明为什么删），
   *    所以判据要先剥注释 —— 否则会因为注释里留着它而误判"还在"。
   */
  t('★ 诊断按钮**已删**（用户要求去掉签到里的接口测试）', !/诊断：找出能改状态的接口/.test(SCREEN_CODE));
  t('★ 按钮文字在注释里留了档（说明为什么删）', /诊断：找出能改状态的接口/.test(SCREEN));
}

console.log('\n=== 3b) ★★ 每个状态后面有「修改」按钮，改完变「已修改」===');
{
  /**
   * ══════════════ 需求（用户 2026-10）══════════════
   * 「每个状态后面加个修改按钮，被修改的状态后面按钮从修改变成已修改」
   *
   * 所以交互从"点状态即提交"改成"点右侧的修改按钮才提交"：
   *   未改        → 「修改」（可点）
   *   提交中      → 「修改中…」
   *   **改成功**  → 「✓ 已修改」（禁用）
   */
  t('★★ 有专门的按钮组件 StatusAction', /function StatusAction\(\{/.test(SCREEN_CODE));
  t('★★ 未改时显示「修改」', /'修改'/.test(SCREEN_CODE) && /修改中…/.test(SCREEN_CODE));
  t('★★ 改成功后显示「已修改」', /✓ 已修改/.test(SCREEN_CODE));
  t('★★ 状态行确实带了这个按钮（主选项 + 子选项）', (SCREEN_CODE.match(/<StatusAction/g) ?? []).length === 2, `${(SCREEN_CODE.match(/<StatusAction/g) ?? []).length} 处`);
  /** ★ 用 status 值记录"哪一行改成功了"，不是布尔 */
  t('★★ 用 modifiedStatus 记状态值（能区分哪一行）', /const \[modifiedStatus, setModifiedStatus\] = useState<number \| null>/.test(SCREEN_CODE));
  t('★★ 提交中状态单独记（防连点）', /const \[applyingStatus, setApplyingStatus\] = useState<number \| null>/.test(SCREEN_CODE));
  t('★★ 已修改时按钮禁用（防重复提交）', /onPress=\{applying \? undefined : onPress\}/.test(SCREEN_CODE));

  /**
   * ⚠️ 失败**不能**标记成"已修改" —— 否则用户以为改成功了。
   */
  t('★★ 只有成功才标记已修改', /if \(res\.ok\) \{[\s\S]{0,120}?setModifiedStatus\(status\)/.test(SCREEN_CODE));
  t('★★ 失败分支不标记（否则误导）', /else \{[\s\S]{0,300}?没有成功/.test(SCREEN_CODE));

  /** 弹窗不再自动关闭 —— 用户要连着看几行结果 */
  t('★★ 改状态后弹窗不自动关闭', !/const applyStatus[\s\S]{0,400}?setStatusTarget\(null\)/.test(SCREEN_CODE));
  t('★ 注释说明了为什么不关', /不再自动关闭|弹窗不再自动关闭/.test(SCREEN));
  t('★★ 结果就地显示在弹窗里（不自动关就要就地看）', /\{result \? \(/.test(SCREEN_CODE));

  /** 关窗必须清状态，否则下次打开看到上次的"已修改" */
  t('★★ 关窗时清掉 modifiedStatus（否则串到下次）', /const closeStatusModal = \(\) => \{[\s\S]{0,200}?setModifiedStatus\(null\)/.test(SCREEN_CODE));
  t('★★ 换一条记录打开时也清', /const changeStatus = \(r: SignDetail\)[\s\S]{0,200}?setModifiedStatus\(null\)/.test(SCREEN_CODE));
  t('★ 注释说明了为什么要清', /否则会串到这条记录上|下次打开会看到上次/.test(SCREEN));
  /**
   * ⚠️ 上面两条查的是**注释**，所以必须用 `SCREEN`（原始源码），
   *    不能用 `SCREEN_CODE`（剥掉注释的版本）—— 用错变量必然失败。
   */
}

console.log('\n=== 4) 状态分组定义仍是三类 ===');
{
  t('★ 三个主选项：已签到 / 未签到 / 其他', /label: '已签到'/.test(API) && /label: '未签到'/.test(API) && /label: '其他'/.test(API));
  t('★ 其他下面有四个子项', /status: 3, label: '迟到'/.test(API) && /status: 4, label: '早退'/.test(API) && /status: 5, label: '病假'/.test(API) && /status: 6, label: '事假'/.test(API));
  t('★ 注释说明界面不带"谁能改"的标注', /不带任何"谁能改"的标注/.test(API));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

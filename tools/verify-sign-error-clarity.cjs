/**
 * 「改状态报错」的诊断质量 测试。
 *
 * ══════════════ 用户实测的现象 ══════════════
 *
 * 「我在点修改的时候说有问题，查询之后说可以了」
 *
 * 也就是：
 *   · 直接点「修改」→ 报错
 *   · 先点一次「查询」→ 再点「修改」→ 就好了
 *
 * ══════════════ 根因：错误信息太笼统 ══════════════
 *
 * `ensureApi()` 返回 null 的原因有**四种**，而原来的报错只有一句话：
 *     '缺少会话，请重新登录优学院'
 * `query` 那边同样笼统：'初始化签到接口失败 —— 请重新绑定一次'
 *
 * 于是"到底是没账号、没凭据、没 token、还是没 userId"分不出来 ——
 * 只能靠猜。而用户的描述（"查询之后就好了"）恰好指向
 * "状态没准备好"（换账号后的空窗期），不是会话真的失效。
 *
 * 现在改成 `explainNoApi()` 把四种原因分开，并记进故障日志。
 *
 * ══════════════ 为什么值得单独测 ══════════════
 *
 * 这是**排查效率**问题：一个说不清原因的错误，会让用户和我
 * 都陷入"反复试、反复猜"。把原因说出来，一次就能定位。
 *
 * 用法: node tools/verify-sign-error-clarity.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STORE = fs.readFileSync(path.join(ROOT, 'src', 'state', 'signStore.tsx'), 'utf8');
/**
 * ⚠️ 剥掉注释再看 —— 旧文案仍会出现在**注释里**（我解释改动时引用了它），
 *    用原文判断会误报（这个坑踩过好几次）。
 */
const CODE = STORE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

console.log('=== 1) ★★ 有 explainNoApi，把四种原因分开 ===');
{
  t('★★ 定义了 explainNoApi', /const explainNoApi = useCallback/.test(STORE));
  t('★★★ ① 没有账号 → 说"还没绑定"', /if \(!account\) return '还没有绑定/.test(STORE));
  t('★★★ ② 没有凭据 → 说清是"当前账号还没有凭据"', /还没有本地登录凭据/.test(STORE));
  t('★★★ ③ 没有 token → 单独一句', /没有 token（会话不完整）/.test(STORE));
  t('★★★ ④ 没有 userId → 单独一句', /没有数字 userId/.test(STORE));
  /**
   * ★ 最要紧的一句：告诉用户"先点一次查询就好" ——
   *   因为他实测就是这个现象，下次不用再来问我。
   */
  t('★★★ 提示了"先点一次「查询」"这个自救办法', /先点一次「查询」/.test(STORE));
  t('★★ 注释说明了这个坑（原话分不出来，只能反复猜）', /反复猜|分不出来/.test(STORE));
}

console.log('\n=== 2) ★★★ setStatus 用上它（并记日志）===');
{
  t('★★★ setStatus 里调 explainNoApi', /setStatus[\s\S]{0,2000}?explainNoApi\(\)/.test(STORE));
  t('★★★ 失败时记进故障日志（下次能直接看到是哪一种）', /\[改状态\] 建不起接口/.test(STORE));
  t('★★ 日志带上 account.id 与 studentId（便于对照）', /account\.id=\$\{account\?\.id/.test(STORE));
  t('★★ 日志带上 attendanceID', /attendanceID=\$\{input\.attendanceID\}/.test(STORE));
  /** ★ 旧的笼统文案在**代码里**不该再出现（注释里引用不算） */
  t('★★★ 不再用笼统的"缺少会话，请重新登录优学院"', !/缺少会话，请重新登录优学院/.test(CODE));
  t('★★ 返回的 message 用的是具体原因', /const r = \{ ok: false, message: why \}/.test(STORE));
}

console.log('\n=== 3) ★★ query 那边也改了 ===');
{
  t('★★ query 里也调 explainNoApi', /\[签到查询\] 建不起接口/.test(STORE));
  /**
   * ⚠️ 断言要精确 —— `explainNoApi` 的**兜底返回**就是"初始化签到接口失败"
   *    （所有检查都通过才会到那里），那是合理文案，不该禁掉。
   *    要禁的是**调用方**用这句代替具体原因。
   */
  t('★★★ query 不再直接用笼统文案（改走 explainNoApi）', !/SET_ERROR', error: '初始化签到接口失败/.test(CODE));
  t('★ 兜底文案仍然是它（合理保留）', /return '初始化签到接口失败';/.test(CODE));
  t('★ 查询失败也记日志', /\[签到查询\] 建不起接口：\$\{why\}/.test(STORE));
}

console.log('\n=== 4) 其它既有诊断没被破坏 ===');
{
  /** 这些是之前就有的重要诊断，别在改动里丢掉 */
  t('★ 凭据缺失仍有专门日志', /\[签到查询\] 凭据缺失/.test(STORE));
  t('★ 账号不匹配仍有专门日志', /\[签到查询\] 账号不匹配/.test(STORE));
  t('★ 会话失效(401)仍有日志', /会话失效（401）/.test(STORE));
  t('★ logFault 已导入', /import \{ logFault \} from '\.\.\/services\/crashLog'/.test(STORE));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

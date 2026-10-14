/**
 * 崩溃日志的**信噪比**测试。
 *
 * ══════════════ ★ 为什么需要这个测试 ══════════════
 *
 * 用户反馈「签到功能会闪退」，我去看崩溃日志 —— 结果发现
 * **30 条记录里一条崩溃都没有**，全是同一条正常操作：
 *
 *   [WebView登录] 从页面同步到 12 个 cookie（写入成功 0，被拒 36）
 *   [WebView登录] 从页面同步到 12 个 cookie（写入成功 0，被拒 36）
 *   ... × 30
 *
 * 两个原因叠加：
 *   ① 调用方用 `logFault` 记了**成功路径**（那个函数本该只记故障）
 *   ② WebView 天然会把同一条消息发好几次，每次都记
 *
 * 结果：**真崩溃被挤出了 30 条的窗口** —— 日志没起到它该起的作用。
 *
 * ⚠️ 所以这个测试同时钉住两件事：
 *   · 正常操作不许进崩溃日志
 *   · 连续的重复消息要被压掉
 *
 * 用法: node tools/verify-crash-log-hygiene.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CRASH = fs.readFileSync(path.join(ROOT, 'src', 'services', 'crashLog.ts'), 'utf8');
const LOGIN = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'youxue-web-login.tsx'), 'utf8');
const SIGN_STORE = fs.readFileSync(path.join(ROOT, 'src', 'state', 'signStore.tsx'), 'utf8');

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

console.log('=== 1) ★★ 去重：连续同一条消息只记一次 ===');
{
  t('★★ 有去重窗口常量', /DEDUPE_WINDOW_MS/.test(CRASH));
  t('★★ 比对的是消息内容', /lastMessage === rec\.message/.test(CRASH));
  t('★★ 带时间窗（不是永久去重）', /Math\.abs\(rec\.at - lastAt\) < DEDUPE_WINDOW_MS/.test(CRASH));
  t('★★ 命中就 return（不写入）', /if \(isRepeat\) return;/.test(CRASH));
  t('★ 去重判断在读写之前（省一次存储操作）', /isRepeat =[\s\S]{0,200}?if \(isRepeat\) return;[\s\S]{0,120}?store\.get/.test(CRASH));
  t('★★ 注释说明了为什么（真崩溃被挤出窗口）', /真崩溃被挤出了 30 条的窗口/.test(CRASH));
  /**
   * ⚠️ 去重**不能**是永久的 —— 否则"这个问题一直在复发"就看不见了。
   */
  t('★★ 注释说明了复发仍会留痕', /复发/.test(CRASH));
  t('★★ 窗口是 5 分钟（够压住一次登录的重复，又不至于吞掉复发）', /5 \* 60_000/.test(CRASH));
}

console.log('\n=== 2) ★★★ 正常操作不许进崩溃日志 ===');
{
  /**
   * 「从页面同步到 N 个 cookie」是**成功路径**：
   *   `被拒 36` = 12 个 cookie × 3 个域名，每个 cookie 往三个域名各写一遍，
   *   总有两个域名是白写的 —— 见 webCookie.ts 的实现，这是设计使然。
   *   会话真正的成败看下面那行 `写凭据 … 结果=成功`。
   */
  t('★★★ 不再用 logFault 记 cookie 同步（成功路径）', !/logFault\(\s*`\[WebView登录\] 从页面同步到/.test(LOGIN));
  t('★★★ 不再用 logFault 记"建会话成功"', !/logFault\(\s*`\[WebView登录\] 直接用网页内 cookie 建会话/.test(LOGIN));
  t('★ 但界面上仍有同步结果反馈（信息没丢，只是不叫"故障"）', /setSyncResult\(/.test(LOGIN));
  t('★★ 注释说明了"被拒 36"是 12×3 的正常结果', /12 个 cookie × 3 个域名/.test(LOGIN));

  /** ★ 真故障**必须**继续记 —— 别把去噪变成"什么都不记" */
  t('★★★ 真故障仍记录：注入读 cookie 失败', /logFault\(`\[WebView登录\] 注入读取 cookie 失败/.test(LOGIN));
  t('★★★ 真故障仍记录：没拿到会话凭据', /logFault\(\s*`\[WebView登录\] 没拿到会话凭据/.test(LOGIN));
}

console.log('\n=== 3) 日志条数上限仍然是 30（去重不改变容量）===');
{
  t('★ MAX_RECORDS = 30', /const MAX_RECORDS = 30;/.test(CRASH));
  t('★ 写入时截断到上限', /list\.slice\(0, MAX_RECORDS\)/.test(CRASH));
  t('★★ 写日志失败也不抛（不能因为日志把 App 搞崩）', /日志写入失败也不能再抛/.test(CRASH));
}

console.log('\n=== 4) logFault 的定位仍是"故障"（语义别被用歪）===');
{
  t('★★ 注释写明它是"主动记一条故障"', /主动记一条故障/.test(CRASH));
  t('★★ 注释举的场景是"只在用户手机上复现的问题"', /在用户手机上才复现/.test(CRASH));

  /** ★ 签到侧真正的故障上报仍在（那是这个机制存在的理由） */
  t('★ 签到侧仍会上报故障', /logFault\(/.test(SIGN_STORE));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

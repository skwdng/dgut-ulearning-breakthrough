/**
 * 「token 被优学院作废」的识别与引导 —— 回归测试。
 *
 * ══════════════ 用户实测原文（2026-10）══════════════
 *
 *   「有时候就有这种情况，明明登着账号，查不了」
 *
 *   屏幕上的报错：
 *     没有取到课程列表。凭据诊断：
 *       token=有(32位) userId=90990001 cookie数=12
 *       服务端 HTTP=401
 *       返回={"code":2101,"message":"无效的token"}
 *
 * ══════════════ 这不是"没登录" ══════════════
 *
 *   凭据**全都在**（token 32 位、userId 正确、cookie 12 个），
 *   是**服务端把那串 token 废了**。
 *
 *   最常见的原因：**在别处登录了优学院**（网页版 / 官方 App）——
 *   优学院同一时间只认一个会话，新登录会把旧的顶掉。
 *
 * ⚠️ 所以「重试」是没用的（重试一百次还是 401），
 *    必须直接引导**重新登录**。
 *
 * 用法: node tools/verify-token-expiry.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const API = read('src', 'services', 'checkin', 'signApi.ts');
const SCREEN = read('src', 'screens', 'SignRecordList.tsx');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

console.log('=== 1) ★★★ 识别"token 被作废"（不是笼统的"取不到列表"）===');
{
  const code = strip(API);
  t('★★★ 有 tokenDead 判据', /const tokenDead =/.test(code));
  t('★★★ 判据含 401', /res\.status === 401/.test(code));
  t('★★★ 判据含业务码 21xx（实测 2101）', /\/21\\d\\d\//.test(API));
  t('★★★ 判据含"无效的token"文案', /无效的\?token/.test(API));
  /** ★ 必须说清"这不是没登录" —— 否则用户会反复重试 */
  t('★★★ 明说「这不是"没登录"」', /这不是"没登录"/.test(API));
  /** ★ 必须点出真实原因：在别处登录了 */
  t('★★★ 点出原因「在别处登录了优学院」', /你在别处登录了优学院/.test(API));
  t('★★ 解释"优学院同一时间只认一个会话"', /只认一个会话/.test(API));
  /** ★ 引导用户重新登录，而不是重试 */
  t('★★★ 引导「请重新登录」', /请点下面的按钮重新登录/.test(API));
}

console.log('\n=== 2) ★★★ 界面给「重新登录」按钮（重试没用）===');
{
  const code = strip(SCREEN);
  t('★★★ 识别到 token 失效时走单独分支', /token 失效\|登录状态已被优学院作废/.test(SCREEN));
  t('★★★ 有「重新登录」按钮', /actionLabel="重新登录"/.test(SCREEN));
  t('★★★ 它跳到绑定页 /youxue-bind', /router\.push\('\/youxue-bind'\)/.test(code));
  t('★★ 标题改成「需要重新登录」', /title="需要重新登录"/.test(SCREEN));
  /** ★ 仍保留一个"重试一次"（万一是瞬时网络问题） */
  t('★★ 仍保留「重试一次」作为次要选项', /label="重试一次"/.test(SCREEN));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

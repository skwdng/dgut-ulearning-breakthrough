/**
 * 会话校验测试 —— 绑定时必须真的验证 token。
 *
 * ══════════ 真实踩过的坑 ══════════
 * 用户反馈：「有时候必须重新登录才能用任务和签到」，
 * 查询时报 `HTTP=401 {"code":2101,"message":"无效的token"}`。
 *
 * 根因：绑定时的"探活"走错了接口。
 *   `importSession` → `probeWith(cookies, ua)` 时 **userId 还是 undefined**，
 *   于是 `uid = 0`，请求的是**静态页** `/courseweb/ulearning/index.html`。
 *   静态页只看 cookie、不看 AUTHORIZATION 头 → 必然 200 →
 *   判定"会话有效" → **一个无效 token 也能绑定成功**。
 *   等到真正调 `/apps/*` 时才 401，用户毫不知情。
 *
 * 这个测试钉住两件事：
 *   ① 绑定流程里必须有一次"带 token 的真实校验"
 *   ② 那个校验用的接口必须是需要 AUTHORIZATION 的 userInfo，而不是静态页
 */
const fs = require('fs');
const path = require('path');

const ADAPTER = fs.readFileSync(
  path.resolve(__dirname, '..', 'src', 'services', 'checkin', 'youxueAdapter.ts'),
  'utf8',
);
const SIGN = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'state', 'signStore.tsx'), 'utf8');

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

console.log('=== 1) ★ 绑定时必须用 token 真实验证 ===');
{
  t('persistSession 里有 token 校验块', /★\s*用 token 真的验证一次/.test(ADAPTER));
  t('用 userInfo(userId) 接口校验（需要 AUTHORIZATION）', /ENDPOINTS\.userInfo\(userId\)/.test(ADAPTER));
  t('校验请求带了 AUTHORIZATION 头', /AUTHORIZATION: token,/.test(ADAPTER));
  t('校验失败要明确区分（不是只看 status 200）', /tokenOk = pr\.status === 200 && !\/authserver/.test(ADAPTER));
  t('★ 校验不通过就拒绝绑定', /if \(!tokenOk\) \{[\s\S]{0,900}?ok: false/.test(ADAPTER));
  t('拒绝时告诉用户重新登录', /请退出账号后重新登录一次/.test(ADAPTER));
  t('拒绝时记录故障日志', /\[绑定\] ★ token 校验未通过/.test(ADAPTER));
}

console.log('\n=== 2) ★ 静态页不能当作"会话有效"的依据 ===');
{
  // 静态页路径只应该出现在"没有 userId 时的兜底"里，且不能用于绑定判定
  const usesStaticPage = /ulearning\/index\.html/.test(ADAPTER);
  console.log(`  （源码里是否仍引用静态页：${usesStaticPage ? '是（probeWith 的兜底）' : '否'}）`);
  t(
    '静态页只作为无 userId 时的兜底，且不参与绑定判定',
    !usesStaticPage || /const path = uid > 0 \? ENDPOINTS\.userInfo\(uid\) : '\/courseweb\/ulearning\/index\.html';/.test(ADAPTER),
  );
  // 绑定路径必须走带 token 的校验
  t('绑定路径不再只依赖 probeWith 的结论', /tokenOk/.test(ADAPTER));
}

console.log('\n=== 3) ★ 会话过期时给用户能照做的提示 ===');
{
  t('signStore 识别 401 / 无效 token', /401\|无效的\\s\*token/.test(SIGN));
  t('提示里说明去哪重新登录', /优学院 → 换账号 → 用网页登录/.test(SIGN));
  t('提示里说明"不是密码错"', /这不是密码错/.test(SIGN));
  t('★ 会话失效时丢弃缓存的 API 客户端', /apiRef\.current = null;/.test(SIGN));
}

console.log('\n=== 4) 复刻判据 ===');
{
  /** 复刻 tokenOk 的判定 */
  function tokenLooksValid(status, body) {
    if (status !== 200) return false;
    if (/authserver\/login|请登录/.test(body ?? '')) return false;
    return true;
  }
  t('★ 401 + 无效token → 判为无效', tokenLooksValid(401, '{"code":2101,"message":"无效的token"}') === false);
  t('★ 200 但返回登录页 → 判为无效', tokenLooksValid(200, '<html>authserver/login</html>') === false);
  t('200 且是正常用户信息 → 判为有效', tokenLooksValid(200, '{"userID":90990001,"name":"同学A"}') === true);
  t('500 → 判为无效（保守）', tokenLooksValid(500, '') === false);
}

console.log('\n=== 5) 识别会话过期的判据 ===');
{
  /** 复刻 signStore 里的 isAuthError */
  function isAuthError(raw) {
    return /401|无效的\s*token|invalid\s*token|未登录/i.test(raw);
  }
  t('★ 本次报错原文能识别', isAuthError('没有取到课程列表。… 服务端HTTP=401 返回={"code":2101,"message":"无效的token"}'));
  t('英文 invalid token 也能识别', isAuthError('HTTP 401 invalid token') === true);
  t('"未登录"能识别', isAuthError('当前未登录，请重新登录') === true);
  t('普通网络错误不误判', isAuthError('Network request failed') === false);
  t('超时不误判为会话过期', isAuthError('原生登录超时（40 秒）') === false);
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

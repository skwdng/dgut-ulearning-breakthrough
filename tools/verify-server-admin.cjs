/**
 * 「服务器用户管理（踢出账号）」回归测试。
 *
 * ══════════════ 用户需求（原话）══════════════
 *
 *   「能不能给我 lifekit 加一个功能，把某个账号踢出我的服务器，
 *     别人查的时候找不到我」
 *
 * ══════════════ 这份测试盯什么 ══════════════
 *
 * 这个功能直接**删除服务器上的用户记录**，所以错误的代价很高：
 *   · 口令如果被存进本地 → 谁拿到手机谁就能踢人
 *   · 踢出如果没有二次确认 → 手滑就删错
 *   · 走的接口如果是"停用"而不是"删除"→ 对方其实还能用，只是你以为踢了
 *
 * 所以逐条钉死：
 *   1. 路由与入口在（否则功能等于没做）
 *   2. 用的是**管理口令 Basic 鉴权**，且口令**不落盘**
 *   3. 踢出 = `/api/user/delete`（真删除），停用 = `/api/user/update`
 *   4. 踢出前有二次确认
 *   5. 401 有可读提示（不然用户只会看到"服务器返回的不是 JSON"）
 *
 * ⚠️ 判定方式：只读源码 + 正则；判据前**剥注释**（注释里就写着这些接口名）。
 *
 * 用法: node tools/verify-server-admin.cjs
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

const SCREEN = read('src/screens/server-admin.tsx');
const SCREEN_CODE = strip(SCREEN);
const CLIENT = read('src/services/serverClient.ts');
const CLIENT_CODE = strip(CLIENT);
const ROUTER = read('src/nav/router.tsx');
const SCREENS = read('src/nav/screens.tsx');
const SETTINGS = read('src/screens/settings.tsx');

console.log('');
console.log('=== 1) ★★★ 页面与入口在（功能做完了要能用）===');
t('★★★ 页面文件存在且导出 ServerAdminScreen', /export function ServerAdminScreen/.test(SCREEN));
t('★★★ 路由类型里有 /server-admin', /['"]\/server-admin['"]/.test(strip(ROUTER)));
t('★★★ 注册表注册了 /server-admin', /['"]\/server-admin['"]\s*:\s*\{/.test(SCREENS));
t(
  '★★★ 设置页有入口（router.push("/server-admin")）',
  /router\.push\(\s*['"]\/server-admin['"]\s*\)/.test(strip(SETTINGS)),
  '没入口 = 用户找不到',
);

console.log('');
console.log('=== 2) ★★★ 管理口令：Basic 鉴权 + 绝不落盘 ===');
t('★★★ 用 Basic 鉴权头', /Basic \$\{/.test(CLIENT_CODE) && /basicAuthHeader/.test(CLIENT_CODE));
t('★★★ Base64 用自实现（RN 没有全局 btoa）', /bytesToBase64\(/.test(CLIENT_CODE) && /utf8ToBytes\(/.test(CLIENT_CODE));
t(
  '★★★ 口令**不写进本地存储**',
  !/store\.set/.test(SCREEN_CODE) && !/STORE_KEYS/.test(SCREEN_CODE),
  '存了就等于泄露管理权',
);
t('★★ 页面明确写了"不会保存口令"', /不会保存|只在本页面内存/.test(SCREEN));

console.log('');
console.log('=== 3) ★★★ 踢出 = 删除；停用 = 保留 ===');
t('★★★ 踢出走 /api/user/delete', /'\/api\/user\/delete'/.test(CLIENT_CODE));
t('★★★ 停用/恢复走 /api/user/update', /'\/api\/user\/update'/.test(CLIENT_CODE));
t('★★★ 用户列表走 /api/users', /'\/api\/users'/.test(CLIENT_CODE));
t('★★★ 页面区分"踢出"与"停用"', /踢出/.test(SCREEN) && /停用/.test(SCREEN));
t('★★ 界面说明了删除不可恢复', /不可恢复/.test(SCREEN));

console.log('');
console.log('=== 4) ★★★ 踢出前必须二次确认 ===');
t('★★★ 用 Alert 弹确认', /Alert\.alert\(/.test(SCREEN_CODE));
t('★★★ 确认后才调用删除', /style:\s*'destructive'/.test(SCREEN_CODE) && /void doKick\(/.test(SCREEN_CODE));
t(
  '★★ doKick 定义在 kick 之前（依赖数组渲染期求值，顺序反了会 ReferenceError）',
  SCREEN_CODE.indexOf('const doKick') >= 0 &&
    SCREEN_CODE.indexOf('const doKick') < SCREEN_CODE.indexOf('const kick'),
  '顺序反了会崩在渲染阶段',
);

console.log('');
console.log('=== 5) ★★ 错误提示可读 ===');
t('★★ 401 → 提示"口令不对"', /401[\s\S]{0,80}口令不对/.test(CLIENT_CODE));
t('★★ 服务器地址没配时给出提示', /还没配置服务器地址/.test(SCREEN_CODE));

console.log('');
console.log('  ══════════════════════════════════════════════');
console.log('  这份测试盯的是：踢人这种不可逆操作，入口、鉴权、确认缺一不可。');
console.log('  ⚠️ 报 XX 就是实现确实不满足，不要改断言去迁就。');
console.log('  ══════════════════════════════════════════════');
console.log('');
console.log(`SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

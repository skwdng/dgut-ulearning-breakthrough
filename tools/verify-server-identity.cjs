/**
 * 「连的是哪台服务器」显示 测试。
 *
 * ══════════════ 为什么需要这个功能 ══════════════
 *
 * 有两台服务器在跑**同一套代码**：
 *   · 局域网内那台（本机管理后台）
 *   · 公网那台（地址由 `EXPO_PUBLIC_SERVER_BASE` / 设置页决定，
 *     主机名从 `/api/version` 的 `server` 字段读）
 *
 * 而 App 的服务器地址**可以指向任意一台**（见 serverClient 的 DEFAULT_BASE），
 * 也可以在设置页里手动改。
 *
 * 于是产生一个**很难自查**的问题：
 *   「我检查更新是好的，但连的到底是哪台？」
 *   —— 看版本号分不出来，两台的版本号当然一样。
 *
 * 所以服务端在 `/api/version` 里回报自己的主机名，App 显示出来。
 *
 * ══════════════ ⚠️ 一个容易做错的细节 ══════════════
 *
 * "已是最新版本"时 `info` 会被**清空**（updateStore 的 uptodate 分支）。
 * 而那一刻**恰好是用户最想确认"我连上服务器了吗"的时候** ——
 * 所以服务器身份必须**单独存**（`serverText`），不能挂在 `info` 上，
 * 否则最需要它的时刻它偏偏没了。
 *
 * 用法: node tools/verify-server-identity.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server', 'server.cjs'), 'utf8');
const UPDATER = fs.readFileSync(path.join(ROOT, 'src', 'services', 'updater.ts'), 'utf8');
const STORE = fs.readFileSync(path.join(ROOT, 'src', 'state', 'updateStore.tsx'), 'utf8');
const HOME = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'tab-index.tsx'), 'utf8');

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

console.log('=== 1) ★ 服务端回报自己的身份 ===');
{
  t('★★ server.cjs 引入了 os', /require\('node:os'\)/.test(SERVER));
  t('★★ /api/version 里算出了主机名', /os\.hostname\(\)/.test(SERVER));
  t('★★ 正常响应里带 server 字段', /server: serverName/.test(SERVER));
  /** ★ "服务器上还没放安装包"那条分支也要带 —— 否则那一刻用户也看不出连的是哪台 */
  t('★★ "还没放安装包"分支也带 server 字段', /available: false,[\s\S]{0,120}?server: serverName/.test(SERVER));
  t('★ 注释说明了为什么（两台同代码，看版本分不出）', /分不出来|一眼分辨/.test(SERVER));
}

console.log('\n=== 2) ★★ 客户端把身份带回来 ===');
{
  t('★★ UpdateInfo 有 server 字段', /server\?: string;/.test(UPDATER));
  t('★★ 响应体内联类型也声明了 server', /server\?: string;[\s\S]{0,40}?\};/.test(UPDATER));
  t('★★ 组装 info 时带上 server', /server: j\.server/.test(UPDATER));

  /**
   * ⚠️ 关键：**三个分支都要带**。
   *    只在"有新版本"时带，那"已是最新"时就看不到了 ——
   *    而那恰恰是主要场景（平时都是最新的）。
   */
  t('★★ checkUpdate 返回类型带 server', /\{ ok: true; info: UpdateInfo \| null; server\?: string \}/.test(UPDATER));
  const rets = UPDATER.match(/return \{ ok: true, info: (?:null|info)(?:, server: j\.server)?/g) ?? [];
  const withServer = rets.filter((r) => r.includes('server')).length;
  t('★★ 所有 ok:true 的返回都带 server', withServer === rets.length && rets.length >= 2, `${withServer}/${rets.length}`);
  t('★ 注释说明了为什么要"几个分支都带"', /已是最新版本"时 `info` 是 null|那一刻用户最想确认/.test(UPDATER));
}

console.log('\n=== 3) ★★★ "已是最新"时也必须显示（最关键的一条）===');
{
  /**
   * ⚠️ 这是最容易做错的地方：
   *    uptodate 分支里 `info: null`，如果身份挂在 info 上就**没了**。
   *    而"平时都是最新版本"，所以这恰恰是最常看到的状态。
   */
  t('★★★ 状态里有独立的 serverText 字段', /serverText: string;/.test(STORE));
  t('★★★ 初始值是空串（不是 undefined，避免渲染出错）', /serverText: ''/.test(STORE));
  t('★★★ uptodate 分支里设置 serverText', /phase: 'uptodate'[\s\S]{0,400}?serverText:/.test(STORE));
  t('★★★ available 分支里也设置', /phase: 'available'[\s\S]{0,300}?serverText:/.test(STORE));
  /** ★ 保留上一次的值：某次检查失败不该把已显示的服务器名抹掉 */
  t('★★ 保留上一次的值（连不上时不抹掉）', /serverLabel\(r\.server\) \|\| s\.serverText/.test(STORE));
  t('★★ 注释说明了为什么单独存（uptodate 时 info 被清空）', /info` 会被\*\*清空\*\*|恰恰是最常看到的状态|那一刻/.test(STORE));
}

console.log('\n=== 4) ★ 主机名要翻译成人话 ===');
{
  t('★ 有 serverLabel 函数', /function serverLabel/.test(STORE));
  /**
   * ⚠️ 阿里云的实例主机名形如 `iZwz9cni4uro1ctp2jt3vdZ` ——
   *    直接显示给用户没人看得懂。
   */
  t('★ 主机名以 iZ 开头 → 认成「云端」', /\/\^iZ\/i/.test(STORE) && /已连接：云端服务器/.test(STORE));
  t('★ 其他主机名原样显示', /已连接：\$\{host\}/.test(STORE));
  t('★★ 没有 server 字段时不瞎猜（旧版服务端）', /if \(!host\) return '';/.test(STORE));
  t('★ 注释说明了阿里云主机名的形态', /iZwz9cni/.test(STORE));
}

console.log('\n=== 5) 首页显示出来 ===');
{
  t('★ 首页引用 serverText', /upd\.serverText/.test(HOME));
  t('★★ 空串时不渲染（不留空白行）', /upd\.serverText \? \(/.test(HOME));
  t('★ 注释说明了为什么需要（版本号分不出连的是哪台）', /分不出连的是哪台/.test(HOME));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

/**
 * 云端部署脚本 测试。
 *
 * ══════════════ ★★★ 最要紧的一条：绝不覆盖云端用户数据 ★★★ ══════════════
 *
 * `server.cjs` 里是 `DATA_FILE = path.join(__dirname, 'data.json')` ——
 * 云端用户数据就在 `/opt/lifekit/data.json`，而且：
 *   · **没有别的备份渠道**（服务和数据在同一台机器上）
 *   · 部署脚本一旦把它当普通文件传上去，云端记录当场被本地那份覆盖
 *
 * 实测过：项目管理目录下的 `server/data.json` 与云端那份**内容完全不同**
 * （项目里那份 users 是空的，云端有 2 个真实用户）。
 * 也就是说"覆盖"不是理论风险 —— 传上去就是真丢数据。
 *
 * 所以部署脚本里有一道白名单守卫。这个测试钉住它。
 *
 * ══════════════ 为什么需要这个脚本也能理解 ══════════════
 *
 * 原先的 `deploy-to-vps.cjs` **只传 APK 和 version.json**，
 * 结果"App 内置更新"依赖的 `/api/version` 接口**云端根本没有**（404）——
 * 本地能更新、出门用流量就不能。这个脚本把服务端代码一起带上。
 *
 * 用法: node tools/verify-deploy-all.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEPLOY = fs.readFileSync(path.join(ROOT, 'tools', 'deploy-all.cjs'), 'utf8');
const RELEASE = fs.readFileSync(path.join(ROOT, 'tools', 'release.cjs'), 'utf8');

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

console.log('=== 1) ★★★ 守卫：绝不覆盖云端 data.json ===');
{
  t('★★★ 有上传白名单', /const CODE_FILES = \[/.test(DEPLOY));
  t('★★★ data.json 不在白名单里', !/CODE_FILES = \[[^\]]*data\.json/.test(DEPLOY));
  t('★★★ 有禁止清单兜底（备份/临时文件也算）', /const FORBIDDEN = /.test(DEPLOY));
  t('★★★ 禁止清单覆盖 data.json', /data\\\.json/.test(DEPLOY));
  t('★★★ 禁止清单覆盖 .backup 与 .bak', /\\\.backup/.test(DEPLOY) && /\\\.bak/.test(DEPLOY));

  /**
   * ⚠️ 关键设计：**白名单**而不是黑名单。
   *    黑名单永远会漏（data.json.bak / data.json.2026-10-12 / .backup/…），
   *    白名单只放"确定是代码"的文件，多一个都传不上去。
   */
  t('★★ 注释说明了为什么用白名单而不是黑名单', /白名单而不是黑名单/.test(DEPLOY));
  t('★★★ 上传前会做一次泄漏检查并中止', /leaked[\s\S]{0,200}?bad\(/.test(DEPLOY));
  t('★★★ 泄漏时直接退出（不是警告后继续）', /if \(fail > 0\)[\s\S]{0,120}?process\.exit\(1\)/.test(DEPLOY));

  /** 白名单内容必须正好是这三个代码文件 */
  const m = DEPLOY.match(/const CODE_FILES = \[([^\]]+)\]/);
  const files = m ? m[1].match(/'([^']+)'/g)?.map((s) => s.replace(/'/g, '')) ?? [] : [];
  t('★★ 白名单是 server.cjs / licenseCode.cjs / manage.html',
    files.length === 3 && files.includes('server.cjs') && files.includes('licenseCode.cjs') && files.includes('manage.html'),
    files.join(','));
}

console.log('\n=== 2) ★★ 部署顺序：先语法检查，再替换 ===');
{
  /**
   * ⚠️ 顺序错了会出事：传一个语法错误的 server.cjs 上去，
   *    重启后服务起不来，而**服务器上没有编辑器可救**。
   */
  const checkIdx = DEPLOY.indexOf('node --check');
  const replaceIdx = DEPLOY.indexOf('echo "  [替换]"');
  const restartIdx = DEPLOY.indexOf('systemctl restart');
  t('★★★ 有语法检查（node --check）', checkIdx > 0);
  t('★★★ 语法检查在替换之前', checkIdx > 0 && replaceIdx > 0 && checkIdx < replaceIdx);
  t('★★ 替换在重启之前', replaceIdx > 0 && restartIdx > 0 && replaceIdx < restartIdx);
  t('★★★ 有备份步骤且在替换之前', /\[备份\]/.test(DEPLOY) && DEPLOY.indexOf('[备份]') < replaceIdx);
  t('★★ 失败时提示回滚命令', /回滚命令/.test(DEPLOY));

  /** 先传临时目录再原子替换 —— 避免服务读到半个文件 */
  t('★★ 先传到 .incoming 临时目录', /\.incoming/.test(DEPLOY));
  t('★★ 注释说明了为什么用临时目录（避免读到半个文件）', /读到半个文件/.test(DEPLOY));
}

console.log('\n=== 3) ★★ 会用新版代码解决 /api/version 404 ===');
{
  t('★★ 会传 server.cjs（/api/version 在那个文件里）', /CODE_FILES = \[[\s\S]{0,80}?'server\.cjs'/.test(DEPLOY));
  t('★★ 会传 manage.html', /'manage\.html'/.test(DEPLOY));
  t('★★ 会传 APK 与 version.json', /lifekit-latest\.apk/.test(DEPLOY) && /version\.json/.test(DEPLOY));
  t('★★ 会建 apk 目录（云端原本没有）', /mkdir -p \$\{APK_DIR\}|mkdir -p .*apk/.test(DEPLOY));
  t('★★ 部署后验证 /api/version 通了', /api\/version/.test(DEPLOY) && /versionCode/.test(DEPLOY));
  t('★ 部署后验证 APK 真的在服务器上', /lifekit-latest\.apk 2>\/dev\/null/.test(DEPLOY));

  /** ★ 注释记下了根因，免得以后有人又改回"只传 APK" */
  t('★★★ 注释说明了根因（旧脚本只传 APK 导致云端 404）', /只传 APK/.test(DEPLOY) && /404/.test(DEPLOY));
}

console.log('\n=== 4) 部署后不会破坏授权判定 ===');
{
  /**
   * ⚠️ 新代码必须保留 `/api/auth-state` —— 那是授权的服务端确认。
   *    如果部署把它搞没了，所有人都会被判成"未授权"。
   */
  const SERVER = fs.readFileSync(path.join(ROOT, 'server', 'server.cjs'), 'utf8');
  t('★★★ server.cjs 有 /api/auth-state', /'\/api\/auth-state'/.test(SERVER));
  t('★★★ 有 /api/verify-master（万能码校验）', /'\/api\/verify-master'/.test(SERVER));
  t('★★ 有 /api/users（管理页用）', /'\/api\/users'/.test(SERVER));
  t('★★ 有 /api/issue（生成授权码）', /'\/api\/issue'/.test(SERVER));
  /** ★ 部署后也验证一次 auth-state 正常 */
  t('★★ 部署脚本会抽查 auth-state', /auth-state/.test(DEPLOY));
}

console.log('\n=== 5) release.cjs 已切到完整部署 ===');
{
  /**
   * ⚠️ 这条断言**放宽过一次**：原先钉的是 `runNode('deploy-all.cjs')`（无参数）。
   *    后来加了测试通道，调用变成
   *      `runNode('deploy-all.cjs', TEST ? ['--test'] : [])`
   *    → 原来的正则匹配不到，报假红。
   *
   *    现在只要求"确实调了 deploy-all.cjs"，参数是什么不钉 ——
   *    参数的正确性由别的断言（测试通道文件名）覆盖。
   */
  t('★★ release 调的是 deploy-all.cjs', /runNode\('deploy-all\.cjs'/.test(RELEASE));
  t('★★★ release 不再调只传 APK 的旧脚本', !/runNode\('deploy-to-vps\.cjs'\)/.test(RELEASE));
  t('★★ 注释说明了为什么换（旧脚本不传服务端代码）', /只传 APK 和 version\.json/.test(RELEASE));
  /** 失败时给出可手动补传的命令，而不是只报错 */
  t('★★ 失败时提示手动补传命令', /deploy-all\.cjs --check/.test(RELEASE));
}

console.log('\n=== 6) --check 模式绝不修改线上 ===');
{
  t('★★ 有 --check 与 --code-only 模式', /--check/.test(DEPLOY) && /--code-only/.test(DEPLOY));
  /** 检查模式必须在上传/替换之前就退出 */
  const checkExit = DEPLOY.indexOf('CHECK_ONLY)');
  const uploadIdx = DEPLOY.indexOf('[4/6] 上传服务端代码');
  t('★★★ --check 在上传之前就退出（不动线上）', checkExit > 0 && uploadIdx > 0 && checkExit < uploadIdx);
  t('★★ 提示"未做任何修改"', /未做任何修改/.test(DEPLOY));
}

console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);

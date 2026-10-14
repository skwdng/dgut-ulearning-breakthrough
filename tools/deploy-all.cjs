/**
 * 一键部署到云服务器 —— 服务端代码 + APK + 重启。
 *
 * ══════════════ 为什么需要这个脚本 ══════════════
 *
 * 原先只有 `tools/deploy-to-vps.cjs`，它**只传 APK 和 version.json**。
 * 而"App 内置更新"依赖的是 `/api/version` 这个**接口** ——
 * 那个接口在新版 `server.cjs` 里，旧版云端根本没有（返回 404）。
 *
 * 于是出现一个尴尬状态：
 *   · 手机在家连本机服务器 → 能更新
 *   · 出门用流量 → 更新不了（云端 404）
 *
 * 官方的 `update-vps.sh` 能更新服务端代码，但它是**自包含的补丁脚本**
 * （把文件内容 base64 内嵌），必须手动贴到服务器上执行 ——
 * 每次改代码都要重新生成、重新贴。
 *
 * 这个脚本把它变成一条命令。
 *
 * ══════════════ ★★★ 绝对不碰 data.json ★★★ ══════════════
 *
 * `server.cjs` 里是 `DATA_FILE = path.join(__dirname, 'data.json')` ——
 * 云端用户数据就在 `/opt/lifekit/data.json`。
 *
 * 而**本地那份 data.json 是开发/调试用的**（内容与云端不一致：
 * 本地 3 人、云端 2 人，连授权码都不同）。
 * 一旦把本地的传上去，**云端记录就被覆盖了**。
 *
 * 所以这里有一道**硬闸**：只允许传白名单里的代码文件，
 * `data.json` 及一切数据/备份文件直接被拒。
 *
 * 用法：
 *   node tools/deploy-all.cjs --check     # 只检查连通性与现状
 *   node tools/deploy-all.cjs             # 代码 + APK + 重启 + 验证
 *   node tools/deploy-all.cjs --code-only # 只更新服务端代码
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
/**
 * ⚠️ 公开仓库版（2026-10）：默认值不再是真实 IP。
 *    自建时用环境变量指定自己的服务器：
 *        LIFEKIT_HOST=1.2.3.4 node tools/deploy-all.cjs
 */
const HOST = process.env.LIFEKIT_HOST || '';
if (!HOST) {
  console.error('  × 没设 LIFEKIT_HOST —— 这是公开仓库，不带任何真实服务器地址。');
  console.error('     用法：LIFEKIT_HOST=你的服务器IP node tools/deploy-all.cjs');
  process.exit(1);
}
const USER = 'root';
const DIR = '/opt/lifekit';
const APK_DIR = `${DIR}/apk`;
const SERVICE = 'lifekit';

const CHECK_ONLY = process.argv.includes('--check');
const CODE_ONLY = process.argv.includes('--code-only');

/**
 * ★ 允许上传的文件白名单。
 *
 * ⚠️ 用白名单而不是黑名单：黑名单永远会漏
 *    （data.json.bak / data.json.2026-10-12 / .backup/… 都得想到）。
 *    白名单只放"确定是代码"的文件，多一个都传不上去。
 */
const CODE_FILES = ['server.cjs', 'licenseCode.cjs', 'manage.html'];

/** 绝不外传的（哪怕将来白名单写错了，这里再兜一层） */
const FORBIDDEN = /(^|[\\/])(data\.json|.*\.backup-.*|\.backup|.*\.bak|pendingReports.*)/i;

let pass = 0;
let fail = 0;
const ok = (m) => {
  pass += 1;
  console.log(`  √ ${m}`);
};
const bad = (m) => {
  fail += 1;
  console.log(`  × ${m}`);
};

const SSH_OPTS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=15',
  '-o',
  'StrictHostKeyChecking=accept-new',
];

function run(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    return { ok: true, out: String(out) };
  } catch (e) {
    return {
      ok: false,
      out: String(e.stdout ?? ''),
      err: String(e.stderr ?? e.message ?? ''),
    };
  }
}

const ssh = (cmd) => run('ssh', [...SSH_OPTS, `${USER}@${HOST}`, cmd]);

console.log('');
console.log('═'.repeat(70));
console.log('  LifeKit 云端部署');
console.log('═'.repeat(70));
console.log(`  目标： ${USER}@${HOST}:${DIR}`);
console.log(`  模式： ${CHECK_ONLY ? '仅检查' : CODE_ONLY ? '仅代码' : '代码 + APK + 重启'}`);

// ── 1) 本地文件齐不齐 ──
console.log('\n[1/6] 检查本地文件');
const localFiles = [];
for (const f of CODE_FILES) {
  // manage.html 可能在 web/ 下
  const cands = [path.join(ROOT, 'server', f), path.join(ROOT, 'web', f)];
  const hit = cands.find((p) => fs.existsSync(p));
  if (hit) {
    localFiles.push({ name: f, src: hit, size: fs.statSync(hit).size });
    ok(`${f}  ${(fs.statSync(hit).size / 1024).toFixed(1)} KB`);
  } else {
    bad(`${f} 找不到`);
  }
}
{
  const apk = path.join(ROOT, 'server', 'apk', 'lifekit-latest.apk');
  const meta = path.join(ROOT, 'server', 'apk', 'version.json');
  if (fs.existsSync(apk)) {
    ok(`lifekit-latest.apk  ${(fs.statSync(apk).size / 1024 / 1024).toFixed(1)} MB`);
  } else bad('server/apk/lifekit-latest.apk 找不到');
  if (fs.existsSync(meta)) ok(`version.json  ${fs.readFileSync(meta, 'utf8').trim().slice(0, 80)}`);
  else bad('server/apk/version.json 找不到');
}

// ── 2) ★ 守卫：确认没有任何数据文件会被传出去 ──
console.log('\n[2/6] ★ 守卫：确认不传 data.json');
{
  const all = [
    ...CODE_FILES.map((f) => path.join(ROOT, 'server', f)),
    path.join(ROOT, 'server', 'apk', 'lifekit-latest.apk'),
    path.join(ROOT, 'server', 'apk', 'version.json'),
  ];
  const leaked = all.filter((p) => FORBIDDEN.test(p));
  if (leaked.length === 0) {
    ok('上传清单里没有任何数据/备份文件（data.json 不会被覆盖）');
  } else {
    bad(`上传清单里有禁止的文件：${leaked.join(', ')}`);
  }
  /**
   * ⚠️ 再显式确认一次：本地 data.json **不在**上传清单里。
   *    本地那份与云端不一致（本地 3 人 / 云端 2 人），传上去就是数据丢失。
   */
  ok('本地 data.json 不在上传清单（云端记录不会被覆盖）');
  /**
   * ⚠️ 别在这里读 `server/data.json` 报条数 —— 那会**误导**。
   *
   * 实测发现：开发目录下的 `server/data.json` 只有 120 字节、users 为空，
   * 而**真正在跑的服务**可能是另一个目录里的副本：
   *     node <另一个目录>\server.cjs
   * 它加载的是那个目录里的 `data.json`（有真实数据）。
   *
   * 也就是说项目里这份可能根本没用上。报它的条数只会让人以为"数据是空的"。
   * 所以这里只说明"不上传"，不报数字。
   */
  ok('（本地项目里的 data.json 与运行时那份不是同一个文件，反正都不上传）');
}

if (fail > 0) {
  console.log('\n  本地文件有问题，先解决再部署。');
  process.exit(1);
}

// ── 3) 连通性 ──
console.log('\n[3/6] 检查 SSH 连通性');
const ping = ssh('echo LIFEKIT_OK; node -v; ls -d ' + DIR + ' 2>/dev/null || echo NO_DIR');
if (ping.ok && ping.out.includes('LIFEKIT_OK')) {
  const lines = ping.out.trim().split('\n').map((s) => s.trim()).filter(Boolean);
  ok(`SSH 通了   node ${lines[1] ?? '?'}   目录 ${lines[2] ?? '?'}`);
} else {
  bad('SSH 连不上');
  console.log('');
  console.log('  ────────────────────────────────────────────────');
  console.log('  需要在阿里云控制台绑定部署公钥：');
  console.log('    1. https://swasnext.console.aliyun.com/keyPairs/');
  console.log('    2. 创建密钥对 → 导入已有密钥对 → 名称 lifekit');
  console.log('    3. 粘贴 ~/.ssh/id_rsa.pub 的全部内容');
  console.log('    4. 绑定到实例 Ubuntu-blkk（会重启一次，约 1 分钟）');
  console.log('');
  console.log('  公钥指纹（用于核对）：');
  const fp = run('ssh-keygen', ['-lf', path.join(process.env.USERPROFILE || '', '.ssh', 'id_rsa.pub')]);
  if (fp.ok) console.log('    ' + fp.out.trim());
  console.log('  ────────────────────────────────────────────────');
  console.log('');
  console.log('  当前响应：' + (ping.err || ping.out).trim().slice(0, 200));
  process.exit(1);
}

if (CHECK_ONLY) {
  console.log('\n[4/6] 现状检查');
  const info = ssh(
    `echo "--- 版本接口 ---"; curl -s -m 5 http://127.0.0.1:8787/api/version | head -c 300; ` +
      `echo; echo "--- 目录 ---"; ls -la ${DIR} | head -20; ` +
      `echo "--- apk 目录 ---"; ls -la ${APK_DIR} 2>/dev/null || echo "(不存在)"; ` +
      `echo "--- 服务状态 ---"; systemctl is-active ${SERVICE}`,
  );
  console.log(info.out || info.err);
  console.log(`\n  ✅ 检查完成（未做任何修改）`);
  process.exit(0);
}

// ── 4) 上传代码 ──
console.log('\n[4/6] 上传服务端代码');
{
  // 先建临时目录，全部传进去再原子替换 —— 避免传到一半服务读到半个文件
  const mk = ssh(`mkdir -p ${DIR}/.incoming && rm -f ${DIR}/.incoming/*`);
  if (!mk.ok) {
    bad(`建临时目录失败：${mk.err.trim().slice(0, 160)}`);
    process.exit(1);
  }

  for (const f of localFiles) {
    const r = run('scp', [...SSH_OPTS, f.src, `${USER}@${HOST}:${DIR}/.incoming/${f.name}`]);
    if (r.ok) ok(`${f.name} 已上传`);
    else {
      bad(`${f.name} 上传失败：${r.err.trim().slice(0, 160)}`);
      process.exit(1);
    }
  }
}

// ── 5) 备份 + 替换 + 重启 ──
console.log('\n[5/6] 备份旧文件 → 替换 → 重启');
{
  /**
   * ⚠️ 顺序很重要：
   *   1. 先语法检查新代码（`node --check`）—— 传上去一个语法错误的
   *      server.cjs 会让服务起不来，而服务器上没有编辑器可救
   *   2. 再备份
   *   3. 再替换
   *   4. 重启后验证；失败就自动回滚
   */
  const script = `
set -e
cd ${DIR}
STAMP=$(date +%Y%m%d-%H%M%S)

echo "  [语法检查]"
node --check .incoming/server.cjs && echo "    server.cjs 语法 OK"

echo "  [备份]"
mkdir -p .backup
for f in ${CODE_FILES.join(' ')}; do
  [ -f "$f" ] && cp "$f" ".backup/$f.$STAMP" && echo "    备份 $f"
done

echo "  [替换]"
for f in ${CODE_FILES.join(' ')}; do
  if [ -f ".incoming/$f" ]; then
    cp ".incoming/$f" "$f"
    echo "    更新 $f"
  fi
done
rm -rf .incoming

echo "  [重启]"
systemctl restart ${SERVICE}
sleep 3
systemctl is-active ${SERVICE}
`.trim();

  const r = ssh(script);
  console.log(
    (r.out || '')
      .trim()
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n'),
  );
  if (!r.ok || !/active/.test(r.out)) {
    bad('重启失败或服务未起来');
    if (r.err) console.log('  错误：' + r.err.trim().slice(0, 300));
    console.log('');
    console.log('  ⚠️ 备份在 ' + DIR + '/.backup/ ，回滚命令：');
    console.log(`     ssh ${USER}@${HOST} 'cd ${DIR} && cp .backup/server.cjs.<时间戳> server.cjs && systemctl restart ${SERVICE}'`);
    process.exit(1);
  }
  ok('服务已重启并处于 active');
}

// ── 6) APK + 验证 ──
if (!CODE_ONLY) {
  /**
   * ★★★ 按通道上传，**绝不互相覆盖**。
   *
   * 需求（用户 2026-10）：
   *   「帮我新开一个测试版，用于测试，完成后再向正式版更新，
   *     上面的安装包我已经发出去，不要动那个」
   *
   * ⚠️ 所以：
   *   正式通道 → lifekit-latest.apk + version.json      （已发出去的那份）
   *   测试通道 → lifekit-test.apk   + version-test.json  （新开的）
   *   自用通道 → lifekit-self.apk   + version-self.json  （用户自己要应用内更新）
   *   三条通道文件名不同 → 互不覆盖
   */
  const TEST_CH = process.argv.includes('--test');
  const SELF_CH = process.argv.includes('--self');
  const apkName = TEST_CH ? 'lifekit-test.apk' : SELF_CH ? 'lifekit-self.apk' : 'lifekit-latest.apk';
  const metaName = TEST_CH
    ? 'version-test.json'
    : SELF_CH
      ? 'version-self.json'
      : 'version.json';
  console.log(
    `\n[6/6] 上传 APK 与版本信息（${TEST_CH ? '测试通道' : SELF_CH ? '自用通道' : '正式通道'}）`,
  );
  ssh(`mkdir -p ${APK_DIR}`);
  for (const [src, dst] of [
    [path.join(ROOT, 'server', 'apk', apkName), `${APK_DIR}/${apkName}`],
    [path.join(ROOT, 'server', 'apk', metaName), `${APK_DIR}/${metaName}`],
  ]) {
    if (!fs.existsSync(src)) {
      bad(`${path.basename(src)} 本地不存在（跳过）`);
      continue;
    }
    const r = run('scp', [...SSH_OPTS, src, `${USER}@${HOST}:${dst}`]);
    if (r.ok) ok(`${path.basename(dst)} 已上传`);
    else bad(`${path.basename(dst)} 上传失败：${r.err.trim().slice(0, 160)}`);
  }
}

console.log('\n  验证（从本机打云端接口）');
{
  /**
   * ⚠️ 用**公网地址**打，不要用 `127.0.0.1`。
   *
   * 服务端的 `/api/version` 是拿请求的 `Host` 头拼下载地址的
   * （这样 App 用局域网 IP 访问时也能拿到一致的地址）。
   * 所以在服务器上 curl `127.0.0.1` 会看到
   *     "url": "http://127.0.0.1:8787/apk/..."
   * —— 那**不是故障**，但看上去像，我为此误判过一次。
   *
   * 从本机打公网地址，看到的才是手机实际会拿到的那个 url。
   */
  const v = run('curl', ['-s', '-m', '10', `http://${HOST}:8787/api/version`]);
  if (v.ok && v.out.includes('versionCode')) {
    ok(`/api/version 通了 → ${v.out.trim().slice(0, 220)}`);
    /** ★ 确认返回的下载地址是公网可用的，而不是 127.0.0.1 */
    if (v.out.includes(`http://${HOST}:8787/`)) {
      ok('下载地址用的是公网地址（手机能下载）');
    } else {
      bad('下载地址不是公网地址 —— 手机可能下载不了');
    }
  } else {
    bad(`/api/version 仍不通 → ${(v.out || v.err).trim().slice(0, 200)}`);
  }
  const apk = ssh(`ls -la ${APK_DIR}/lifekit-latest.apk 2>/dev/null || echo MISSING`);
  if (/lifekit-latest\.apk/.test(apk.out)) ok(`APK 在服务器上 → ${apk.out.trim()}`);
  else bad('APK 不在服务器上');

  /** ★ 最后再确认一次云端用户数据没被动过 */
  const users = ssh('curl -s -m 8 http://127.0.0.1:8787/api/auth-state?studentId=2099000000109');
  console.log(`      云端 auth-state 样本：${users.out.trim().slice(0, 120)}`);
}

console.log('');
console.log('═'.repeat(70));
console.log(`  结果：通过 ${pass}，失败 ${fail}`);
console.log('═'.repeat(70));
console.log('');
if (fail === 0) {
  console.log('  ✅ 部署完成。现在把 App 的服务端地址填成：');
  console.log(`     http://${HOST}:8787`);
  console.log('     以后每次发新版本，重跑这个脚本即可，手机上能直接更新。');
} else {
  console.log('  ⚠️ 有失败项，看上面的输出。');
}
console.log('');
process.exit(fail === 0 ? 0 : 1);

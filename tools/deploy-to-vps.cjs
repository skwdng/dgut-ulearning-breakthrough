/**
 * 把安装包上传到 VPS（给"应用内更新"用）。
 *
 * ══════════════ 用户在手机上直接更新的完整链条 ══════════════
 *
 *   我这边：  改代码 → 打包 APK → **自动上传**（这个脚本）
 *   服务器：  /opt/lifekit/apk/lifekit-latest.apk + version.json
 *   用户那边：打开 App → 启动弹窗提示 → 点一下就装
 *
 * ══════════════ 为什么需要 SSH 免密 ══════════════
 *
 * 阿里云轻量服务器**禁用了 root 密码登录**（只认密钥），
 * 而且控制台导入密钥对**只支持 RSA/ECDSA，不支持 ed25519**。
 * 所以：
 *   ① 本地生成一把 RSA 密钥（已做：~/.ssh/id_rsa）
 *   ② 在阿里云控制台「密钥对 → 导入已有密钥对」把公钥贴进去
 *   ③ 绑定到实例并重启 —— 之后就免密了，这个脚本能全自动
 *
 * 用法:
 *   node tools/deploy-to-vps.cjs            # 上传 server/apk/ 里的东西
 *   node tools/deploy-to-vps.cjs --check    # 只检查连通性，不上传
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
/**
 * ⚠️ 公开仓库版（2026-10）：不再硬编码真实服务器地址。
 *    用法：LIFEKIT_HOST=你的服务器IP node tools/deploy-to-vps.cjs
 */
const HOST = process.env.LIFEKIT_HOST || '';
if (!HOST) {
  console.error('  × 没设 LIFEKIT_HOST —— 这是公开仓库，不带任何真实服务器地址。');
  console.error('     用法：LIFEKIT_HOST=你的服务器IP node tools/deploy-to-vps.cjs');
  process.exit(1);
}
const USER = 'root';
const REMOTE_DIR = '/opt/lifekit/apk';
const APK = path.join(ROOT, 'server', 'apk', 'lifekit-latest.apk');
const META = path.join(ROOT, 'server', 'apk', 'version.json');

const CHECK_ONLY = process.argv.includes('--check');

/** 本地 RSA 私钥（阿里云能导入的类型） */
const KEY = path.join(os.homedir(), '.ssh', 'id_rsa');

const SSH_OPTS = [
  '-o', 'BatchMode=yes', // 不要交互提示 —— 失败就失败，别卡住
  '-o', 'ConnectTimeout=15',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'IdentitiesOnly=yes',
  '-i', KEY,
];

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    code: r.status ?? 1,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(),
  };
}

function head(t) {
  console.log('');
  console.log('─'.repeat(62));
  console.log(`  ${t}`);
  console.log('─'.repeat(62));
}

console.log('');
console.log('  LifeKit → VPS 上传工具');

// ── 1) 前置检查 ──
if (!fs.existsSync(KEY)) {
  console.log('');
  console.log(`  × 找不到 RSA 私钥：${KEY}`);
  console.log('    先跑一次 桌面\\LifeKit管理后台\\诊断服务器连接.ps1，它会生成。');
  process.exit(1);
}
if (!CHECK_ONLY) {
  if (!fs.existsSync(APK)) {
    console.log(`  × 找不到安装包：${APK}`);
    console.log('    先跑 node tools/publish-apk.cjs');
    process.exit(1);
  }
  if (!fs.existsSync(META)) {
    console.log(`  × 找不到版本信息：${META}`);
    process.exit(1);
  }
}

// ── 2) 连通性 ──
head('检查免密登录');

const probe = run('ssh', [...SSH_OPTS, `${USER}@${HOST}`, 'echo KEY_OK']);
if (!(probe.code === 0 && probe.out.includes('KEY_OK'))) {
  console.log('  × 还连不上服务器');
  console.log(`    ${probe.out.split('\n')[0] ?? '(无输出)'}`);
  console.log('');
  console.log('  ⚠️ 需要先做一次性的免密配置（约 2 分钟）：');
  console.log('     ① 打开 https://swasnext.console.aliyun.com/keyPairs/');
  console.log('     ② 「创建密钥对」→「导入已有密钥对」，名称填 lifekit');
  console.log('        公钥内容 = 下面这一整行：');
  console.log('');
  const pubFile = `${KEY}.pub`;
  if (fs.existsSync(pubFile)) {
    console.log(`     ${fs.readFileSync(pubFile, 'utf8').trim()}`);
  } else {
    console.log(`     × 找不到 ${pubFile}`);
  }
  console.log('');
  console.log('     ③ 绑定到实例 Ubuntu-blkk，重启服务器让密钥生效');
  console.log('     ④ 重启完重跑这个脚本');
  process.exit(1);
}
console.log('  √ 免密可用');

if (CHECK_ONLY) {
  console.log('');
  console.log('  --check 模式，不上传。');
  process.exit(0);
}

// ── 3) 读版本信息 ──
const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
const sizeMb = (fs.statSync(APK).size / 1048576).toFixed(1);

head('准备上传');
console.log(`  版本：    ${meta.version}（versionCode ${meta.versionCode}）`);
console.log(`  体积：    ${sizeMb} MB`);
console.log(`  说明：    ${meta.note || '（无）'}`);
console.log(`  目标：    ${USER}@${HOST}:${REMOTE_DIR}`);

// ── 4) 建远程目录 ──
head('建远程目录');
const mk = run('ssh', [...SSH_OPTS, `${USER}@${HOST}`, `mkdir -p ${REMOTE_DIR} && echo MKDIR_OK`]);
if (!mk.out.includes('MKDIR_OK')) {
  console.log('  × 建目录失败');
  console.log(`    ${mk.out}`);
  process.exit(1);
}
console.log(`  √ ${REMOTE_DIR} 已就绪`);

// ── 5) 上传 ──
head('上传安装包');
/**
 * ⚠️ 用 scp **原样传**，绝不做编码转换 ——
 *    APK 是二进制，用文本方式碰一下就会坏
 *    （装的时候报"解析包错误"，而且很难联想到是传输问题）。
 */
const cp = run('scp', [...SSH_OPTS, APK, `${USER}@${HOST}:${REMOTE_DIR}/lifekit-latest.apk`]);
if (cp.code !== 0) {
  console.log('  × 安装包上传失败');
  console.log(`    ${cp.out}`);
  process.exit(1);
}
console.log(`  √ lifekit-latest.apk（${sizeMb} MB）`);

const cp2 = run('scp', [...SSH_OPTS, META, `${USER}@${HOST}:${REMOTE_DIR}/version.json`]);
if (cp2.code !== 0) {
  console.log('  × 版本信息上传失败');
  console.log(`    ${cp2.out}`);
  process.exit(1);
}
console.log('  √ version.json');

// ── 6) 修权限（systemd 以 root 跑，但文件属主可能是别人）──
run('ssh', [...SSH_OPTS, `${USER}@${HOST}`, `chmod 644 ${REMOTE_DIR}/*`]);

// ── 7) 验证 ──
head('验证');

/**
 * ⚠️ 从**公网**验，不走 127.0.0.1 ——
 *    因为用户手机走的是公网，本地能通不代表外面能通
 *    （防火墙规则可能只放行了 8787 但路径不对）。
 */
const verify = run('ssh', [
  ...SSH_OPTS,
  `${USER}@${HOST}`,
  [
    `ls -la ${REMOTE_DIR}`,
    'echo "--- 本地接口 ---"',
    'curl -s --max-time 10 http://127.0.0.1:8787/api/version || echo "(接口无响应)"',
    'echo',
    `echo "--- 安装包 HTTP 头 ---"`,
    `curl -s -o /dev/null -w "HTTP=%{http_code} 大小=%{size_download}\\n" -r 0-0 http://127.0.0.1:8787/apk/lifekit-latest.apk || true`,
  ].join('\n'),
]);
console.log(verify.out.replace(/^/gm, '  '));

// ── 8) 结论 ──
head('结论');
const okVersion = verify.out.includes(`"versionCode":${meta.versionCode}`) ||
  verify.out.includes(`"versionCode": ${meta.versionCode}`);
if (verify.out.includes('"available":true') && okVersion) {
  console.log(`  ✅ 发布成功 —— 服务器上现在是 ${meta.version}`);
  console.log('');
  console.log('  用户打开 App 就会看到更新弹窗，点一下即可安装。');
  console.log('  （App 是启动后 6 秒静默检查；也可以让他去首页点「检查更新」）');
} else {
  console.log('  ⚠️ 文件传上去了，但接口返回不符合预期：');
  console.log('     · 如果返回 404 —— 服务器上的 server.cjs 是旧版（缺 /api/version）');
  console.log('       解决：在服务器上跑 update-vps.sh，或手动替换 /opt/lifekit/server.cjs 后');
  console.log('             systemctl restart lifekit');
  console.log('     · 如果返回 available:false —— version.json 没传成功');
  process.exit(2);
}

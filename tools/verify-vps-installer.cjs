/**
 * 验证 VPS 安装脚本的正确性。
 *
 * ══════════════ 为什么必须验 ══════════════
 * install-vps.sh 里的文件是用 base64 内嵌的 ——
 * 这是最容易"看起来装成功、实际文件坏了"的环节：
 *   · base64 换行位置切错 → 解出来少一段
 *   · 混进 BOM 或 \r\n     → shell 报错或文件内容被污染
 *   · 脚本里 \${} 转义写错 → 变量没展开，端口变成字面量
 *
 * 而这个脚本是要在**用户买来的服务器上**跑的 ——
 * 那里出错，用户很难自己排查。所以在这里先验干净。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

/**
 * ⚠️ 两个脚本都要验：
 *   install-vps.sh —— 首次完整安装（装 Node、写 systemd unit）
 *   update-vps.sh  —— 后续补丁（只覆盖文件 + 重启，含回滚）
 *   它们共用同一套 base64 内嵌机制，任何一边坏了都会在服务器上炸，
 *   而服务器上排查很难 —— 所以两个都放在这里验。
 */
const TARGETS = [
  { name: 'install-vps.sh', extra: true },
  { name: 'update-vps.sh', extra: false },
];

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

/** 源文件映射（两个脚本内嵌的是同一批文件） */
const SRC = {
  'server.cjs': path.join(ROOT, 'server', 'server.cjs'),
  'licenseCode.cjs': path.join(ROOT, 'server', 'licenseCode.cjs'),
  'manage.html': path.join(ROOT, 'web', 'manage.html'),
};

/** 从某个脚本里抠出所有 base64 块 */
function extractBlocks(text) {
  const re = /write_file "([^"]+)" <<'LIFEKIT_B64_EOF'\n([\s\S]*?)\nLIFEKIT_B64_EOF/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) out.push({ name: m[1], b64: m[2].replace(/\n/g, '') });
  return out;
}

/** 对单个脚本做全套检查 */
function checkScript(target) {
  const SH_PATH = path.join(ROOT, 'server', target.name);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${target.name}`);
  console.log(`${'═'.repeat(60)}`);

  if (!fs.existsSync(SH_PATH)) {
    t('文件存在', false, SH_PATH);
    return;
  }
  const sh = fs.readFileSync(SH_PATH, 'utf8');

  console.log('\n  ── 基本要求 ──');
  t('没有 BOM（会让 shell 第一行报错）', !sh.startsWith('\uFEFF'));
  t('没有 \\r\\n（Windows 换行会让 bash 报 syntax error）', !sh.includes('\r\n'));
  t('有 shebang', sh.startsWith('#!/bin/bash'));
  t('要求 root', /id -u/.test(sh) && /需要 root/.test(sh));
  t('set -e（出错就停）', /^set -e$/m.test(sh));
  t('会做语法自检', /node --check/.test(sh));
  t('★ 检查服务是否真的起来了', /systemctl is-active --quiet/.test(sh));
  t('失败时打印日志', /journalctl -u/.test(sh));

  if (target.extra) {
    console.log('\n  ── 完整安装脚本特有 ──');
    t('注册 systemd 服务', /systemctl enable/.test(sh));
    t('开机自启 + 崩溃重启', /Restart=always/.test(sh));
    t('提醒放行安全组', /安全组/.test(sh));
    t('提醒设管理口令', /设管理口令/.test(sh));
    t('打印公网 IP', /api\.ipify\.org/.test(sh));
    t('端口可被环境变量覆盖', /PORT="\$\{LIFEKIT_PORT:-8787\}"/.test(sh));
  } else {
    console.log('\n  ── 补丁脚本特有 ──');
    t('★ 不重装 Node（只是补丁）', !/apt-get install/.test(sh));
    t('★ 改文件前先备份', /\.backup/.test(sh) && /cp "\$DIR\/\$f"/.test(sh));
    t('★★ 语法不过就回滚（不把坏文件留在生产）', /语法检查失败，正在回滚/.test(sh));
    t('★★ 服务起不来也回滚', /服务没起来，正在回滚/.test(sh));
    t('★ 明确说明数据/口令不会被覆盖', /没有被覆盖/.test(sh));
    t('会重启服务', /systemctl restart/.test(sh));
  }

  console.log('\n  ── ★ base64 解出来必须与原文件逐字节一致 ──');
  const found = extractBlocks(sh);
  t(`抠到 ${Object.keys(SRC).length} 个内嵌文件`, found.length === Object.keys(SRC).length, `实际 ${found.length}`);

  for (const f of found) {
    const src = SRC[f.name];
    if (!src) {
      t(`${f.name} 有对应源文件`, false, '脚本里出现了未知文件');
      continue;
    }
    const expected = fs.readFileSync(src);
    const actual = Buffer.from(f.b64, 'base64');
    t(
      `★ ${f.name} 逐字节一致（${expected.length} 字节）`,
      expected.equals(actual),
      expected.length === actual.length ? '长度相同但内容不同' : `长度 ${expected.length} vs ${actual.length}`,
    );
    t(`  ${f.name} 中文没坏`, !actual.toString('utf8').includes('\uFFFD'));

    // GNU base64 的严格规则（Node 会静默忽略非法字符，GNU 会报错）
    t(`  ${f.name} 字符集合法`, /^[A-Za-z0-9+/]*={0,2}$/.test(f.b64));
    t(`  ${f.name} 长度是 4 的倍数`, f.b64.length % 4 === 0);
    t(`  ${f.name} 重新编码后与原文一致（规范 base64）`, actual.toString('base64') === f.b64);
  }

  console.log('\n  ── 内嵌的 server.cjs 本身合法 ──');
  {
    const sc = extractBlocks(sh).find((x) => x.name === 'server.cjs');
    if (!sc) {
      t('能找到 server.cjs 块', false);
    } else {
      const code = Buffer.from(sc.b64, 'base64').toString('utf8');
      const tmp = path.join(ROOT, `.tmp-${target.name}-check.cjs`);
      fs.writeFileSync(tmp, code, 'utf8');
      try {
        execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
        t('★ 语法正确', true);
      } catch (e) {
        t('★ 语法正确', false, String(e.stderr ?? e.message).slice(0, 300));
      } finally {
        fs.unlinkSync(tmp);
      }
      t(
        '★ 与源文件一致（再确认一次）',
        code === fs.readFileSync(path.join(ROOT, 'server', 'server.cjs'), 'utf8'),
      );
    }
  }

  console.log('\n  ── heredoc 定界符用法 ──');
  t('★ base64 块用带引号定界符（内容不被展开）', /<<'LIFEKIT_B64_EOF'/.test(sh));
  if (target.extra) {
    t('★ systemd unit 用不带引号定界符（变量要展开）', /<<LIFEKIT_UNIT_EOF/.test(sh));
  }
}

(async () => {
  for (const target of TARGETS) checkScript(target);

  console.log('\n=== 展开后的 systemd unit（用完整安装脚本验） ===');
  {
    const sh = fs.readFileSync(path.join(ROOT, 'server', 'install-vps.sh'), 'utf8');
    const DIR = '/opt/lifekit';
    const PORT = '8787';
    const NODE = '/usr/bin/node';
    const expanded = sh
      .replace(/\$\(command -v node\)/g, NODE)
      .replace(/\$DIR/g, DIR)
      .replace(/\$PORT/g, PORT)
      .replace(/\$SERVICE/g, 'lifekit');
    const m = /cat > "\/etc\/systemd\/system\/lifekit\.service"[\s\S]*?\n([\s\S]*?)\nLIFEKIT_UNIT_EOF/.exec(expanded);
    const unit = m ? m[1] : '';
    for (const line of unit.split('\n')) console.log(`     ${line}`);
    t('★ WorkingDirectory 展开正确', unit.includes(`WorkingDirectory=${DIR}`));
    t('★ ExecStart 展开正确', unit.includes(`ExecStart=${NODE} ${DIR}/server.cjs`));
    t('★ 端口展开正确', unit.includes('Environment=LIFEKIT_PORT=8787'));
    t('unit 三段齐全', /\[Unit\]/.test(unit) && /\[Service\]/.test(unit) && /\[Install\]/.test(unit));
  }

  console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('  异常：' + (e?.stack ?? e));
  process.exit(1);
});

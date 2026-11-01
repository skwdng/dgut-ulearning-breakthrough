// 接受 Android SDK 许可并安装组件。
//
// 为什么用 Node 而不是 .bat：
// 批处理里的引号嵌套 + `%~dp0..\..\` 路径拼接极容易出错（已踩），
// Node 的 spawnSync 可以直接传参数数组，不用拼字符串。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKSPACE = path.resolve(__dirname, '..', '..');
const SDK = path.join(WORKSPACE, '.android-sdk');
const SM = path.join(SDK, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat');
const JAVA_HOME = process.env.LIFEKIT_JAVA_HOME || 'D:\\env\\jdk';

console.log('SDK:       ' + SDK);
console.log('sdkmanager: ' + SM);
console.log('JAVA_HOME: ' + JAVA_HOME);
console.log('存在:      ' + fs.existsSync(SM));
if (!fs.existsSync(SM)) process.exit(1);

const env = { ...process.env, JAVA_HOME, ANDROID_HOME: SDK, ANDROID_SDK_ROOT: SDK };

/** 跑 sdkmanager，把 stdin 填满 y 以接受许可 */
function run(args, label) {
  console.log(`\n── ${label} ──`);
  const r = spawnSync('cmd.exe', ['/c', SM, '--sdk_root=' + SDK, ...args], {
    env,
    input: 'y\n'.repeat(40),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = (r.stdout || '') + (r.stderr || '');
  // 只打印关键行，避免刷屏
  const lines = out.split('\n').filter((l) => l.trim());
  const keep = lines.filter((l) => /installed|Installing|Accept|license|error|Error|warning|Warning|100%|done|Unzipping|Downloading/i.test(l));
  for (const l of keep.slice(-18)) console.log('  ' + l.trim());
  if (r.status !== 0) console.log(`  (退出码 ${r.status})`);
  return r.status === 0;
}

// 1) 接受所有许可
run(['--licenses'], '接受许可');

// 2) 安装组件
const ok = run(['platform-tools', 'platforms;android-35', 'build-tools;35.0.0'], '安装组件');

// 3) 列出已安装
console.log('\n── 已安装组件 ──');
const r = spawnSync('cmd.exe', ['/c', SM, '--sdk_root=' + SDK, '--list_installed'], { env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const installed = (r.stdout || '').split('\n').filter((l) => /^\s+\S/.test(l) && !/^\[/.test(l.trim()));
for (const l of installed.slice(0, 20)) console.log('  ' + l.trim());

// 4) 校验关键目录
console.log('\n── 目录校验 ──');
for (const d of ['platform-tools', 'platforms\\android-35', 'build-tools\\35.0.0']) {
  const p = path.join(SDK, d);
  console.log(`  ${fs.existsSync(p) ? '√' : '×'} ${d}`);
}

console.log(ok ? '\n完成' : '\n有失败，请看上面输出');

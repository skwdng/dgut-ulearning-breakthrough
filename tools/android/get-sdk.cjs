// 下载并解压 Android command-line tools（零依赖，只用 Node 内置模块）。
// 目标：<workspace>/.android-sdk/cmdline-tools/latest/
//
// 为什么装在工程目录里而不是 D:\android-sdk：
// 受沙箱限制只能写工作区，装在工程内可以不必提权。
// `.android-sdk/` 已在 .gitignore 里。
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const WORKSPACE = path.resolve(__dirname, '..', '..');
const SDK_ROOT = process.env.LIFEKIT_ANDROID_SDK || path.join(WORKSPACE, '.android-sdk');
const OUT = path.join(SDK_ROOT, 'cmdline-tools');
const TMP = path.join(SDK_ROOT, '_tmp');

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

const URL = 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip';

function fetch(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向过多'));
    https.get(url, { headers: { 'User-Agent': 'node' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetch(res.headers.location, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      let got = 0;
      res.on('data', (c) => { chunks.push(c); got += c.length; });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

/** 极简 ZIP 解包（只处理 store 与 deflate，够用） */
function unzip(buf, dest) {
  // 找 End of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  let n = 0;
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;

    // 读 local header 定位数据
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let content;
    if (method === 0) content = raw;
    else if (method === 8) content = zlib.inflateRawSync(raw);
    else continue;

    const target = path.join(dest, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    n += 1;
  }
  return n;
}

(async () => {
  console.log('下载 Android 命令行工具…');
  console.log('  ' + URL);
  const t0 = Date.now();
  const zip = await fetch(URL);
  console.log(`  下载完成 ${(zip.length / 1024 / 1024).toFixed(1)} MB  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 先解到 _tmp，再重排成 cmdline-tools/latest
  const n = unzip(zip, TMP);
  console.log(`  解压 ${n} 个文件`);

  const src = path.join(TMP, 'cmdline-tools');
  if (!fs.existsSync(src)) throw new Error('解压后没有 cmdline-tools 目录');

  const latest = path.join(OUT, 'latest');
  fs.rmSync(latest, { recursive: true, force: true });
  fs.renameSync(src, latest);
  fs.rmSync(TMP, { recursive: true, force: true });

  const bin = path.join(latest, 'bin');
  console.log('\n安装完成，工具目录:');
  for (const f of fs.readdirSync(bin)) console.log('  ' + f);
  console.log('\nSDK 根目录: ' + SDK_ROOT.replace(/\//g, '\\'));
})();

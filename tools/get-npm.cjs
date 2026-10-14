// 从镜像下载 npm 并解压到 .tools/npm，用于替代 pnpm 做扁平安装。
// 只用 Node 内置模块（https + zlib + 自写 tar 解包），不依赖外部工具。
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = __dirname + '/.tools/npm';
fs.mkdirSync(OUT, { recursive: true });

function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https
      .get(url, { headers: { 'User-Agent': 'node' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(fetchBuffer(res.headers.location, redirects + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

/** 极简 tar 解包（只处理普通文件与目录，npm 包够用） */
function untar(buf, dest, stripComponents = 0) {
  let offset = 0;
  let count = 0;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '').trim();
    if (!name) {
      offset += 512;
      continue;
    }
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = sizeStr ? parseInt(sizeStr, 8) : 0;
    const typeFlag = String.fromCharCode(header[156]);
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '').trim();
    const fullName = prefix ? `${prefix}/${name}` : name;

    offset += 512;
    const content = buf.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (typeFlag === '5' || fullName.endsWith('/')) continue;

    const parts = fullName.split('/');
    const rel = parts.slice(stripComponents).join('/');
    if (!rel || rel.includes('..')) continue;

    const target = path.join(dest, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    count += 1;
  }
  return count;
}

(async () => {
  // 1) 查 dist-tags 拿最新版号
  const meta = JSON.parse((await fetchBuffer('https://registry.npmmirror.com/npm')).toString('utf8'));
  const version = meta['dist-tags'].latest;
  console.log('npm 最新版本:', version);

  const tarball = meta.versions[version].dist.tarball;
  console.log('下载:', tarball);
  const tgz = await fetchBuffer(tarball);
  console.log('tarball 大小:', (tgz.length / 1024 / 1024).toFixed(2), 'MB');

  const tar = zlib.gunzipSync(tgz);
  const n = untar(tar, OUT, 1); // 去掉最外层 package/
  console.log('解压文件数:', n);

  const cli = path.join(OUT, 'bin', 'npm-cli.js');
  console.log('npm-cli.js 存在:', fs.existsSync(cli));
  console.log('路径:', cli.replace(/\\/g, '/'));
})();

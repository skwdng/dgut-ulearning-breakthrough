/**
 * 把 .cmd / .bat 转成 **GBK（系统代码页）** 编码。
 *
 * ══════════ 为什么必须转 ══════════
 * 中文 Windows 的代码页是 936（GBK），而 **cmd.exe 是按系统代码页读 .cmd 文件的**。
 * 如果文件是 UTF-8（哪怕是纯文本、没 BOM），里面的中文会被按 GBK 解成乱码，
 * 于是每一行都变成：
 *
 *     '锟斤拷' 不是内部或外部命令，也不是可运行的程序
 *
 * → **整个启动脚本废掉**，窗口刷一屏报错。
 *
 * 注意：`chcp 65001` 只影响**控制台输出**的代码页，**不改变 cmd 读文件的方式**，
 * 所以加了它也没用 —— 文件本身必须是 GBK。
 *
 * 用法: node tools/fix-cmd-encoding.cjs [目录...]
 */
const fs = require('fs');
const path = require('path');

// iconv-lite 在 npm 的 node_modules 里（工程根目录没有装）
const ICONV_CANDIDATES = [
  path.resolve(__dirname, '..', '.tools', 'npm', 'node_modules', 'iconv-lite'),
  path.resolve(__dirname, '..', 'node_modules', 'iconv-lite'),
];

let iconv = null;
for (const c of ICONV_CANDIDATES) {
  try {
    iconv = require(c);
    break;
  } catch {
    /* 试下一个 */
  }
}

if (!iconv) {
  console.error('  × 找不到 iconv-lite，无法转换。');
  console.error('    可用的候选路径：');
  for (const c of ICONV_CANDIDATES) console.error('      ' + c);
  process.exit(1);
}

const DIRS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      path.resolve(__dirname, '..', 'server'),
      path.resolve(__dirname, '..', 'server', '桌面版'),
    ];

/** 收集 .cmd / .bat */
function collect(dirs) {
  const out = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === 'node_modules') continue;
          walk(p);
        } else if (/\.(cmd|bat)$/i.test(e.name)) {
          out.push(p);
        }
      }
    };
    walk(d);
  }
  return out;
}

/** 判断是否已经是 GBK：用 GBK 解出来再编回去，看是否与原文一致 */
function isGbk(buf) {
  const decoded = iconv.decode(buf, 'gbk');
  const re = iconv.encode(decoded, 'gbk');
  return re.equals(buf) && !decoded.includes('\uFFFD');
}

const files = collect(DIRS);
console.log(`  检查 ${files.length} 个 .cmd / .bat`);
console.log('');

let converted = 0;
let already = 0;
let failed = 0;

for (const f of files) {
  const rel = f.replace(path.resolve(__dirname, '..') + path.sep, '');
  const buf = fs.readFileSync(f);

  // 先按 UTF-8 解（我们写的文件都是 UTF-8）
  const asUtf8 = buf.toString('utf8');
  const hasReplacement = asUtf8.includes('\uFFFD');

  if (hasReplacement) {
    // UTF-8 解不出来 → 可能已经是 GBK
    if (isGbk(buf)) {
      console.log(`  · ${rel}  已是 GBK，跳过`);
      already += 1;
      continue;
    }
    console.log(`  × ${rel}  既不是合法 UTF-8 也不是合法 GBK，跳过（请人工检查）`);
    failed += 1;
    continue;
  }

  // 内容里有中文吗？没有中文就无所谓编码
  const hasChinese = /[\u4e00-\u9fa5]/.test(asUtf8);

  const gbkBuf = iconv.encode(asUtf8, 'gbk');
  if (gbkBuf.equals(buf)) {
    console.log(`  · ${rel}  已是 GBK，跳过`);
    already += 1;
    continue;
  }

  fs.writeFileSync(f, gbkBuf);
  console.log(`  √ ${rel}  UTF-8 → GBK（${buf.length} → ${gbkBuf.length} 字节）${hasChinese ? ' 含中文' : ''}`);
  converted += 1;
}

console.log('');
console.log(`  转换 ${converted} 个，已是 GBK ${already} 个，失败 ${failed} 个`);

// 复核：转换后再验一遍，确保能被 GBK 正确解出中文
let bad = 0;
for (const f of files) {
  const buf = fs.readFileSync(f);
  const text = iconv.decode(buf, 'gbk');
  if (text.includes('\uFFFD') || !isGbk(buf)) {
    console.log(`  × ${f} 复核失败：GBK 解码异常`);
    bad += 1;
  }
}
if (bad === 0) console.log('  ✅ 全部可用 GBK 正确解码');

process.exit(failed === 0 && bad === 0 ? 0 : 1);

/**
 * 把 .cmd 在 **UTF-8（源码形态）** 与 **GBK（运行形态）** 之间转换。
 *
 * ══════════ 为什么需要来回转 ══════════
 *   · **编辑时**用 UTF-8 —— 编辑器和工具链都按 UTF-8 处理，中文不会乱。
 *   · **运行时**必须 GBK —— cmd.exe 按系统代码页（中文 Windows = 936）读 .cmd，
 *     UTF-8 的中文会被解成乱码，每行都报"不是内部或外部命令"，脚本直接废掉。
 *
 * 所以约定：
 *   仓库里保存 **UTF-8**（能正常编辑与 review）
 *   发布/拷贝到桌面时转成 **GBK**（能正常双击运行）
 *
 * 用法：
 *   node tools/cmd-encoding.cjs to-utf8   [目录...]   转回可编辑形态
 *   node tools/cmd-encoding.cjs to-gbk    [目录...]   转成可运行形态
 *   node tools/cmd-encoding.cjs check     [目录...]   只检查，不改
 */
const fs = require('fs');
const path = require('path');

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
    /* 下一个 */
  }
}
if (!iconv) {
  console.error('  × 找不到 iconv-lite');
  process.exit(1);
}

const mode = (process.argv[2] || 'check').toLowerCase();
const dirArgs = process.argv.slice(3);
const DIRS = dirArgs.length
  ? dirArgs
  : [
      path.resolve(__dirname, '..', 'server'),
      path.resolve(__dirname, '..', 'server', '桌面版'),
    ];

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
        } else if (/\.(cmd|bat)$/i.test(e.name)) out.push(p);
      }
    };
    walk(d);
  }
  return out;
}

/** 这份字节流现在是哪种编码？（GBK 能「解出来再编回去」完全一致就是 GBK） */
function detect(buf) {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) {
    // 合法 UTF-8，但还要排除"纯 ASCII"（两者都合法）
    const hasNonAscii = /[^\x00-\x7F]/.test(utf8);
    return hasNonAscii ? 'utf8' : 'ascii';
  }
  const gbkText = iconv.decode(buf, 'gbk');
  const re = iconv.encode(gbkText, 'gbk');
  if (re.equals(buf) && !gbkText.includes('\uFFFD')) return 'gbk';
  return 'unknown';
}

const files = collect(DIRS);
console.log(`  模式: ${mode}    文件: ${files.length} 个`);
console.log('');

let changed = 0;
let ok = 0;
let bad = 0;

for (const f of files) {
  const rel = f.replace(path.resolve(__dirname, '..') + path.sep, '');
  const buf = fs.readFileSync(f);
  const enc = detect(buf);

  if (mode === 'check') {
    if (enc === 'gbk' || enc === 'ascii') {
      console.log(`  √ ${rel}  ${enc}`);
      ok += 1;
    } else if (enc === 'utf8') {
      console.log(`  × ${rel}  是 UTF-8 —— 直接双击会全是乱码报错，需要 to-gbk`);
      bad += 1;
    } else {
      console.log(`  × ${rel}  编码无法识别`);
      bad += 1;
    }
    continue;
  }

  if (mode === 'to-utf8') {
    if (enc !== 'gbk') {
      console.log(`  · ${rel}  已是 ${enc}，跳过`);
      ok += 1;
      continue;
    }
    const text = iconv.decode(buf, 'gbk');
    fs.writeFileSync(f, Buffer.from(text, 'utf8'));
    console.log(`  √ ${rel}  GBK → UTF-8（${buf.length} → ${Buffer.byteLength(text)} 字节）`);
    changed += 1;
    continue;
  }

  if (mode === 'to-gbk') {
    if (enc === 'gbk' || enc === 'ascii') {
      console.log(`  · ${rel}  已是 ${enc}，跳过`);
      ok += 1;
      continue;
    }
    if (enc !== 'utf8') {
      console.log(`  × ${rel}  编码无法识别，跳过`);
      bad += 1;
      continue;
    }
    const text = buf.toString('utf8');
    const out = iconv.encode(text, 'gbk');
    fs.writeFileSync(f, out);
    console.log(`  √ ${rel}  UTF-8 → GBK（${buf.length} → ${out.length} 字节）`);
    changed += 1;
    continue;
  }

  console.error(`  未知模式: ${mode}（可用 to-utf8 / to-gbk / check）`);
  process.exit(1);
}

console.log('');
if (mode === 'check') {
  console.log(`  可运行(GBK/ASCII) ${ok} 个，需转换(UTF-8) ${bad} 个`);
  console.log(bad === 0 ? '  ✅ 全部是可直接双击运行的编码' : '  ❌ 有文件是 UTF-8，双击会报错');
  process.exit(bad === 0 ? 0 : 1);
}
console.log(`  转换 ${changed} 个，跳过 ${ok} 个，失败 ${bad} 个`);
process.exit(bad === 0 ? 0 : 1);

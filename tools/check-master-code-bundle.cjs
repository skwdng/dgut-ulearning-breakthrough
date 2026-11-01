/**
 * 检查 APK 的 Hermes bundle 里**有没有夹带万能码明文**。
 *
 * ══════════════ 为什么语义反过来了（2026-10）══════════════
 *
 * 这个工具原来做的是"搜你设的万能码在不在包里"——那时**自用版**会把码
 * 一起打进 APK。现在自用通道已删除（见 release.cjs / git 历史），
 * 所有对外发布包都用 `EXPO_PUBLIC_DISTRIBUTION=1` 构建，
 * 该分支会把 `CONVENIENCE_MASTER_CODE` 置成空串（见 src/domain/licenseCode.ts）。
 *
 * 所以对发布包来说，**正确结果永远是"搜不到明文"**：
 *   · 既然要发布给别人的 APK 不该带码，那检查的目标就是"包里没有码"；
 *   · 如果还在用旧语义"必须能搜到码"，它会把"剥离成功"当成失败 ——
 *     这正是公开仓库版直接 exit 2 的原因（没设环境变量就没法跑）。
 *
 * ══════════════ 两个模式 ══════════════
 *
 *   ① 给了 `EXPO_PUBLIC_MASTER_CODE` → 验证这串明文**不在**包里。
 *      用途：确认发布前确实做了剥离（忘了 `EXPO_PUBLIC_DISTRIBUTION=1`
 *      就会把本机自用码原样打进去，这里能当场抓到）。
 *      码内容**不打印**，只打印长度 —— 避免把秘密写进 CI 日志。
 *
 *   ② 没给 → 验证包里没有**内置的默认/遗留码**：
 *        · CHANGE_ME       —— 服务端默认占位码
 *        · CHANGEMEPLEASE  —— App 侧兜底占位符
 *        · jcnb            —— 早期版本真的用过的旧码
 *      另外，如果本机 `.env` / `.env.local` 里配了 `EXPO_PUBLIC_MASTER_CODE`，
 *      会拿它当候选一起查（同样只看"在不在"，不打印内容）。
 *      公开仓库版没这个文件 → 自然跳过，符合预期。
 *
 * 判定细节（两种 bundle 格式分开处理）：
 *   · 普通 JS bundle：万能码是**值**，而 RN 的警告文案里可能碰巧含同样的
 *     子串。所以只把"前后都不是字母"的出现算泄漏，嵌在单词里的只提示。
 *   · Hermes 字节码：它把所有字符串**背靠背**塞进 string storage（中间
 *     没有任何分隔符，实测 `...FromServerisMapIteratorisMasterisModern...`），
 *     所以"前后是不是字母"根本区分不出来 —— 这时只要命中就算泄漏
 *     （`strings` 一搜就能拿到码，本来就是泄漏）。宁可多报，不能漏报。
 *
 * 退出码：0 = 通过（干净）；1 = 找到明文；2 = 用法错误 / APK 读不了。
 *
 * 用法：
 *   node tools/check-master-code-bundle.cjs server/apk/lifekit-test.apk
 *   EXPO_PUBLIC_MASTER_CODE=你的码 node tools/check-master-code-bundle.cjs <apk>
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const BUNDLE_NAME = 'index.android.bundle';

/** 已知的默认 / 遗留万能码明文 —— 出现在包里就说明"包内置了码" */
const KNOWN_LEAKS = [
  { needle: 'jcnb', label: "旧码 'jcnb'（历史版本用过的明文）" },
  { needle: 'CHANGE_ME', label: '服务端默认占位码 CHANGE_ME' },
  { needle: 'CHANGEMEPLEASE', label: 'App 兜底占位码 CHANGEMEPLEASE' },
];

/**
 * 从 APK（zip）里取出 Hermes bundle 的文本。
 *
 * ⚠️ 不引依赖：只解析 central directory + local header 的固定字段。
 *    这个项目一直"零依赖"，引 unzip 库不值当。
 */
function readBundle(apk) {
  const buf = fs.readFileSync(apk);

  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 ZIP/APK（找不到中央目录结尾）');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  let entry = null;
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(off) !== CENTRAL_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;
    if (name.includes(BUNDLE_NAME)) entry = { method, compressedSize, localOff, name };
  }
  if (!entry) throw new Error(`APK 里没有 assets/${BUNDLE_NAME}（可能不是 RN 安装包）`);

  const localNameLen = buf.readUInt16LE(entry.localOff + 26);
  const localExtraLen = buf.readUInt16LE(entry.localOff + 28);
  const dataOff = entry.localOff + 30 + localNameLen + localExtraLen;
  const raw = buf.subarray(dataOff, dataOff + entry.compressedSize);

  let data;
  if (entry.method === 0) data = raw;
  else if (entry.method === 8) data = zlib.inflateRawSync(raw);
  else throw new Error(`bundle 用了不支持的压缩方式：${entry.method}`);

  // Hermes 字节码的魔数（文件头前 4 字节，按字节序是 c6 1f bc 03）
  const isHermes = data.length >= 4 && data[0] === 0xc6 && data[1] === 0x1f && data[2] === 0xbc && data[3] === 0x03;

  return {
    text: data.toString('latin1'),
    isHermes,
    apkBytes: buf.length,
    bundleBytes: data.length,
  };
}

/**
 * 不分大小写找所有出现位置。
 *
 * bundle 是 latin1 存的，`toLowerCase()` 对 ASCII/latin1 不会改变长度，
 * 所以偏移量可以直接拿来在原文里取上下文。
 */
function findHits(haystack, needle) {
  const lower = haystack.toLowerCase();
  const target = needle.toLowerCase();
  const hits = [];
  let at = -1;
  while ((at = lower.indexOf(target, at + 1)) !== -1) hits.push(at);
  return hits;
}

/** 前后都不是字母 → 它更像一个独立的值，而不是警告文案里的子串 */
function looksLikeValue(haystack, at, len) {
  const prev = haystack[at - 1] ?? '';
  const next = haystack[at + len] ?? '';
  return !/[A-Za-z]/.test(prev) && !/[A-Za-z]/.test(next);
}

/** 打印命中上下文；命中的明文用 * 遮住，别把码打到日志里 */
function maskedContext(haystack, at, len, pad = 36) {
  const before = haystack
    .slice(Math.max(0, at - pad), at)
    .replace(/[^\x20-\x7e]/g, '·');
  const after = haystack
    .slice(at + len, at + len + pad)
    .replace(/[^\x20-\x7e]/g, '·');
  return `...${before}[${'*'.repeat(len)}]${after}...`;
}

/**
 * 从本机 .env / .env.local 收集候选万能码。
 *
 * 只在模式 ② 用：公开仓库没这个文件就跳过；开发者本机配了的话，
 * "发布包里没有自己的码"正是最该断言的那条。
 * ⚠️ 只返回值和来源文件名，从来不打印值本身。
 */
function localEnvCodes() {
  const out = [];
  for (const file of ['.env', '.env.local']) {
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    } catch {
      continue; // 文件不存在很正常（.env.local 不入库）
    }
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?EXPO_PUBLIC_MASTER_CODE\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      // 去掉行尾注释与成对引号
      const value = m[1]
        .replace(/\s+#.*$/, '')
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2')
        .trim();
      if (value) out.push({ file, value });
    }
  }
  return out;
}

/** 跑一条检查；返回失败条数（0 或 1） */
function runCheck({ label, needle }) {
  const hits = findHits(bundle.text, needle);
  // Hermes 里所有字符串是背靠背存的，命中的位置无法判断"是不是一个完整值"，
  // 只能一律当泄漏（fail-safe）；普通 JS bundle 才用"前后是不是字母"排除文案巧合。
  const leaked = bundle.isHermes ? hits : hits.filter((at) => looksLikeValue(bundle.text, at, needle.length));
  const wordOnly = hits.length - leaked.length;

  if (leaked.length === 0) {
    console.log(`  ✓ ${label}：未出现${wordOnly ? `（另有 ${wordOnly} 处只是嵌在单词里，不算）` : ''}`);
    return 0;
  }
  console.log(`  × ${label}：找到 ${leaked.length} 处明文`);
  for (const at of leaked.slice(0, 5)) {
    console.log(`      ${maskedContext(bundle.text, at, needle.length)}`);
  }
  if (leaked.length > 5) console.log(`      …… 还有 ${leaked.length - 5} 处`);
  return 1;
}

// ---------------------------------------------------------------- 主流程

const apk = process.argv[2] ?? '';
if (!apk) {
  console.error('  × 用法：node tools/check-master-code-bundle.cjs <apk路径>');
  console.error('    可选环境变量：EXPO_PUBLIC_MASTER_CODE=你的码（指定后验证该明文不在包里）');
  process.exit(2);
}

let bundle;
try {
  bundle = readBundle(apk);
} catch (e) {
  console.error(`  × 读 APK 失败：${e.message}`);
  process.exit(2);
}

console.log('');
console.log(`  APK：${apk}`);
console.log(
  `  大小：${(bundle.apkBytes / 1024 / 1024).toFixed(1)} MB，` +
    `bundle ${(bundle.bundleBytes / 1024).toFixed(0)} KB（${bundle.isHermes ? 'Hermes 字节码' : '普通 JS'}）`,
);
console.log('');

/** @type {{label: string, needle: string}[]} */
const checks = [];
const envCode = (process.env.EXPO_PUBLIC_MASTER_CODE ?? '').trim();
/** 打印出来的模式名，进 SUMMARY */
let mode = '';

if (envCode) {
  mode = 'env-code';
  console.log('  模式 ①：指定了内置码 → 验证这串明文**不在**包里');
  console.log(`  （码内容不打印，长度 ${envCode.length}）`);
  checks.push({ label: `指定码（${envCode.length} 位）未进包`, needle: envCode });
} else {
  mode = 'no-code';
  console.log('  模式 ②：未指定内置码 → 验证包里没有内置的默认/遗留码');
  for (const leak of KNOWN_LEAKS) checks.push({ label: leak.label, needle: leak.needle });

  const local = localEnvCodes();
  if (local.length === 0) {
    console.log('  · 本机 .env / .env.local 没有 EXPO_PUBLIC_MASTER_CODE（公开仓库版正常）');
  } else {
    for (const { file, value } of local) {
      console.log(`  · 本机 ${file} 配了候选码（${value.length} 位）→ 一并验证它没进包`);
      checks.push({ label: `本机 ${file} 的码（${value.length} 位）未进包`, needle: value });
    }
  }
}

console.log('');
let failures = 0;
for (const c of checks) failures += runCheck(c);

console.log('');
if (failures === 0) {
  console.log(
    envCode
      ? '  ✅ 通过：包里没有指定码的明文（发布前剥离生效）'
      : '  ✅ 通过：公开仓库版无内置码，符合预期（EXPO_PUBLIC_DISTRIBUTION=1 已把它置空）',
  );
  console.log(
    `  SUMMARY: mode=${mode} checks=${checks.length} failures=0 result=PASS`,
  );
  process.exit(0);
}

console.log('  ❌ 不通过：这个包带着万能码明文，不能对外发布');
console.log('     处理：确认构建时带了 EXPO_PUBLIC_DISTRIBUTION=1；');
console.log('     自用码写在 .env.local（不入库），不要打进发布包。');
console.log(`  SUMMARY: mode=${mode} checks=${checks.length} failures=${failures} result=FAIL`);
process.exit(1);

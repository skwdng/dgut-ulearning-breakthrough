/**
 * JSX 合法性静态检查 —— 挡住"在 <Txt> 里写了 HTML 标签"这类错误。
 *
 * ⚠️ 真实踩过的坑：
 *   在 <Txt> 里写了 `<br />`，React Native 把 `br` 当成组件名去查，
 *   找不到就抛：
 *     Invariant Violation: View config getter callback for component `br`
 *     must be a function (received `undefined`).
 *     Make sure to start component names with a capital letter.
 *   → **整个页面白屏**（红屏报错页），而且错误信息不指向源码行。
 *
 * RN 里换行要用 `{'\n'}`，不能用 <br>。
 *
 * ══════════════ ★★★ 2026-10 重写：必须区分"代码"与"字符串" ══════════════
 *
 * ⚠️ 旧版是**逐行正则**，只看行首是不是注释。它漏掉了一大类误报：
 *    **模板字符串里的 HTML**。
 *
 *    实例：`src/components/MapPicker.tsx` 把一整页地图 HTML
 *    内联在一个模板字符串里（给 WebView 用）：
 *
 *        return `<!DOCTYPE html>
 *          <div id="map"></div>
 *          ...`;
 *
 *    里面的 `<div>` 是**字符串内容**，跟 RN 的 JSX 一点关系都没有。
 *    但旧版看到 `          <div id="map"></div>` 就报错 —— 4 处误报。
 *
 *    后果比"多报几条"更严重：**这个检查从此永久失败**，
 *    而"一直失败的检查等于没有检查" —— 真的有人写错 `<br>` 时
 *    没人会去看那堆已知噪音。
 *
 * ✅ 现在：先用**逐字符状态机**把源文件切成"代码片段"和"非代码片段"
 *    （字符串 `'…'` / `"…"` / 模板串 `` `…` ``、行注释、块注释），
 *    只在**代码片段**里找 HTML 标签。
 *
 * ⚠️ 为什么不用简单正则替换：
 *    模板串可以嵌套 `${…}`，里面还可能有字符串与注释；
 *    而且 JSX 里本身就有大量 `'` `"`。切不干净就会漏报或误报。
 *    状态机是这里唯一可靠的做法（这个坑在另一个项目里也踩过）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', 'src');
const SKIP_DIRS = new Set(['node_modules', 'android', '.git']);

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * 把源码切成"代码"与"非代码"两部分。
 *
 * 返回一个数组，元素为 { code: boolean, text: string, startLine: number }。
 * 调用方只在 `code: true` 的片段里找 HTML 标签。
 *
 * ⚠️ 关键点：
 *   · 模板串的 `${…}` **里面是代码**（可能含 JSX），所以遇到 `${` 要
 *     退出"字符串模式"回到代码模式，并维护一个花括号深度，在对应的
 *     `}` 处重新进入字符串模式。
 *   · 行号要跟着走 —— 报错必须指向真实行，否则等于没报。
 */
function splitCodeAndStrings(src) {
  const parts = [];
  let i = 0;
  let line = 1;
  let buf = '';
  let bufIsCode = true;
  let bufStartLine = 1;

  /** 花括号深度栈：记录"这个 { 是从模板串的 ${ 进来的" */
  const tplStack = [];

  /** 结束当前缓冲区，推入结果 */
  const flush = () => {
    if (buf) parts.push({ code: bufIsCode, text: buf, startLine: bufStartLine });
    buf = '';
    bufStartLine = line;
  };
  const push = (ch) => {
    buf += ch;
    if (ch === '\n') line += 1;
  };

  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];

    if (bufIsCode) {
      // ── 代码模式：识别注释与字符串的开头 ──
      if (c === '/' && c2 === '/') {
        // 行注释 —— 一直吃到换行（换行本身留给代码，便于行号对齐）
        while (i < src.length && src[i] !== '\n') i += 1;
        continue;
      }
      if (c === '/' && c2 === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
          if (src[i] === '\n') line += 1;
          i += 1;
        }
        i += 2;
        continue;
      }
      if (c === "'" || c === '"') {
        // 普通字符串 —— 跳到收尾引号，标记为非代码
        flush();
        bufIsCode = false;
        bufStartLine = line;
        push(c);
        i += 1;
        while (i < src.length) {
          const ch = src[i];
          push(ch);
          i += 1;
          if (ch === '\\') {
            if (i < src.length) {
              push(src[i]);
              i += 1;
            }
            continue;
          }
          if (ch === c) break;
        }
        flush();
        bufIsCode = true;
        bufStartLine = line;
        continue;
      }
      if (c === '`') {
        // 模板字符串 —— 进入非代码模式，直到 ` 或 ${ 或 结束
        flush();
        bufIsCode = false;
        bufStartLine = line;
        push(c);
        i += 1;
        while (i < src.length) {
          const ch = src[i];
          if (ch === '\\') {
            push(ch);
            i += 1;
            if (i < src.length) {
              push(src[i]);
              i += 1;
            }
            continue;
          }
          if (ch === '`') {
            push(ch);
            i += 1;
            break;
          }
          if (ch === '$' && src[i + 1] === '{') {
            // ${ 之后是**代码**（可能含 JSX）→ 切回代码模式
            push('$');
            push('{');
            i += 2;
            flush();
            bufIsCode = true;
            bufStartLine = line;
            tplStack.push('${');
            break;
          }
          push(ch);
          i += 1;
        }
        continue;
      }
      // ── 普通代码字符 ──
      if (c === '}' && tplStack.length) {
        // 从 `${` 进来的花括号配对结束 → 回到模板串模式
        tplStack.pop();
        push(c);
        i += 1;
        flush();
        bufIsCode = false;
        bufStartLine = line;
        // 继续待在模板串里读到 ` 为止
        while (i < src.length) {
          const ch = src[i];
          if (ch === '\\') {
            push(ch);
            i += 1;
            if (i < src.length) {
              push(src[i]);
              i += 1;
            }
            continue;
          }
          if (ch === '`') {
            push(ch);
            i += 1;
            break;
          }
          if (ch === '$' && src[i + 1] === '{') {
            push('$');
            push('{');
            i += 2;
            flush();
            bufIsCode = true;
            bufStartLine = line;
            tplStack.push('${');
            break;
          }
          push(ch);
          i += 1;
        }
        continue;
      }
      push(c);
      i += 1;
      continue;
    }

    // 理论上不会走到这里（非代码模式都在上面的循环里消费完了）
    push(c);
    i += 1;
  }
  flush();
  return parts;
}

/** HTML 里常见、但 RN 里不存在的标签 */
const HTML_TAGS = [
  'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'p', 'div', 'span',
  'ul', 'ol', 'li', 'table', 'tr', 'td', 'th', 'a', 'img', 'h1', 'h2', 'h3',
];

const files = walk(ROOT, []).filter((f) => /\.(tsx?|jsx?)$/.test(f));
const problems = [];

for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  for (const part of splitCodeAndStrings(text)) {
    /** ⚠️ 只在**代码片段**里找 —— 字符串里的 HTML 是数据，不是 JSX */
    if (!part.code) continue;
    const partLines = part.text.split('\n');
    partLines.forEach((line, i) => {
      for (const tag of HTML_TAGS) {
        const re = new RegExp(`</?${tag}(\\s[^>]*)?/?>`, 'i');
        if (re.test(line)) {
          problems.push({
            file: f.replace(path.resolve(__dirname, '..') + path.sep, ''),
            line: part.startLine + i,
            tag,
            text: line.trim().slice(0, 100),
          });
        }
      }
    });
  }
}

console.log(`  扫描 ${files.length} 个 tsx/ts 文件`);
console.log('  （只检查**代码**里的 HTML 标签；模板字符串/字符串/注释里的不算）');
console.log('');

if (problems.length === 0) {
  console.log('  ✅ 没有在 JSX 里误用 HTML 标签');
  console.log("     （换行请用 {'\\n'}，不要用 <br>）");
  process.exit(0);
}

console.log(`  ❌ 发现 ${problems.length} 处 HTML 标签 —— React Native 里不能用：`);
for (const p of problems) {
  console.log(`    ${p.file}:${p.line}  <${p.tag}>`);
  console.log(`        ${p.text}`);
}
console.log('');
console.log("  改法：把 <br> / <br /> 换成 {'\\n'}；其他标签用 <Txt> 嵌套或独立组件。");
process.exit(1);

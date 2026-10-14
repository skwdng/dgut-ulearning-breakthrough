/**
 * 修复 WebCookieModule.kt 里 extractCasMessage 的正则转义。
 *
 * ══════════ 踩过的坑 ══════════
 * 第一版补丁用普通字符串写字面量，结果**双层转义全被吃掉**：
 *     JS 模板里写 "\\s"  → 写入文件变成 "\s"（Kotlin 里非法转义 → 编译报错）
 *     JS 模板里写 \\"     → 写入文件变成 "（字符串提前结束 → 编译报错）
 * 编译错误：
 *     WebCookieModule.kt:474:29 Expecting ','
 *
 * 正确做法：用 Kotlin 的**原始字符串** """..."""。
 *   原始字符串里 \ 不是转义符，所以 `\s`、`\S`、`\b` 都能原样写；
 *   引号用单引号即可，不用转义。
 *
 * 用法: node tools/fix-cas-regex.cjs
 */
const fs = require('fs');
const path = require('path');

const KT = path.resolve(__dirname, '..', 'android-native', 'WebCookieModule.kt');
let src = fs.readFileSync(KT, 'utf8');

// 定位 extractCasMessage 函数体（从签名到 cleanMessage 定义之前）
const startMarker = '    private fun extractCasMessage(html: String): String? {';
const endMarker = '    /** 去掉标签、压缩空白；太短或太长的都当无效 */';

const start = src.indexOf(startMarker);
const end = src.indexOf(endMarker);
if (start < 0 || end < 0 || end < start) {
  console.error('  × 定位不到 extractCasMessage 函数体，放弃');
  process.exit(1);
}

/**
 * 用**原始字符串**重写这个函数。
 * ⚠️ 注意 JS 里也要正确转义：这里用 String.raw 模板，
 *    保证写进 .kt 的就是原样的反斜杠。
 */
const NEW_FN = String.raw`    private fun extractCasMessage(html: String): String? {
        if (html.isEmpty()) return null

        val sq = "'"

        // 该主题（dgutCusTheme23）的提示容器，按可靠性排序
        val idOrClass = listOf(
            "showErrorTipSpan", "showErrorTip", "errorMsg", "formErrorTip",
            "showMsg", "msg", "message", "error", "tip",
        )

        // ① 按 id="xxx" 取容器内文字
        //    用原始字符串，避免 \s / \S 在普通字符串里被当非法转义
        for (key in idOrClass) {
            val re = Regex(
                """<[^>]*id=["']?""" + Regex.escape(key) + """["']?[^>]*>([\s\S]{0,300}?)</""",
                RegexOption.IGNORE_CASE,
            )
            val text = cleanMessage(re.find(html)?.groupValues?.getOrNull(1))
            if (text != null) return text
        }

        // ② 按 class 里含 error / alert / tip / msg 的容器取
        val reCls = Regex(
            """<[^>]*class=["'][^"']*\b(?:error|alert|tip|msg)[^"']*["'][^>]*>([\s\S]{0,300}?)</""",
            RegexOption.IGNORE_CASE,
        )
        for (m in reCls.findAll(html)) {
            val text = cleanMessage(m.groupValues.getOrNull(1))
            if (text != null) return text
        }

        // ③ 兜底：整页搜一句常见的失败话术（有些主题把提示写成 JS 变量）
        for (kw in listOf("用户名或密码错误", "密码错误", "账号被锁定", "验证码错误", "用户不存在")) {
            if (html.contains(kw)) return kw
        }

        // 未使用的占位，避免 sq 未使用告警
        if (sq.isEmpty()) return null
        return null
    }

`;

src = src.slice(0, start) + NEW_FN + src.slice(end);

// cleanMessage 里的正则同样要用原始字符串
const cleanStart = src.indexOf('    private fun cleanMessage(raw: String?): String? {');
if (cleanStart < 0) {
  console.error('  × 定位不到 cleanMessage，放弃');
  process.exit(1);
}
const cleanEndMarker = '\n    }\n';
const cleanEnd = src.indexOf(cleanEndMarker, cleanStart);
if (cleanEnd < 0) {
  console.error('  × 定位不到 cleanMessage 结尾，放弃');
  process.exit(1);
}

const NEW_CLEAN = String.raw`    private fun cleanMessage(raw: String?): String? {
        if (raw.isNullOrBlank()) return null
        val text = raw
            .replace(Regex("""<[^>]*>"""), " ")
            .replace(Regex("""\s+"""), " ")
            .trim()
        // 太短没信息量；太长多半是把整段页面抓进来了
        if (text.length < 2 || text.length > 120) return null
        // 纯符号/纯数字也丢掉
        if (!text.any { it.isLetter() }) return null
        return text
    }
`;

src = src.slice(0, cleanStart) + NEW_CLEAN + src.slice(cleanEnd + cleanEndMarker.length);

fs.writeFileSync(KT, src, 'utf8');

// ── 自检：不允许出现非法的 Kotlin 转义 ──
// ⚠️ 必须**跳过原始字符串**（"""…"""）—— 那里面的 \s \S \b 都是字面量，合法。
//    第一版检查器没跳过，报了 5 处假阳性。
const lines = src.split('\n');
const bad = [];
lines.forEach((l, i) => {
  const rawOpen = l.indexOf('"""');
  const segments = l.match(/"(?:[^"\\]|\\.)*"/g) || [];
  let searchFrom = 0;
  for (const seg of segments) {
    const at = l.indexOf(seg, searchFrom);
    searchFrom = at + seg.length;
    // 落在原始字符串区间内的片段不算
    if (rawOpen >= 0 && at > rawOpen) continue;
    // ⚠️ 只报**单个**反斜杠后面跟 s/S/b/d/w —— 那才是非法转义。
    //    `\\s` 是合法的（字面反斜杠 + s），不能报（第一版报了这个假阳性）。
    if (/(^|[^\\])\\[sSbdw]/.test(seg)) bad.push({ line: i + 1, seg: seg.slice(0, 70) });
  }
});

console.log(`  文件行数 ${lines.length}`);
console.log('');
if (bad.length) {
  console.log(`  ❌ 仍有 ${bad.length} 处非法转义：`);
  for (const b of bad) console.log(`    ${b.line}: ${b.seg}`);
  process.exit(1);
}
console.log('  ✅ 没有非法转义（正则已全部改用原始字符串）');

// 花括号平衡
let d = 0;
for (const c of src) {
  if (c === '{') d += 1;
  else if (c === '}') d -= 1;
}
console.log(`  ${d === 0 ? '✅' : '❌'} 花括号平衡（差 ${d}）`);
process.exit(d === 0 ? 0 : 1);

/**
 * 给原生登录模块（WebCookieModule.kt）补上「把 CAS 的报错原因带回 App」的能力。
 *
 * ══════════ 为什么需要 ══════════
 * 用户遇到：POST 登录 → **401**，响应体 19392 字节（≈登录页大小）。
 * 这是 CAS 认证失败时把登录页 + 错误提示一起返回的典型样子。
 * 但当时的诊断只打印了状态码和字节数，**没把那段错误文字带出来**，
 * 于是只能猜是"密码错 / 账号锁 / 参数漏"。
 *
 * 本脚本做两件事：
 *   ① 往 WebCookieModule.kt 里插入 `extractCasMessage(...)`
 *   ② 在 doLogin 的每一跳后追加一行包含错误信息的诊断
 *      （只在页面里确实有错误提示时才追加，避免刷屏）
 *
 * 用法: node tools/patch-cas-error-diag.cjs [--check]
 */
const fs = require('fs');
const path = require('path');

const KT = path.resolve(__dirname, '..', 'android-native', 'WebCookieModule.kt');
const CHECK_ONLY = process.argv.includes('--check');

let src = fs.readFileSync(KT, 'utf8');

let pass = 0;
let fail = 0;
const t = (n, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  √ ${n}`);
  } else {
    fail += 1;
    console.log(`  × ${n}${extra ? '  → ' + extra : ''}`);
  }
};

console.log('  检查现有实现');
t('有 extractInputValue', src.includes('private fun extractInputValue'));
t('有 doLogin', src.includes('private fun doLogin'));
const alreadyHasExtract = src.includes('private fun extractCasMessage');
console.log(`  已补丁: ${alreadyHasExtract ? '是' : '否'}`);
console.log('');

if (CHECK_ONLY) {
  t('已包含 extractCasMessage（补丁已应用）', alreadyHasExtract);
  console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

if (alreadyHasExtract) {
  console.log('  补丁已应用，无需重复。');
  process.exit(0);
}

// ── ① 插入 extractCasMessage ──
const ANCHOR_FN = `    private fun failResult(`;
if (!src.includes(ANCHOR_FN)) {
  console.error('  × 找不到插入锚点 failResult，放弃');
  process.exit(1);
}

const NEW_FN = `    /**
     * 从 CAS 返回的 HTML 里**抽出错误提示文字**。
     *
     * ══════════ 为什么必须有这个 ══════════
     * 认证失败时 CAS **不会**返回一个简洁的 JSON 错误，
     * 而是把整个登录页（约 19KB）+ 一段红色提示一起返回，HTTP 状态可能是 401。
     * 如果只打状态码，就只能猜"密码错还是参数漏"。
     *
     * 该主题（dgutCusTheme23）的提示通常长这样：
     *   <span id="showErrorTipSpan">用户名或密码错误</span>
     *   <div id="showErrorTip">...</div>
     *   <p class="error">...</p>
     * 这里把常见几处都试一遍，取第一段有内容的。
     */
    private fun extractCasMessage(html: String): String? {
        if (html.isEmpty()) return null

        // 常见的"错误容器"id / class
        val idOrClass = listOf(
            "showErrorTipSpan", "showErrorTip", "errorMsg", "formErrorTip",
            "msg", "showMsg", "message", "error", "tip",
        )

        // 先按 id="xxx" …>文字</ 取
        for (key in idOrClass) {
            val re = Regex(
                "<[^>]*id=[\"']" + Regex.escape(key) + "[\"'][^>]*>([\\s\\S]{0,300}?)</",
                RegexOption.IGNORE_CASE,
            )
            val v = re.find(html)?.groupValues?.getOrNull(1)
            val text = cleanMessage(v)
            if (text != null) return text
        }

        // 再按 class="...error..." …>文字</ 取
        val reCls = Regex(
            "<[^>]*class=[\"'][^\"']*\\b(?:error|alert|tip|msg)[^\"']*[\"'][^>]*>([\\s\\S]{0,300}?)</",
            RegexOption.IGNORE_CASE,
        )
        for (m in reCls.findAll(html)) {
            val text = cleanMessage(m.groupValues.getOrNull(1))
            if (text != null) return text
        }

        return null
    }

    /** 去掉标签、压缩空白；太短或太长的都当无效 */
    private fun cleanMessage(raw: String?): String? {
        if (raw.isNullOrBlank()) return null
        val text = raw
            .replace(Regex("<[^>]*>"), " ")
            .replace(Regex("\\\\s+"), " ")
            .trim()
        // 太短没信息量；太长多半是把整段页面抓进来了
        if (text.length < 2 || text.length > 120) return null
        // 纯符号/纯数字也丢掉
        if (!text.any { it.isLetter() }) return null
        return text
    }

`;

src = src.replace(ANCHOR_FN, NEW_FN + ANCHOR_FN);
console.log('  √ 已插入 extractCasMessage / cleanMessage');

// ── ② 在每一跳后追加错误信息诊断 ──
const HOP_ANCHOR = `            if (r.status in 300..399 && !r.location.isNullOrBlank()) {`;
if (!src.includes(HOP_ANCHOR)) {
  console.error('  × 找不到跳转判断锚点，放弃第二处补丁');
  process.exit(1);
}

const HOP_PATCH = `            // ★ 认证失败时把 CAS 的具体说法带出来（否则只有一个 401，没法定位）
            if (r.status !in 200..399 || (r.status in 200..299 && r.body.contains("ErrorTip"))) {
                val why = extractCasMessage(r.body)
                if (!why.isNullOrEmpty()) step("   ⚠️ CAS 提示：$why")
            }

            if (r.status in 300..399 && !r.location.isNullOrBlank()) {`;

src = src.replace(HOP_ANCHOR, HOP_PATCH);
console.log('  √ 已在每跳后追加 CAS 提示诊断');

// ── ③ extractInputValue 支持没有 name、只有 id 的隐藏字段 ──
//    实测该页面的 pwdEncryptSalt 是 <input type="hidden" id="pwdEncryptSalt" value="...">
//    （没有 name），现有正则按 id 匹配，已经能用 —— 这里只加一条断言说明。
t('extractInputValue 按 id 匹配（适配无 name 的 salt 字段）', src.includes('id=[\\"\']" + Regex.escape(id)'));

fs.writeFileSync(KT, src, 'utf8');
console.log('');
console.log('  ✅ 补丁已写入 WebCookieModule.kt');
console.log(`  SUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);

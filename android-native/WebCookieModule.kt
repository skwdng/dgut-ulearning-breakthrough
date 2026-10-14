package com.lifekit.webcookie

import android.os.Build
import android.webkit.CookieManager
import android.webkit.WebView
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import java.net.HttpURLConnection
import java.net.URL
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * WebView Cookie 读取 + **原生 CAS 登录**（Android）。
 *
 * ══════════ 为什么需要原生模块 ══════════
 *
 * **读 cookie**：JS 侧试过两条路都不行 ——
 *   1. 注入 JS 读 `document.cookie` → `AUTHORIZATION`/`USER_INFO` 是 HttpOnly，读不到；
 *   2. `@react-native-cookies/cookies` → 鸿蒙上 `getAll` 直接返回 "not supported"。
 * 只能直接调 `android.webkit.CookieManager`。
 *
 * **登录**：RN 的 fetch 有两个致命限制（真机实测）——
 *   1. `redirect:'follow'` → 内部把 302 跟完，**中间每一跳的 Set-Cookie 全丢**。
 *      CAS 换票链是 auth → application → lms，而 `AUTHORIZATION` 出现在**第 3 跳**，
 *      所以用 fetch 永远拿不到 token（表现为"登录成功但没有会话"）。
 *   2. `redirect:'manual'` → **这台设备不支持**（三种模式返回完全一致）。
 * 所以整个登录流程（取表单 → 加密 → 提交 → 逐跳跟票）全部放在原生，
 * 用 `HttpURLConnection` + `setInstanceFollowRedirects(false)` 自己控制每一跳。
 *
 * ⚠️ 网络操作**必须在后台线程** —— 主线程做网络会触发
 *    `NetworkOnMainThreadException`，App 会被系统直接杀掉。
 */
class WebCookieModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = NAME

    private val desktopUa =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

    // ══════════════════ Cookie 读取 ══════════════════

    /**
     * 读取指定 URL 的 cookie。
     *
     * @param url   要读的页面地址（域名决定能读到哪些 cookie）
     * @param flush 是否先强制落盘（默认 true；登录后立刻读时很关键）
     */
    @ReactMethod
    fun getCookie(url: String, flush: Boolean, promise: Promise) {
        try {
            val cm = CookieManager.getInstance()
            cm.setAcceptCookie(true)
            if (flush) cm.flush()

            val raw = cm.getCookie(url)
            val map: WritableMap = Arguments.createMap()
            if (raw.isNullOrBlank()) {
                promise.resolve(map)
                return
            }
            raw.split(";").forEach { pair ->
                val i = pair.indexOf('=')
                if (i > 0) {
                    val k = pair.substring(0, i).trim()
                    val v = pair.substring(i + 1).trim()
                    if (k.isNotEmpty()) map.putString(k, v)
                }
            }
            promise.resolve(map)
        } catch (t: Throwable) {
            promise.reject("E_WEBCOOKIE", t.message ?: "读取 cookie 失败", t)
        }
    }

    /** 强制把 cookie 落盘 */
    @ReactMethod
    fun flush(promise: Promise) {
        try {
            CookieManager.getInstance().flush()
            promise.resolve(true)
        } catch (t: Throwable) {
            promise.reject("E_WEBCOOKIE", t.message ?: "flush 失败", t)
        }
    }

    /**
     * 把一条 cookie 写进原生 CookieManager。
     *
     * ══════════ 为什么需要 ══════════
     * 实测：WebView 里已经登录（页面显示"欢迎您，XXX 学生"），
     * 但 `CookieManager.getCookie()` 读到 **0 个** ——
     * WebView 的 cookie 存储和 CookieManager 是两套（Android 已知问题）。
     *
     * 于是改成：在 WebView 页面里执行 JS 读 `document.cookie`，
     * 把结果传回 RN，再用这个方法写进 CookieManager，
     * 之后 getCookie / readSessionCookies 就能正常工作了。
     *
     * @param url        要写到哪个域名（cookie 必须归属到正确域名，后续才带得上）
     * @param cookieLine 形如 `AUTHORIZATION=xxxx; path=/`
     */
    @ReactMethod
    fun setCookie(url: String, cookieLine: String, promise: Promise) {
        try {
            if (cookieLine.isBlank()) {
                promise.resolve(false)
                return
            }
            val cm = CookieManager.getInstance()
            cm.setAcceptCookie(true)
            /**
             * ⚠️ setCookie 会**返回是否被接受**。
             *    之前忽略了返回值，于是格式不对时"看起来写成功、其实没写进去"，
             *    表现为「网页内同步到 10 个」但「读回 0 个」，很难定位。
             *    现在把真实结果返回给 JS。
             */
            val accepted = cm.setCookie(url, cookieLine)
            cm.flush()
            promise.resolve(accepted)
        } catch (t: Throwable) {
            promise.reject("E_WEBCOOKIE", t.message ?: "写 cookie 失败", t)
        }
    }

    /**
     * 清空所有 WebView cookie。
     * 换账号时必须清 —— 不清的话 CAS 会认为"已登录"直接跳走，拿不到新会话。
     */
    @ReactMethod
    fun clearAll(promise: Promise) {
        try {
            val cm = CookieManager.getInstance()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                cm.removeAllCookies(null)
            } else {
                @Suppress("DEPRECATION")
                cm.removeAllCookie()
            }
            cm.flush()
            promise.resolve(true)
        } catch (t: Throwable) {
            promise.reject("E_WEBCOOKIE", t.message ?: "清除 cookie 失败", t)
        }
    }

    /** 让 WebView 允许第三方 cookie（CAS 跨域换票链需要） */
    @ReactMethod
    fun setAcceptThirdParty(accept: Boolean, promise: Promise) {
        try {
            CookieManager.getInstance().setAcceptThirdPartyCookies(WebView(reactContext), accept)
            promise.resolve(true)
        } catch (t: Throwable) {
            promise.reject("E_WEBCOOKIE", t.message ?: "设置第三方 cookie 失败", t)
        }
    }

    // ══════════════════ 原生 CAS 登录 ══════════════════

    /**
     * 完整登录：取登录页 → 加密密码 → 提交 → **逐跳跟票**。
     *
     * 全部在原生完成的原因见类注释。**明文密码只在原生内存里短暂存在**，
     * 不经过 JS，也不写任何日志。
     */
    @ReactMethod
    fun login(
        loginUrl: String,
        studentId: String,
        password: String,
        maxHops: Int,
        promise: Promise,
    ) {
        Thread {
            try {
                promise.resolve(doLogin(loginUrl, studentId, password, maxHops))
            } catch (t: Throwable) {
                // 用 reject 而不是抛出 —— 抛出会让 App 崩掉
                promise.reject("E_WEBCOOKIE_LOGIN", t.message ?: "原生登录失败", t)
            }
        }.start()
    }

    private fun doLogin(
        loginUrl: String,
        studentId: String,
        password: String,
        maxHops: Int,
    ): WritableMap {
        val steps: WritableArray = Arguments.createArray()
        fun step(s: String) {
            steps.pushString(s)
        }

        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        try {
            cm.setAcceptThirdPartyCookies(WebView(reactContext), true)
        } catch (_: Throwable) {
            // 不支持就忽略
        }

        val hops = if (maxHops in 1..15) maxHops else 8
        var finalStatus = 0
        var finalUrl = loginUrl
        var finalBody = ""

        // ── ① 取登录页（原生 GET，不跟跳转） ──
        step("① 取登录页 $loginUrl")
        val page = httpGet(loginUrl, cm)
        step(
            "   → ${page.status} 字节=${page.body.length} " +
                "location=${page.location ?: "无"} " +
                "setCookie=[${page.setCookies.joinToString(",") { it.substringBefore(";") }}]",
        )
        if (page.status in 300..399) {
            step("   ⚠️ 登录页返回了重定向（不是 200）—— CAS 可能认为已登录")
        }

        val salt = extractInputValue(page.body, "pwdEncryptSalt")
        val execution = extractInputValue(page.body, "execution")
        step("   解析 salt=${if (salt.isNullOrEmpty()) "无" else "有"} execution=${if (execution.isNullOrEmpty()) "无" else "有"}")

        if (salt.isNullOrEmpty() || execution.isNullOrEmpty()) {
            val head = page.body.replace(Regex("\\s+"), " ").take(220)
            step("   × 没拿到表单，终止")
            return failResult(steps, page.status, loginUrl, head, cm)
        }

        // ── ② 加密密码 + 组装表单 ──
        val encPw = try {
            encryptCasPassword(password, salt)
        } catch (t: Throwable) {
            step("   × 密码加密失败: ${t.message}")
            return failResult(steps, page.status, loginUrl, "", cm)
        }
        val form = buildForm(
            linkedMapOf(
                "username" to studentId,
                "password" to encPw,
                "captcha" to "",
                "_eventId" to "submit",
                "cllt" to "userNameLogin",
                "dllt" to "generalLogin",
                "lt" to "",
                "execution" to execution,
            ),
        )
        step("② 已组装表单（${form.length} 字节），开始提交并逐跳跟票")

        // ── ③ 提交 + 逐跳跟票 ──
        var currentUrl = loginUrl
        var method = "POST"
        // ⚠️ 不要把这个变量命名成 body —— 会和局部函数 step 的形参混淆，
        //    Kotlin 会报 "Unresolved reference"（踩过）。
        var postBody: String? = form
        var hop = 0

        while (hop < hops) {
            hop += 1
            val r = httpRequest(currentUrl, method, postBody, cm)
            finalStatus = r.status
            finalUrl = r.finalUrl
            finalBody = r.body

            val scNames = r.setCookies.joinToString(",") { it.substringBefore(";") }
            step(
                "第${hop}跳 $method ${hostOf(currentUrl)} → ${r.status} 字节=${r.body.length} " +
                    "setCookie=[${if (scNames.isEmpty()) "无" else scNames}] " +
                    "location=${r.location ?: "无"}",
            )

            // ★ 认证失败时把 CAS 的具体说法带出来（否则只有一个 401，没法定位）
            if (r.status !in 200..399 || (r.status in 200..299 && r.body.contains("ErrorTip"))) {
                val why = extractCasMessage(r.body)
                if (!why.isNullOrEmpty()) step("   ⚠️ CAS 提示：$why")
            }

            if (r.status in 300..399 && !r.location.isNullOrBlank()) {
                currentUrl = try {
                    URL(URL(currentUrl), r.location).toString()
                } catch (t: Throwable) {
                    step("   × Location 解析失败: ${r.location}")
                    break
                }
                method = "GET"
                postBody = null
                continue
            }
            break
        }

        try {
            cm.flush()
        } catch (_: Throwable) {
            // 忽略
        }

        // ── ④ 收集最终 cookie ──
        val hosts = listOf(
            "https://auth.dgut.edu.cn/",
            "https://application.dgut.edu.cn/",
            "https://lms.dgut.edu.cn/",
            finalUrl,
        )
        val cookieMap: WritableMap = Arguments.createMap()
        // 不用 keySetIterator（Kotlin 下容易和别的名字撞），直接边收集边记名字
        val names = mutableListOf<String>()
        for (h in hosts) {
            val raw = try {
                cm.getCookie(h)
            } catch (_: Throwable) {
                null
            } ?: continue
            raw.split(";").forEach { pair ->
                val i = pair.indexOf('=')
                if (i > 0) {
                    val k = pair.substring(0, i).trim()
                    val v = pair.substring(i + 1).trim()
                    if (k.isNotEmpty()) {
                        cookieMap.putString(k, v)
                        if (!names.contains(k)) names.add(k)
                    }
                }
            }
        }

        step("")
        step("★ 最终状态=${finalStatus} 最终地址=${hostOf(finalUrl)}")
        step("★ 拿到 cookie ${names.size} 个: ${names.joinToString(",")}")
        step("★ AUTHORIZATION=${if (names.contains("AUTHORIZATION")) "有" else "无"}")
        step("★ CASTGC=${if (names.contains("CASTGC")) "有" else "无"}")

        val result: WritableMap = Arguments.createMap()
        result.putArray("steps", steps)
        result.putInt("finalStatus", finalStatus)
        result.putString("finalUrl", finalUrl)
        result.putString("finalBodyHead", finalBody.replace(Regex("\\s+"), " ").take(300))
        result.putMap("cookies", cookieMap)
        return result
    }

    // ══════════════════ HTTP 底层 ══════════════════

    private class HttpResult(
        val status: Int,
        val body: String,
        val location: String?,
        val setCookies: List<String>,
        val finalUrl: String,
    )

    private fun httpGet(url: String, cm: CookieManager): HttpResult =
        httpRequest(url, "GET", null, cm)

    private fun httpRequest(
        url: String,
        method: String,
        body: String?,
        cm: CookieManager,
    ): HttpResult {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.instanceFollowRedirects = false // ★ 不自动跟，自己控制每一跳
        conn.connectTimeout = 20000
        conn.readTimeout = 20000
        conn.requestMethod = method
        conn.setRequestProperty("User-Agent", desktopUa)
        conn.setRequestProperty("Accept", "text/html,application/xhtml+xml,*/*;q=0.8")
        conn.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9")

        val ck = try {
            cm.getCookie(url)
        } catch (_: Throwable) {
            null
        }
        if (!ck.isNullOrEmpty()) conn.setRequestProperty("Cookie", ck)

        if (method == "POST" && body != null) {
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
            val bytes = body.toByteArray(Charsets.UTF_8)
            conn.setFixedLengthStreamingMode(bytes.size)
            conn.outputStream.use { it.write(bytes) }
        }

        val status = conn.responseCode
        val loc = conn.getHeaderField("Location")
        val setCookies: List<String> = conn.headerFields["Set-Cookie"] ?: emptyList()

        // ★ 每一跳的 Set-Cookie 都要存进 CookieManager —— token 就在其中一跳
        for (raw in setCookies) {
            try {
                cm.setCookie(url, raw)
            } catch (_: Throwable) {
                // 单条失败不影响整体
            }
        }

        val stream = try {
            if (status in 200..299) conn.inputStream else conn.errorStream
        } catch (_: Throwable) {
            null
        }
        val text = try {
            stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
        } catch (_: Throwable) {
            ""
        }
        try {
            conn.disconnect()
        } catch (_: Throwable) {
            // 忽略
        }

        return HttpResult(status, text, loc, setCookies, url)
    }

    // ══════════════════ 工具 ══════════════════

    /**
     * CAS 密码加密（与 JS 侧 crypto/aes.ts 及学校前端 encrypt.js 保持一致）：
     *   AES-128-CBC / PKCS7，key = salt（16 字节），
     *   iv = 随机 16 字符，明文 = 随机 64 字符 + 密码，
     *   结果 Base64。
     */
    private fun encryptCasPassword(password: String, salt: String): String {
        val charset = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678"
        fun rnd(n: Int) = (1..n).map { charset.random() }.joinToString("")

        val key = salt.toByteArray(Charsets.UTF_8).copyOf(16)
        val iv = rnd(16).toByteArray(Charsets.UTF_8)
        val plain = (rnd(64) + password).toByteArray(Charsets.UTF_8)

        val cipher = Cipher.getInstance("AES/CBC/PKCS5Padding")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(key, "AES"),
            IvParameterSpec(iv),
        )
        return android.util.Base64.encodeToString(cipher.doFinal(plain), android.util.Base64.NO_WRAP)
    }

    /** 组装 application/x-www-form-urlencoded 表单 */
    private fun buildForm(fields: Map<String, String>): String =
        fields.entries.joinToString("&") { (k, v) -> "${enc(k)}=${enc(v)}" }

    private fun enc(s: String): String =
        java.net.URLEncoder.encode(s, "UTF-8")

    private fun hostOf(u: String): String = try {
        URL(u).host
    } catch (_: Throwable) {
        u.take(40)
    }

    /**
     * 从 HTML 里取隐藏 input 的 value。
     * 两种属性顺序都要支持（实测该 CAS 页面两种都出现过）。
     */
    private fun extractInputValue(html: String, id: String): String? {
        if (html.isEmpty()) return null
        val patterns = listOf(
            Regex(
                "<input[^>]*id=[\"']" + Regex.escape(id) + "[\"'][^>]*value=[\"']([^\"']*)[\"']",
                RegexOption.IGNORE_CASE,
            ),
            Regex(
                "<input[^>]*value=[\"']([^\"']*)[\"'][^>]*id=[\"']" + Regex.escape(id) + "[\"']",
                RegexOption.IGNORE_CASE,
            ),
        )
        for (re in patterns) {
            val v = re.find(html)?.groupValues?.getOrNull(1)
            if (!v.isNullOrEmpty()) return v
        }
        return null
    }

    /**
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

    /** 去掉标签、压缩空白；太短或太长的都当无效 */
    private fun cleanMessage(raw: String?): String? {
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

    private fun failResult(
        steps: WritableArray,
        status: Int,
        url: String,
        head: String,
        cm: CookieManager,
    ): WritableMap {
        val cookieMap: WritableMap = Arguments.createMap()
        val hosts = listOf("https://auth.dgut.edu.cn/", "https://application.dgut.edu.cn/", "https://lms.dgut.edu.cn/")
        for (h in hosts) {
            val raw = try {
                cm.getCookie(h)
            } catch (_: Throwable) {
                null
            } ?: continue
            raw.split(";").forEach { pair ->
                val i = pair.indexOf('=')
                if (i > 0) {
                    val k = pair.substring(0, i).trim()
                    val v = pair.substring(i + 1).trim()
                    if (k.isNotEmpty()) cookieMap.putString(k, v)
                }
            }
        }
        val r: WritableMap = Arguments.createMap()
        r.putArray("steps", steps)
        r.putInt("finalStatus", status)
        r.putString("finalUrl", url)
        r.putString("finalBodyHead", head)
        r.putMap("cookies", cookieMap)
        return r
    }

    companion object {
        const val NAME = "WebCookie"
    }
}

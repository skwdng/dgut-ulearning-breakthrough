package com.lifekit.crash

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

/**
 * 原生崩溃日志读取模块（2026-10）。
 *
 * 配套 [NativeCrashHandler]：后者在崩溃时把堆栈写进
 * `filesDir/native-crash.log`；本模块让 JS 在下次启动时把它读走、
 * 上报到 `/api/client-log`（见 src/services/crashReport.ts）。
 *
 * ⚠️ 只读/删这个日志文件，不碰任何用户数据。
 */
class NativeCrashLogModule(private val ctx: ReactApplicationContext) :
    ReactContextBaseJavaModule(ctx) {

    override fun getName(): String = "NativeCrashLog"

    /**
     * 读出上次原生崩溃日志并清空（读完即删，避免每次启动重复上报同一条）。
     * 没有日志时返回空字符串。
     */
    @ReactMethod
    fun readAndClear(promise: Promise) {
        try {
            val f = File(ctx.filesDir, "native-crash.log")
            if (!f.exists()) {
                promise.resolve("")
                return
            }
            val text = if (f.length() > 32_000) f.readText().takeLast(32_000) else f.readText()
            f.delete()
            promise.resolve(text)
        } catch (e: Throwable) {
            promise.reject("E_NATIVE_CRASH_LOG", e)
        }
    }
}

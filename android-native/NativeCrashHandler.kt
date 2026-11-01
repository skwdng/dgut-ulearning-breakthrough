package com.lifekit.crash

import android.content.Context
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.util.Date

/**
 * 原生（Java/Kotlin）崩溃兜底 —— 2026-10 真机闪退排查。
 *
 * ══════════════ 为什么需要它 ══════════════
 *
 * 用户真机（华为 Mate 70 Pro / HarmonyOS）反馈「点进去马上退出来」。
 * 服务器日志显示：
 *   · 只有 JS 的 entry，没有 shell_mounted
 *   · 没有任何 JS 异常上报
 *   → 进程崩在**原生层**（Java 异常 / 原生初始化阶段）
 *
 * 手机没连电脑（adb 抓不到），App 又崩在能看到界面之前（用户也导不出日志），
 * 所以只能在原生层自己记：把崩溃栈写进 filesDir/native-crash.log，
 * 下次启动时 JS 通过 NativeCrashLog 模块读走并上报服务器。
 *
 * ⚠️ 只记录堆栈，不记录任何用户数据；文件被 JS 读走即删。
 * ⚠️ 抓不到 native C++ SIGSEGV（那需要 breakpad）——
 *    但如果连这里都没记录，就能反过来证明"崩在 native 更深处"。
 */
object NativeCrashHandler {

    @Volatile
    private var installed = false

    /** 文件名要与 src/services/crashReport.ts 的约定一致 */
    private const val LOG_NAME = "native-crash.log"

    /**
     * 装全局异常处理器。**必须尽早调用**（MainApplication.onCreate 的
     * `super.onCreate()` 之前），否则 SoLoader / expo 初始化阶段崩了抓不到。
     */
    fun install(context: Context) {
        if (installed) return
        installed = true
        try {
            val appContext = context.applicationContext ?: context
            val previous = Thread.getDefaultUncaughtExceptionHandler()
            Thread.setDefaultUncaughtExceptionHandler { thread, error ->
                try {
                    val writer = StringWriter()
                    error.printStackTrace(PrintWriter(writer))
                    val head = "=== ${Date()} thread=${thread?.name} pkg=${appContext.packageName} ===\n"
                    val text = (head + writer.toString()).take(16_000)
                    File(appContext.filesDir, LOG_NAME).appendText(text + "\n\n", Charsets.UTF_8)
                } catch (_: Throwable) {
                    // 记录本身失败也不能影响系统处理
                }
                // 交还系统默认处理：该崩还是崩，不掩盖问题
                previous?.uncaughtException(thread, error)
            }
        } catch (_: Throwable) {
            // 安装失败不影响 App 启动
        }
    }
}

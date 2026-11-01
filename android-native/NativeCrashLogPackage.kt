package com.lifekit.crash

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * 注册 [NativeCrashLogModule]（原生崩溃日志读取）。
 *
 * 由 tools/android/wire-native.cjs 在 prebuild 后自动接入 MainApplication，
 * 所以这里**不需要手改**生成的 android/ 工程。
 */
class NativeCrashLogPackage : ReactPackage {

    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(NativeCrashLogModule(reactContext))

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}

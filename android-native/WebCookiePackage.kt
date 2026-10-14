package com.lifekit.webcookie

import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

/**
 * 注册 WebCookie 模块。
 *
 * wire-native.cjs 会把这两个 .kt 拷到
 * android/app/src/main/java/com/lifekit/webcookie/，
 * 并在 MainApplication.kt 的 getPackages() 里加 add(WebCookiePackage())。
 */
class WebCookiePackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(WebCookieModule(reactContext))

    override fun createViewManagers(
        reactContext: ReactApplicationContext,
    ): List<ViewManager<View, ReactShadowNode<*>>> = emptyList()
}

package com.lifekit.delivery

import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ReactShadowNode
import com.facebook.react.uimanager.ViewManager

/**
 * 把外卖通知监听模块注册进 React Native。
 *
 * 接入方式（expo prebuild 生成 android/ 之后）：
 * 1. 把 android-native/ 下两个 .kt 拷到
 *    android/app/src/main/java/com/lifekit/delivery/
 * 2. 在 android/app/src/main/java/.../MainApplication.kt 的 getPackages() 里加：
 *        add(DeliveryNotificationPackage())
 * 3. 在 android/app/src/main/AndroidManifest.xml 的 <application> 内加：
 *
 *        <service
 *            android:name=".delivery.DeliveryNotificationListener"
 *            android:label="LifeKit 外卖记录"
 *            android:exported="false"
 *            android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE">
 *          <intent-filter>
 *            <action android:name="android.service.notification.NotificationListenerService" />
 *          </intent-filter>
 *        </service>
 *
 * 4. 重新构建：npx expo run:android
 *
 * 用户授权：App 内「外卖 → 开启自动记录」会跳到系统设置，
 * 用户需在「通知使用权 / 通知访问」里打开 "LifeKit 外卖记录"。
 */
class DeliveryNotificationPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(DeliveryNotificationModule(reactContext))

    override fun createViewManagers(
        reactContext: ReactApplicationContext,
    ): List<ViewManager<View, ReactShadowNode<*>>> = emptyList()
}

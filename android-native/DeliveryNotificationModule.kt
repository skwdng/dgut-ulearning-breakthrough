package com.lifekit.delivery

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONArray
import org.json.JSONObject

/**
 * 外卖通知监听（Android）。
 *
 * 原理：用 NotificationListenerService 读取系统通知流，只保留"外卖平台包名"的通知。
 * 隐私边界（重要）：
 *  - 只读取通知的 **标题与正文**，用于提取店铺名/金额/订单阶段；
 *  - 不读取通知里的图片、不读取其他 App 数据、不申请网络权限上传；
 *  - 非外卖包名的通知直接丢弃，不做任何留存。
 *
 * iOS 无法实现（系统不允许读其他 App 通知），由 JS 层降级处理。
 */
class DeliveryNotificationModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    init {
        // Service 向 JS 推送事件时需要拿到 ReactContext
        DeliveryNotificationModuleHost.reactContext = reactContext
    }

    companion object {
        const val NAME = "DeliveryNotification"
        const val TAG = "LifeKitDelivery"
        const val PREFS = "lifekit_delivery"
        const val KEY_PENDING = "pending_notifications"

        /** 监听的外卖平台包名前缀 */
        val WATCHED_PACKAGES = listOf(
            "com.sankuai.meituan",      // 美团
            "me.ele",                    // 饿了么
            "com.jingdong.app.mall",     // 京东
            "com.jd.jdlite",
            "com.ss.android.ugc.aweme",  // 抖音（含外卖）
        )

        /** 允许缓存的最大条数，防止无限增长 */
        const val MAX_PENDING = 200

        @Volatile
        var jsEmitterReady = false
    }

    override fun getName(): String = NAME

    /** 是否有可用的通知监听（仅判断 Android 平台能力） */
    @ReactMethod
    fun isAvailable(promise: Promise) {
        promise.resolve(true)
    }

    /** 用户是否已授予"通知使用权" */
    @ReactMethod
    fun isListeningEnabled(promise: Promise) {
        promise.resolve(isNotificationAccessGranted(reactContext))
    }

    /** 跳转到系统"通知使用权"设置页 */
    @ReactMethod
    fun openNotificationSettings(promise: Promise) {
        try {
            val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (e: Exception) {
            Log.e(TAG, "openNotificationSettings failed", e)
            promise.resolve(false)
        }
    }

    /** 取出后台攒下的通知，并清空 */
    @ReactMethod
    fun drainPending(promise: Promise) {
        try {
            val prefs = reactContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val raw = prefs.getString(KEY_PENDING, "[]") ?: "[]"
            val arr = JSONArray(raw)
            val out = com.facebook.react.bridge.Arguments.createArray()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val map = Arguments.createMap()
                map.putString("pkg", o.optString("pkg"))
                map.putString("title", o.optString("title"))
                map.putString("text", o.optString("text"))
                map.putDouble("at", o.optDouble("at", 0.0))
                out.pushMap(map)
            }
            prefs.edit().putString(KEY_PENDING, "[]").apply()
            promise.resolve(out)
        } catch (e: Exception) {
            Log.e(TAG, "drainPending failed", e)
            promise.reject("E_DRAIN", e)
        }
    }

    @ReactMethod
    fun clearPending(promise: Promise) {
        try {
            reactContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(KEY_PENDING, "[]").apply()
            promise.resolve(true)
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun watchedPackages(promise: Promise) {
        val arr = Arguments.createArray()
        WATCHED_PACKAGES.forEach { arr.pushString(it) }
        promise.resolve(arr)
    }

    /** 供 JS 声明"事件监听已就绪"（RN 要求 addListener/removeListeners） */
    @ReactMethod
    fun addListener(eventName: String) {
        jsEmitterReady = true
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        if (count <= 0) jsEmitterReady = false
    }

    // ---------------- 内部工具 ----------------

    fun isNotificationAccessGranted(context: Context): Boolean {
        val flat = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners") ?: return false
        if (flat.isEmpty()) return false
        val component = ComponentName(context, DeliveryNotificationListener::class.java)
        return flat.split(":").any {
            val cn = ComponentName.unflattenFromString(it)
            cn != null && cn.packageName == component.packageName
        }
    }
}

/**
 * 真正的通知监听服务。
 * 收到通知 → 过滤外卖包名 → 推给 JS（App 在前台）或落盘缓存（App 在后台/未运行）。
 */
class DeliveryNotificationListener : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val notification = sbn?.notification ?: return
        val pkg = sbn.packageName ?: return

        // 只处理外卖平台
        if (DeliveryNotificationModule.WATCHED_PACKAGES.none { pkg.startsWith(it) }) return

        // 跳过常驻通知（如"配送中"的进度条通知会反复更新）
        val flags = notification.flags
        if (flags and Notification.FLAG_ONGOING_EVENT != 0) return

        val extras: Bundle = notification.extras ?: return
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
        val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: ""
        val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString() ?: ""
        val body = when {
            bigText.isNotBlank() && bigText.length > text.length -> bigText
            else -> text
        }
        if (title.isBlank() && body.isBlank()) return

        val item = JSONObject().apply {
            put("pkg", pkg)
            put("title", title)
            put("text", body)
            put("at", System.currentTimeMillis())
        }

        Log.d(DeliveryNotificationModule.TAG, "captured: $pkg / $title / $body")

        val app = applicationContext
        val prefs = app.getSharedPreferences(DeliveryNotificationModule.PREFS, Context.MODE_PRIVATE)

        // 1) 落盘缓存（App 可能没在运行，JS 冷启动时用 drainPending 取走）
        try {
            val arr = JSONArray(prefs.getString(DeliveryNotificationModule.KEY_PENDING, "[]") ?: "[]")
            arr.put(item)
            // 只保留最近 N 条
            val trimmed = if (arr.length() > DeliveryNotificationModule.MAX_PENDING) {
                JSONArray().also { out ->
                    val start = arr.length() - DeliveryNotificationModule.MAX_PENDING
                    for (i in start until arr.length()) out.put(arr.get(i))
                }
            } else arr
            prefs.edit().putString(DeliveryNotificationModule.KEY_PENDING, trimmed.toString()).apply()
        } catch (e: Exception) {
            Log.e(DeliveryNotificationModule.TAG, "persist failed", e)
        }

        // 2) 如果 App 在前台且 JS 已订阅，实时推过去
        try {
            val reactContext = DeliveryNotificationModuleHost.reactContext
            if (reactContext != null && reactContext.hasActiveReactInstance()) {
                val map: WritableMap = Arguments.createMap().apply {
                    putString("pkg", item.getString("pkg"))
                    putString("title", item.getString("title"))
                    putString("text", item.getString("text"))
                    putDouble("at", item.getDouble("at"))
                }
                reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                    .emit("deliveryNotification", map)
            }
        } catch (e: Exception) {
            Log.e(DeliveryNotificationModule.TAG, "emit failed", e)
        }
    }
}

/** 保存一份 ReactContext 引用，供 Service 向 JS 推送事件时使用 */
object DeliveryNotificationModuleHost {
    @Volatile
    var reactContext: ReactApplicationContext? = null
}

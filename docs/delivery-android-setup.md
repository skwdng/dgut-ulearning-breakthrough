# 外卖记录功能 · Android 接入与授权说明

> 功能目标：**记录你在哪个外卖软件点过哪家店、点过几次**
> 实现方式：读取外卖 App 的**订单通知**，自动提取店铺名 → 按店铺聚合统计

---

## 一、平台支持情况（先说清楚）

| 平台 | 自动记录 | 说明 |
|---|---|---|
| **Android / 鸿蒙 4.x（兼容安卓）** | ✅ 支持 | 靠 `NotificationListenerService` 读通知 |
| **iOS** | ❌ 不支持 | 系统不允许第三方 App 读其他 App 通知 |
| **鸿蒙 NEXT（纯血鸿蒙）** | ❌ 不支持 | 不兼容 APK |
| **Expo Go** | ❌ 不支持 | 需要自定义原生构建（prebuild） |

**不支持时 App 不会崩** —— UI 自动降级为「手动记一笔」，并给出说明。

---

## 二、隐私边界（明确写出来）

| 读取 | 不读取 |
|---|---|
| ✅ 通知的**标题与正文**（用于提取店铺名/金额/阶段） | ❌ 通知里的图片 |
| ✅ 仅限**外卖平台包名**的通知 | ❌ 其他任何 App 的通知（直接丢弃，不留存） |
| | ❌ 你的账号、地址、聊天记录 |
| | ❌ 不上传任何数据（无网络请求） |

**监听的外卖包名**（`DeliveryNotificationModule.kt` 里的 `WATCHED_PACKAGES`）：

```kotlin
"com.sankuai.meituan"       // 美团
"me.ele"                     // 饿了么
"com.jingdong.app.mall"      // 京东
"com.jd.jdlite"
"com.ss.android.ugc.aweme"   // 抖音（含外卖）
```

非这些包名的通知在 `onNotificationPosted` 里**第一行就 return**，不做任何处理。

---

## 三、原生代码接入步骤

代码已放在 `android-native/` 下（两个 Kotlin 文件）。因为 Expo 的 `android/` 目录要 `prebuild` 才生成，所以需要手动接入：

### 1) 生成原生工程

```bash
npx expo prebuild --platform android
```

### 2) 拷贝 Kotlin 文件

```
android-native/DeliveryNotificationModule.kt
android-native/DeliveryNotificationPackage.kt
      ↓ 拷到
android/app/src/main/java/com/lifekit/delivery/
```

包名要和 `android/app/build.gradle` 里的 `applicationId` / `namespace` 一致（默认 `com.lifekit.app`，如果不一致请改 Kotlin 文件第一行的 `package`）。

### 3) 注册 Package

打开 `android/app/src/main/java/.../MainApplication.kt`，在 `getPackages()` 里加：

```kotlin
override fun getPackages(): List<ReactPackage> =
    PackageList(this).packages.apply {
        add(DeliveryNotificationPackage())   // ← 加这一行
    }
```

### 4) 注册 Service（AndroidManifest.xml）

在 `<application>` 标签内加：

```xml
<service
    android:name=".delivery.DeliveryNotificationListener"
    android:label="LifeKit 外卖记录"
    android:exported="false"
    android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE">
  <intent-filter>
    <action android:name="android.service.notification.NotificationListenerService" />
  </intent-filter>
</service>
```

### 5) 重新构建

```bash
npx expo run:android
```

---

## 四、用户授权（鸿蒙平板上的实际操作）

**App 内**：首页 → 滑到「外卖」模块 → 点 **「开启自动记录」/「去授权」**

会跳到系统的通知使用权页面。**鸿蒙 4.2 平板的路径**：

```
设置 → 通知和状态栏 → 更多通知设置 → 通知使用权
   （或：设置 → 应用和服务 → 特殊访问权限 → 通知使用权）
→ 找到「LifeKit 外卖记录」
→ 打开开关 → 弹窗确认「允许」
```

> 不同鸿蒙版本菜单名略有差异，也可能叫 **「通知访问」**、**「通知读取权限」**。
> 找不到时可以在设置的搜索框里直接搜 **"通知使用权"**。

授权成功后，App 里「外卖 → 记录方式」会显示 **已开启**。

---

## 五、解析引擎的可靠性（已测）

解析引擎有 **19 个回归测试用例**，覆盖：

| 类别 | 用例 |
|---|---|
| 美团 | 已下单 / 商家接单 / 配送中 / 已送达 / 已取消 |
| 饿了么 | 已下单 / 配送中 / 待支付 |
| 京东秒送 | 已下单 |
| 店名含分隔符 | 「沪上阿姨·鲜果茶(松山湖店)」 |
| **必须忽略** | 优惠券 / 红包活动 / 会员续费 / 求好评 / 版本更新 / 非外卖 App / 空通知 |
| 去重 | 同店 5 分钟内算同一单；40 分钟后算新单 |

跑测试：

```bash
npm run test:delivery
```

**实测发现并修掉的 3 个真实 bug**：
1. 标题「订单已提交」被当成店铺名 → 加了**状态词黑名单校验**
2. 「您有一笔新订单：蜜雪冰城」中文冒号没切分 → 补上 `：` 分隔
3. 「正在配送中」的「中」被后缀规则吃掉 → 加了空格锚定的后缀清理

---

## 六、已知限制（如实说明）

| 限制 | 影响 | 缓解 |
|---|---|---|
| 外卖 App 通知文案会改版 | 解析可能失败 | 失败的通知会进「待确认」列表，用户确认一次即可入库 |
| 同一订单会连发多条通知 | 可能重复计数 | 用「平台+店铺+30分钟窗口」指纹去重 |
| 部分用户关了外卖 App 的通知 | 抓不到 | 只能手动补录 |
| 微信小程序点外卖 | 抓不到（通知来自微信） | 手动补录 |
| 息屏/被杀后台时 | 通知仍会被系统交给 Service（只要授权在），但厂商省电策略可能影响 | 建议把 App 加入电池白名单 |

---

## 七、数据结构

```ts
interface DeliveryOrder {
  id: string;
  platform: 'meituan' | 'eleme' | 'jd' | 'douyin' | 'other';
  pkg: string;              // 原始包名，便于排查
  storeName: string;        // ← 统计核心维度
  amount?: number;
  stage: 'created' | 'paid' | 'delivering' | 'done' | 'cancelled' | 'unknown';
  at: number;
  source: 'notify' | 'manual' | 'clipboard';
  fingerprint: string;      // 去重键
}
```

**统计口径**：`cancelled`（已取消）的订单**不计入**「点过几次」。

---

*本文档与代码同步；改动解析规则后请重跑 `npm run test:delivery`。*

# 优学院（Ulearning）自动签到模块 · 技术深入研究

> 配套文档：`ui-spec.md`（v1.0）第 3.4 / 3.6 / 5.1 / 6 节
> 本文档聚焦：**接口与自动化技术方案（登录 / 轮询 / 提交 / 风控）**
> 目标院校基准：东莞理工学院（DGUT）融合式智慧教学平台（优学院）
> 文档版本：v0.1（研究稿） | 调研日期：见文末

---

## 0. 结论摘要

1. **端点不统一，必须按"学校 → 域名"配置化**。优学院是 SaaS 多租户产品，各校入口不同：DGUT 学生入口是 `application.dgut.edu.cn` 应用中心，优学院本体在 `lms.dgut.edu.cn`，认证在中央认证 `auth.dgut.edu.cn`。**任何写死 `ulearning.cn` 域名的实现都会在 DGUT 失败**，因此接口层必须是"租户适配器"结构。
2. **DGUT 的密码登录路径基本不可自动化，这是本模块最大的技术约束**。原因有两条硬事实：
   - 密码走 AES-CBC + PKCS7 + Base64，密钥来自登录页隐藏域 `pwdEncryptSalt`，IV 与明文前缀随机（每次结果不同）；
   - DGUT 中央认证在 2025 年后对**陌生浏览器要求短信二次认证（MFA）**，即使用户名密码正确也会停在验证码页。
   → 结论：**绑定流程必须支持"会话导入（Cookie 导入）"作为一等公民**，账号密码只作为可选辅助路径，并在 UI 上如实告知"可能需要输入短信验证码"。
3. **签到是"事件驱动 + 短窗口"问题，不是"固定时间点"问题**。教师端（APP 或投屏）发起点名后，签到窗口通常只有几分钟，因此必须用**轮询 + 推送**双通道：轮询发现窗口，长连接/推送争取时间。默认 30s 轮询在 5 分钟窗口内有约 10 次机会，可用；但要按课程时间表**动态调节轮询密度**（上课时段 10~15s，非上课时段 5~10 分钟或休眠）。
4. **签到类型覆盖度决定可用性**。已核实教师端支持**一键签到、二维码签到**（[优学院帮助中心·点名](http://help.ulearning.cn/?p=4901)）；同类平台普遍还有**数字/邀请码签到、定位签到、手势签到**。本模块按"可自动化程度"分三级：普通/数字 → 全自动；定位 → 全自动（需定位模拟 + 反检测）；二维码 → 需视觉通道（截屏/投屏/拍照），仅能半自动，**必须在 UI 上明确降级说明**。
5. **风控与合规必须在架构里显式存在**：单账号请求节流、签到延迟随机化、夜间静默、失败熔断、操作留痕。这不仅是防封号，也是本功能可长期存活的工程前提。

---

## 1. 调研方法与证据等级（重要）

本文档中的技术细节按证据强度标注，**开发前必须按 §11 清单在真机/真账号上复核**：

| 标记 | 含义 |
|---|---|
| ✅ **已核实** | 来自官方帮助中心 / 学校官网 / 公开且可复核的抓包分析文章 |
| 🟡 **待现场验证** | 来自同类平台经验 + 通用实现模式，域名/参数名/字段名需抓包确认 |
| 🔵 **工程假设** | 设计推断，正确性不依赖具体端点，按契约实现即可 |

本轮调研受限情况如实记录：**当前网络环境下 `github.com`、`raw.githubusercontent.com`、`greasyfork.org`、`ufec-blog.vercel.app` 均无法抓取正文**（`web_fetch` 连接失败），因此以下两条公开参考实现**只核实到标题与站点存在，未读到源码**，其端点细节不得直接抄写：
- [GitHub - ufec/yxyauto：优学院自动签到活动提醒](https://github.com/ufec/yxyauto)
- [GitHub - May27thzzk/cockroach-ulearning-helper：DGUT 优学院](https://github.com/May27thzzk/cockroach-ulearning-helper)（另有同名[用户脚本](https://greasyfork.org/ja/scripts/582816-%E8%8E%9E%E5%B7%A5%E5%B0%8F%E8%9F%91%E8%9E%82-%E4%BC%98%E5%AD%A6%E9%99%A2%E5%85%A8%E8%83%BD%E5%8A%A9%E6%89%8B)）

**可读通的公开源**（本文档的事实依据）：
- [点名 · 优学院帮助中心](http://help.ulearning.cn/?p=4901) ✅ — 教师端签到类型与行为
- [【网页逆向】东莞理工学院版优学院快速进入 · 博客园](https://www.cnblogs.com/resea/p/20135197) ✅ — DGUT 完整登录链路、密码加密算法、MFA 接口、信任跳转原理
- [东莞理工学院教务部网站](https://jwb.dgut.edu.cn/) ✅ — 确认"融合式智慧教学平台（优学院）"入口为 `https://application.dgut.edu.cn/`
- [University Helper 项目首页](https://sweetcornna.github.io/university-helper/) ✅ — 同类自托管签到平台（超星/智慧树）的成熟架构参考：租户隔离、凭据加密、任务队列、一键全签

---

## 2. 平台事实：拓扑、域名、签到类型

### 2.1 系统拓扑（DGUT）✅

```
学生 App / 浏览器
   │
   ├─→ lms.dgut.edu.cn            优学院本体（LMS，课程/活动/签到）
   │        ↑ 未登录则 301 踢出
   ├─→ application.dgut.edu.cn    应用中心（信任中介 + 工作台）
   │        ↑ 必须经此建立信任
   └─→ auth.dgut.edu.cn           中央认证（CAS，账号密码 + 短信 MFA）
```

**关键结论（来自逆向分析）**：`auth.dgut.edu.cn` **只信任来自应用中心 `application.dgut.edu.cn` 的请求**；直接把 CAS 的 `service` 参数指向优学院不会被信任。因此**登录流程必须是完整的三级跳转链**，不能用"直接请求 CAS 换票"的简化实现：

```
lms（301 踢出）→ application（应用中心）→ auth（登录页取 salt/execution）
   → POST /authserver/login（AES 密码）
   → application（CAS 回调建立信任，Set-Cookie 一堆）
   → application/#/index（工作台）
   → lms（带上应用中心 Cookie，登录完成）
```

### 2.2 已知签到类型与可自动化程度

| 类型 | 教师端形态 | 学生端动作 | 自动化程度 | 依据 |
|---|---|---|---|---|
| 一键签到（普通） | APP 发起点名，学生点击即签到 | 点按钮 → 提交 | **全自动** ✅ | [帮助中心](http://help.ulearning.cn/?p=4901) |
| 二维码签到 | 发起后**投屏展示二维码** | 扫码 → 提交 | **半自动**（需拿到二维码图像） ✅ | 同上 |
| 数字 / 邀请码签到 | 教师口播或投屏一组数字 | 输入数字 → 提交 | **全自动** 🟡 | 同类平台通用形态 |
| 定位签到 | 设定地理范围（可开"范围外签到"） | 携带坐标提交 | **全自动**（需定位模拟） 🟡 | [同类平台教师手册](https://xsc.ahpu.edu.cn/_upload/article/files/09/a0/71e379c84b678dfd01ec8e1ea4d7/89a7fc3d-bb9d-4ff8-a9c8-0e140026c269.pdf) |
| 手势签到 | 教师设定手势轨迹 | 复现手势 | **全自动** 🟡 | 同类平台形态 |
| 拍照签到 | 要求现场拍照 | 上传照片 | **不可自动化**，仅提醒 | 同类平台形态 |
| 直播签到 | 直播中发起 | 点签到 | 全自动 🟡 | [优学院直播自动签到（标题级）](https://ufec-blog.vercel.app/archives/yxy-live-auto-sign.html) |

**产品决策**：第一版只承诺"**普通/数字/定位 全自动** + **二维码 提醒并辅助**"，其余类型只做"检测到 → 立即提醒用户手动处理"。这比宣称"全自动"然后在二维码课上失效要安全得多。

### 2.3 DGUT 专属风险点（必须写进 UI 文案）✅

1. **登录链路长**：缺任何一跳的 Cookie 都会被踢回登录页。
2. **短信 MFA**：陌生设备/浏览器首次登录会要求短信验证码；调研文章明确提到"二次认证十分不稳定"，建议**用户先在系统浏览器里正常登录一次**，再由 App 复用会话。这直接决定了绑定页的交互设计。
3. **`USER_INFO` / `USERINFO` 双 Cookie**：大小写不同的两个同名字段（一个 URL 编码、一个 `%u` 编码），必须原样保存，**不能做 Cookie 去重/归一化**（常见坑：HTTP 客户端按大小写不敏感合并 Cookie 会导致登录态丢失）。
4. 密码加密的字符集是 `ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678`（**注意缺 I、L、O、l、o、1、0、9** 等），实现随机串时必须用同一字符表，否则服务端可能因前缀解析异常报错。

---

## 3. 认证与会话方案（本模块核心难点）

### 3.1 三级方案，按可靠性排序

| 方案 | 说明 | 可靠性 | UI 形态 |
|---|---|---|---|
| **A. 会话导入（Cookie）** ⭐首选 | 引导用户在系统浏览器/内置 WebView 完成一次登录（含短信 MFA），App 抓取该会话的 Cookie 集合并加密存储 | 高 | 内置 WebView 打开 `application.dgut.edu.cn`，监听跳转回到 `lms.dgut.edu.cn` 后导出 Cookie |
| **B. 账号密码 + 短信验证码** | 走 §3.2 的完整链路；遇到 MFA 时弹出验证码输入框 | 中（MFA 依赖人工） | 表单 + MFA 弹窗 + 错误提示 |
| **C. 手动粘贴 Cookie**（兜底/调试） | 用户从浏览器 DevTools 复制 Cookie 字符串粘贴 | 高但体验差 | 多行输入框 + 校验按钮 |

**建议实现顺序：A → B → C**。A 是唯一能同时绕开"MFA 不可预测"和"密码加密易变"的方案。

### 3.2 账号密码登录链路（方案 B 详细步骤）✅

**步骤 1 — 取盐与执行令牌**

```
GET  {AUTH_HOST}/authserver/login?service={应用中心 CAS 回调，URL 编码}
→ 200 HTML，解析隐藏域：
   input#pwdEncryptSalt   → salt（AES 密钥，16 位）
   input#execution        → execution（CAS 执行令牌）
注意：allow_redirects=False。若返回 301/302 + Location，说明当前会话已认证，直接跟进 Location 换票即可（见步骤 2'）
```

**步骤 2 — 加密密码**

```
明文 = randomString(64) + 原始密码
算法 = AES/CBC/PKCS7，key = salt(UTF-8)，iv = randomString(16)
密文 = Base64(ciphertext)

randomString(charset = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678")
```

**步骤 2' — 多因子认证（出现时）**

```
POST {AUTH_HOST}/authserver/dynamicCode/getDynamicCodeByReauth.do
     userName=<学号>&authCodeTypeName=reAuthDynamicCodeType

POST {AUTH_HOST}/authserver/reAuthCheck/reAuthSubmit.do
     service=&reAuthType=3&isMultifactor=true&password=&dynamicCode=<用户输入>
     &uuid=&answer1=&answer2=&otpCode=&skipTmpReAuth=true
→ 响应含"认证成功"即通过，随后用**同一个 Session** 重新走步骤 1
```

**步骤 3 — 提交登录**

```
POST {AUTH_HOST}/authserver/login?service=...
Content-Type: application/x-www-form-urlencoded
username=<学号>&password=<密文>&captcha=&_eventId=submit
&cllt=userNameLogin&dllt=generalLogin&lt=&execution=<步骤1 的 execution>
→ 302 + Location
```

**步骤 4 — 建立信任链**

```
GET application.dgut.edu.cn（跟随 CAS 回调）→ 拿到应用中心 Cookie（含 USER_INFO / USERINFO / AUTHORIZATION）
GET application.dgut.edu.cn/#/index（工作台，可选，保证会话激活）
GET lms.dgut.edu.cn/...        → 200 即成功；若 301 回 auth，说明链路不完整，重试一次全流程
```

### 3.3 会话校验与过期（工程假设 🔵）

- **健康检查接口**：任选一个需要登录的轻量页面（课程列表首页）做探活，若出现 301/302 指向 `auth.` 域，则判定会话失效。
- **校验时机**：App 冷启动、绑定页进入、每次轮询任务开始前（节流：同一会话 5 分钟内不重复探活）。
- **过期策略**：失效即暂停该用户所有定时任务、置 `sessionState=expired`、推送"需要重新绑定"通知，**不做自动重登**（避免用旧密码反复触发学校 MFA 与风控）。

### 3.4 凭据存储（安全要求）

| 项 | 要求 |
|---|---|
| 客户端 | Cookie/密码**只存 Keystore / Keychain**（Android EncryptedSharedPreferences + Keystore；iOS Keychain `kSecAttrAccessibleAfterFirstUnlock`），禁止明文落 SharedPreferences/NSUserDefaults |
| 服务端（如做云端轮询） | Fernet/AES-GCM 加密，密钥仅存环境变量；每用户独立租户库或独立 schema，参考 [University Helper](https://sweetcornna.github.io/university-helper/) 的隔离做法 |
| 日志 | 严禁打印 Cookie、密码、密文；请求日志统一做 `authorization: ***` 脱敏 |
| 明文密码 | **默认不持久化**；只有用户显式勾选"记住密码以便自动重登"时才加密存储，并在解绑时立即删除 |

---

## 4. 轮询与窗口捕获

### 4.1 问题本质

教师发起点名 → 服务端开启一个**带时限的签到窗口**（通常数分钟）→ 学生端在窗口内提交才有效。因此系统要解决的不是"什么时候签到"，而是"**如何在窗口开启后的最短时间内发现它**"。

### 4.2 三级轮询策略（推荐）

| 层级 | 触发条件 | 间隔 | 作用 |
|---|---|---|---|
| 活动期（热） | 当前时间命中课表时段（含前后 10 分钟缓冲） | **10~15s**，加抖动 | 主要发现通道 |
| 常规期（温） | 当天有课，但不在时段内 | 3~5 分钟 | 兜底（临时调课、补签到） |
| 休眠期（冷） | 无课日 / 夜间 23:00–07:00 / 用户手动暂停 | 停止或 30 分钟 | 省电、降低风控面 |

### 4.3 抖动与并发控制（风控要点）

```
实际间隔 = 基准间隔 × (1 + uniform(-0.3, +0.3))
提交延迟 = uniform(3s, 25s)        // 检测到窗口后不要 0 秒内提交
抖动随机种子按「用户」而非「设备」生成，避免同账号多端同频
```
- **单账号并发上限 1**：同一账号同一时刻只允许一个请求在途（全局互斥锁，避免多课程同时提交触发风控）。
- **心跳自适应**：连续 N 次请求返回限流/风控（如 429/403/自定义错误码），指数退避到 5 分钟并推送"风控提示"。

### 4.4 候选接口（🟡 待现场验证，参数名以抓包为准）

| 目的 | 方法 | 相对路径（示意） | 关键参数 | 返回要点 |
|---|---|---|---|---|
| 待处理活动列表 | GET | `/api/activity/pending` 或课程维度 `/api/course/{courseId}/activity` | `courseId`、`status=pending` | 活动 id、类型（签到=2 等）、开始/结束时间 |
| 签到详情 | GET | `/api/rollcall/{rollcallId}` | `rollcallId` | 签到方式、是否已签、剩余时间、是否需要数字/位置 |
| 提交签到 | POST | `/api/rollcall/{rollcallId}/sign` | 见 §5 | 成功/失败原因 |
| 历史记录 | GET | `/api/rollcall/history` 或 `/api/user/{uid}/attend` | 分页 | 结果列表（用于对账） |

**关于"活动类型"字段**：公开资料显示同类教学系统活动表用数字编码活动类型，其中 **2 = 签到**（[参考](https://www.xit.edu.cn/_upload/article/files/4d/23/90b439a44360b4edd328f71ac9e6/ddeabe91-395d-4cb3-a374-210afaf3fca3.pdf)）。优学院是否沿用同编码需现场核对，**实现上请把类型映射放进可远程更新的配置表**，避免硬编码。

### 4.5 必须在文档/代码里固定的"三源交叉"原则

不要只依赖一个信号判断"是否有签到"：
1. 待处理活动列表（主）
2. 课程未读通知/角标（辅）
3. 历史记录里是否已存在本次（去重，防重复提交）

三者任一命中即进入 `detecting`；三者均无则维持 `idle`。

---

## 5. 提交流程（签名、请求头、动态参数）

### 5.1 通用请求头契约（🟡 以抓包为准，但一致性是硬要求）

```
Cookie: <完整会话，原样，不合并大小写同名 Cookie>
User-Agent: <与登录时完全一致>
Referer: {LMS_HOST}/courseweb/...   （具体页面路径需抓包）
Origin:  {LMS_HOST}
Content-Type: application/json     （或 application/x-www-form-urlencoded）
Authorization / X-Token: <若需，从 USER_INFO 的 authorization 字段取>
```

**一致性原则**：登录、轮询、提交三个阶段必须使用**同一份** UA / 设备指纹 / IP 出口。中途换 UA、换 IP（Wi-Fi ↔ 流量）是最常见的"明明密码对却掉登录态"的原因。

### 5.2 提交载荷（🔵 契约示意）

```jsonc
{
  "rollcallId": "1234567",
  "courseId": "89012",
  "signType": "normal | number | qrcode | location | gesture",
  "signCode": "4821",                 // 数字签到时必填
  "qrcode": "<扫码得到的载荷>",         // 二维码签到时必填
  "longitude": 113.8xxxxx,            // 定位签到
  "latitude": 22.9xxxxx,
  "accuracy": 25,
  "address": "…(可选)",
  "deviceInfo": "{…}",                // 若服务端要求
  "clientTime": 1760000000000,        // 若服务端要求客户端时间
  "sign": "<若存在签名参数，必须复现其算法>"   // 见 5.4
}
```

### 5.3 时间同步（容易被忽略的失败原因）

服务端常校验 `clientTime` 与服务端时间的偏差。实现要求：
- 启动时与服务端（或 NTP）做一次时间偏移测量，得到 `offset = serverTime - localTime`；
- 后续所有时间字段一律用 `localTime + offset`；
- 偏移超过 60s 时推送告警（用户手机时间错误是真实存在的失败源）。

### 5.4 签名/加密参数（🔵 高风险项，必须现场逆向）

若抓包发现提交请求带 `sign`、`_t`、`nonce`、`encData` 等字段：
1. 在 WebView 里 Hook（如 `XMLHttpRequest`/`fetch`）或下断点定位签名函数；
2. 记录：参与签名的字段及顺序、算法（常见 MD5/SHA1/HMAC-SHA256）、密钥来源（常量/接口下发/时间派生）；
3. **把签名实现封装为独立、可热更新的模块**（远端配置下发 JS 规则或插件化 Dart/TS 函数），因为签名算法随时可能变更；
4. 该模块必须支持"签名失败 → 明确错误码 → 提示用户升级 App"，而不是静默失败。

### 5.5 定位签到的坐标策略

- **首选**：使用教师在活动设置中给出的范围中心（若接口返回），或用户预先配置的"课程位置"。
- **兜底**：内置地图选点（参考同类产品的"选中地点即拿坐标"交互）。
- **反检测**：坐标做小幅随机扰动（±5~15 米）并保证 `accuracy` 合理（不要固定 0 或 1）；同一课程多次签到不要使用完全相同坐标。
- **前置检查**：Android 模拟位置需在开发者选项中开启；部分 ROM 对 Mock Location 有检测，需在绑定页做**能力自检**并如实提示（"当前设备不支持定位模拟，定位签到将失败"）。

### 5.6 二维码签到：现实可用的三种通道

| 通道 | 做法 | 可行性 | 代价 |
|---|---|---|---|
| 教师投屏 → 学生拍照 | App 内扫码（相机）→ 解析 → 自动提交 | 中 | 需要用户举起手机对准屏幕 |
| 教师投屏 → 同设备截图 | 用户在 App 内截屏 → 无障碍/分享入口解析二维码 | 中 | 需系统权限，路径长 |
| 投屏在 PC / 群内图片 | 分享图片到 App 解析 | 中 | 依赖用户操作 |
| 从接口直接读取二维码载荷 | 若签到详情接口返回二维码内容 | **未知** 🟡 | 若成立则全自动，**抓包时重点验证** |

> 抓包重点：`GET rollcall 详情` 是否返回 `qrcode`/`qrContent`/`signCode` 字段。**这决定二维码签到能否全自动**，是本次研究最高优先级待验证项。

---

## 6. 风控、限流与合规

### 6.1 行为特征清单（要避免的"机器人指纹"）

| 特征 | 风险 | 缓解 |
|---|---|---|
| 固定 30.000s 轮询 | 高（时序指纹） | ±30% 抖动 |
| 检测到即刻提交（<1s） | 高 | 3~25s 随机延迟 |
| 多课程并发提交 | 高 | 串行队列 + 队列间隔 |
| 全天 24h 活跃 | 中 | 夜间静默，非上课时段降频 |
| UA/指纹与登录时不一致 | 高（掉登录态） | 全链路指纹固定 |
| 单设备多账号高频 | 高 | 每账号独立节流桶 |
| 失败后无限重试 | 高（撞风控） | 退避 + 熔断 |

### 6.2 退避与熔断参数（建议值）

```
失败重试：3 次，间隔 2s / 8s / 30s（指数 + 抖动）
限流命中：退避到 5 分钟，连续 3 次 → 熔断 30 分钟并通知用户
单日上限：同一账号提交类请求 ≤ 60 次（超出仅保留轮询）
熔断恢复：需要用户手动"恢复自动签到"（显式确认，避免无人值守撞风控）
```

### 6.3 合规与伦理边界（必须写进产品）

- 本功能属于**课堂考勤辅助**，用户须自行确认符合学校规定与课程要求；UI 首启动需一次性确认告知。
- **不做**：代刷课、代答题、代考试、成绩篡改、批量代签（多学生账号）。
- **不做**：绕过学校 MFA 的账号密码自动化（不猜测、不撞库、不存储明文密码作为默认行为）。
- 提供**一键暂停/解绑并彻底删除凭据**，满足用户随时退出。
- 提供完整操作留痕（本地 + 可选云端），便于用户自查与申诉。

---

## 7. 状态机与 UI 落点

### 7.1 签到任务状态机（对应 ui-spec §5.2，此处细化）

```
                 ┌────────────── expired（会话失效）←──┐
                 ↓                                    │
unbound → idle（监控中）→ detecting（发现窗口）→ submitting（提交中）
                 ↑                 │                  │
                 │                 │ 无匹配类型        ├→ success（成功）
                 │                 ↓                  ├→ failed（失败，带原因码）
                 └── cooldown ←── need_manual（需人工：二维码/手势/拍照/数字未获取）
                                   ↑
                          rate_limited（风控退避）→ paused（熔断，待用户恢复）
```

| 状态 | 触发 | UI 表现（checkin 页） | 用户可操作 |
|---|---|---|---|
| `idle` | 正常监控 | 绿色"监控中" + 下次轮询倒计时 | 暂停/立即检测 |
| `detecting` | 发现活动 | 卡片高亮 + 进度提示 | 查看详情 |
| `submitting` | 已提交 | 转圈 + 目标课程名 | 取消（弱） |
| `success` | 服务端确认 | 绿色勾 + 时间 + 方式 | 查看记录 |
| `failed` | 服务端拒绝/网络错误 | 红色 + **原因码 + 建议动作** | 重试（手动）/查看原因 |
| `need_manual` | 类型不可自动 / 缺数字码 | 橙色横幅 + **立即去签到**深链 | 输入数字码 / 扫码 |
| `rate_limited` | 被限流 | 黄色 + 倒计时 | 恢复 |
| `expired` | 会话失效 | 红色 + "重新绑定"按钮 | 重新绑定 |

### 7.2 需要新增/修改的页面（相对 ui-spec v1.0）

| 页面 | 变更 | 关键交互 |
|---|---|---|
| `youxue-bind`（3.6） | **改**：把"账号设置"改为三选一入口（会话导入 / 账号密码 / 手动 Cookie）；新增"能力自检"区（模拟定位、后台保活、通知权限） | WebView 登录 → 自动导出会话 → 显示"已绑定 · 有效期" |
| `checkin`（3.4） | **改**：状态卡增加 `need_manual` / `rate_limited` / `expired` 三态；课程卡增加"签到方式"标签 | 横幅一键跳手动签到 |
| `checkin-manual` | **新增**：手动签到的兜底页（输入数字码 / 扫码 / 选定位） | 扫码用相机；数字码大键盘 |
| `checkin-fail-detail` | **新增**：失败详情（原因码、原始错误、请求时间、建议动作、重试） | 复制诊断信息（脱敏） |
| `checkin-log` | **新增**（开发者模式）：轮询/提交/响应原始记录，脱敏 | 导出为文本供反馈 |
| `location-settings`（3.4 已引用） | **改**：地图选点 + 范围半径 + 单课程覆盖 | 选中即取坐标 |
| `poll-settings`（3.6 已引用） | **改**：三档策略（热/温/冷）+ 抖动与随机延迟开关 + 单日上限 | 高级参数用滑块 |

---

## 8. 数据模型与接口契约

### 8.1 客户端实体（TypeScript 示意）

```ts
type SessionState = 'valid' | 'expired' | 'unknown';

interface YouxueAccount {
  id: string;                 // 本地 id
  schoolCode: 'dgut';         // 租户标识 → 决定域名与适配器
  studentId: string;
  displayName?: string;
  sessionState: SessionState;
  boundAt: number;
  lastProbeAt: number;
  lastProbeOk: boolean;
  authMode: 'session' | 'password' | 'manual';
  capabilities: {              // 能力自检结果
    mockLocation: boolean;
    backgroundKeepAlive: boolean;
    notification: boolean;
    camera: boolean;
  };
}

interface RollcallTask {
  id: string;
  accountId: string;
  courseId: string;
  courseName: string;
  rollcallId?: string;
  signType: 'normal'|'number'|'qrcode'|'location'|'gesture'|'photo'|'unknown';
  windowStart?: number;
  windowEnd?: number;
  state: 'idle'|'detecting'|'submitting'|'success'|'failed'|'need_manual'|'rate_limited'|'paused';
  attempts: number;
  lastErrorCode?: string;
  lastErrorMsg?: string;
  submittedAt?: number;
  confirmedAt?: number;
}

interface PollPlan {            // 轮询计划（服务端或本地计算）
  accountId: string;
  tier: 'hot'|'warm'|'cold';
  baseIntervalMs: number;
  jitterRatio: number;
  submitDelayMs: [number, number];   // [3000, 25000]
  dailySubmitCap: number;
  nightSilence: [string, string];    // ['23:00','07:00']
}
```

### 8.2 后端表（若做云端轮询）

```sql
-- 凭据（加密）
credential(id, user_id, school_code, cipher_blob, kdf_ver, created_at, rotated_at)
-- 会话
session(id, credential_id, cookie_blob, ua, expires_at, state, last_ok_at)
-- 岗位/课程表
course(id, user_id, school_code, course_id_ext, name, teacher, schedule_json, location_json, auto_enabled)
-- 任务与记录
rollcall_task(id, session_id, course_id, rollcall_id_ext, sign_type, state, attempts, window_start, window_end, created_at, updated_at)
checkin_record(id, user_id, course_id, rollcall_id_ext, status, method, sign_type, location, fail_code, fail_reason, submitted_at, confirmed_at)
-- 审计
audit_log(id, user_id, action, target, result, meta_json, created_at)
```

**幂等键**：`(user_id, rollcall_id_ext)` 唯一索引，防止多端/重试造成重复提交。

### 8.3 内部服务接口（自托管形态，参考同类项目命名习惯）

```
POST /youxue/bind/session          # 提交导入的 Cookie，校验并保存
POST /youxue/bind/password         # 账号密码登录（可能返回 need_mfa）
POST /youxue/bind/mfa              # 提交短信验证码，续跑登录
GET  /youxue/session/state         # 会话健康
POST /youxue/poll/plan             # 设置轮询策略
POST /youxue/checkin/now           # 立即检测一次
POST /youxue/checkin/manual        # 手动提交（数字码/二维码/坐标）
GET  /youxue/records               # 历史与对账
POST /youxue/unbind                # 解绑并删除凭据
```

### 8.4 错误码分类与处置（指导 UI 文案与重试策略）

| 错误码 | 含义 | 可重试 | 用户动作 | UI 文案方向 |
|---|---|---|---|---|
| `E_SESSION_EXPIRED` | 会话失效/被踢 | 否 | 重新绑定 | "登录已过期，请重新绑定" |
| `E_MFA_REQUIRED` | 需要短信验证 | 是（人工） | 输入验证码 | "学校要求短信验证" |
| `E_WINDOW_CLOSED` | 窗口已过 | 否 | 无 | "签到已结束" |
| `E_ALREADY_SIGNED` | 已签到 | 否 | 无 | "已完成签到"（视为成功） |
| `E_CODE_INVALID` | 数字码/二维码无效 | 是（人工） | 重新获取 | "签到码不正确，请重新输入" |
| `E_OUT_OF_RANGE` | 定位不在范围 | 是 | 检查定位 | "定位不在签到范围" |
| `E_SIGNATURE` | 签名/参数校验失败 | 是（升级） | 升级 App | "接口已更新，请升级版本" |
| `E_RATE_LIMITED` | 风控/限流 | 是（退避） | 稍后 | "操作过于频繁，已暂停 X 分钟" |
| `E_NETWORK` | 网络异常 | 是 | 检查网络 | "网络异常，正在重试" |
| `E_UNKNOWN` | 未识别 | 有限 | 反馈 | "签到失败，已记录诊断信息" |

---

## 9. 后台保活与推送（落地关键，决定自动化的实际成功率）

### 9.1 平台现实

| 平台 | 现实约束 | 推荐架构 |
|---|---|---|
| Android | Doze / 厂商省电策略会杀后台；精确闹钟需 `SCHEDULE_EXACT_ALARM` | **前台服务 + 常驻通知**（"正在监控签到"）+ `WorkManager` 周期兜底；引导用户加白名单 |
| iOS | 后台执行约 30s 后挂起；无自由定时后台 | **服务端轮询为主**（App 只负责绑定与通知），或 `BGAppRefreshTask` 做低频兜底（不可靠） |
| 鸿蒙/其他 | 类似 Android | 同 Android 策略 |

**结论（重要产品决策）**：要在 iOS 上做到"可靠自动签到"，**必须有服务端轮询组件**；纯客户端方案在 iOS 上无法承诺成功率。UI 上必须区分"本地监控（前台/后台受限）"与"云端监控（需登录云端账号）"两种模式，并展示各自的能力边界。

### 9.2 通知设计

| 事件 | 优先级 | 渠道 | 内容要点 |
|---|---|---|---|
| 检测到签到窗口 | 高 | 本地推送（穿透免打扰可选） | 课程名 + 剩余时间 + "正在自动提交" |
| 需人工介入 | 最高 | 本地推送 + 声音 | 课程名 + 类型 + 一键深链到 `checkin-manual` |
| 签到成功 | 低 | 静默/汇总 | 每 N 条汇总，避免打扰 |
| 签到失败 | 高 | 本地推送 | 原因码 + 建议动作 |
| 会话失效 | 高 | 本地推送 | "需要重新绑定" |

### 9.3 时间与电量预算

- 前台服务内存 < 30MB；热阶段单日请求量（按 4 节课计）约 4×(50/15)≈ 数百次 → **必须给用户可见的"今日请求次数"计数**，让功耗与风控面透明化。
- 提供"仅 Wi-Fi 轮询""仅充电时轮询"选项。

---

## 10. 测试与验收

### 10.1 测试矩阵

| 场景 | 方法 | 通过标准 |
|---|---|---|
| 会话导入 | 真机登录 DGUT 后导入 Cookie | 能拉到课程列表，`sessionState=valid` |
| MFA 路径 | 用陌生设备触发短信 | 能停在 MFA 页、能提交验证码、能续跑 |
| 普通签到 | 教师账号在测试课程发起点名 | 检测 ≤ 20s，提交成功，记录正确 |
| 数字签到 | 同上，设数字 | 数字码解析/输入正确，提交成功 |
| 定位签到 | 设置范围，验证范围外/内 | 范围内成功；范围外返回 `E_OUT_OF_RANGE` 并提示 |
| 二维码签到 | 投屏二维码，扫码 | 解析成功并提交；若接口直接返回载荷则全自动 |
| 窗口关闭 | 手动延迟到窗口结束 | 返回 `E_WINDOW_CLOSED`，不重试 |
| 已签到去重 | 重复提交 | 幂等，不产生重复记录 |
| 会话过期 | 服务端失效会话 | 暂停任务 + 推送 + 不自动重登 |
| 风控退避 | 注入 429 | 指数退避 + 熔断 + 通知 |
| 后台被杀 | Android 厂商省电模式 | 前台服务存活；被杀死后能恢复并提示 |
| 时间偏差 | 手机时间 +5 分钟 | 时间校准生效，提交正常 |
| 弱网 | 3G/丢包 30% | 重试成功，无重复提交 |

### 10.2 验收指标（建议）

- 普通/数字/定位签到，**窗口开启到提交成功 ≤ 30s（P95）**；
- 检测漏报率 ≤ 1%（以"教师确实发起了签到"为分母，按测试数据）；
- 重复提交率 = 0；
- 会话维持 ≥ 7 天（无用户侧改密码/清 Cookie 干扰）；
- 崩溃率 & 因本功能被系统杀进程的投诉 < 1%。

---

## 11. 现场验证清单（开发前必做 · 按优先级）

> 目的：把本文档中 🟡 的项变成 ✅。建议用一台测试机 + 一个测试课程账号，抓包工具（Charles/mitmproxy）+ WebView 调试完成。

**P0（决定架构，必须先做）**
1. 抓取"**待处理/进行中活动**"接口：路径、方法、请求头、参数、响应结构，确认**签到类型字段名与取值编码**。
2. 抓取"**签到详情**"接口：是否返回**二维码载荷 / 数字码**（决定二维码签到能否全自动，以及是否需要 OCR/扫码）。
3. 抓取"**提交签到**"接口：完整载荷、是否需要 `sign`/`nonce`/`clientTime`，以及成功/失败响应体的**错误码集合**。
4. 验证 **Cookie 导入方案**是否可长期复用（关浏览器、换网络、隔天是否仍有效）。

**P1（决定体验）**
5. 签到窗口的**真实时长**（最短/最长/是否可延长）→ 校准轮询档位。
6. 服务端是否校验 **UA/Referer/Origin/设备指纹**（逐项差异测试）。
7. 定位签到的**坐标精度与范围判定**（返回体是否含中心点与半径）。
8. 是否存在**接口级限流**（QPS、日次数）→ 校准节流参数。

**P2（决定稳定性）**
9. 同一账号**多端并存**行为（是否会互相踢下线）。
10. 教师手动改签到状态后，学生端记录是否同步。
11. 补签/迟到/早退等状态在历史接口中的取值。
12. App 版本升级后参数是否变化（建立**每日一次的低频探活**做兼容性监控）。

---

## 12. 里程碑建议

| 阶段 | 范围 | 交付 |
|---|---|---|
| M0（1 周） | 完成 §11 的 P0 抓包与结论 | 抓包报告 + 端点契约表（本文档修订为 v0.2） |
| M1（2 周） | 会话导入绑定 + 会话健康检查 + 课程/课表拉取 | 可绑定、可看到课程 |
| M2（2 周） | 轮询引擎（三档 + 抖动）+ 普通/数字签到全自动 + 记录落库 | 端到端可用（Android 前台服务） |
| M3（1 周） | 定位签到 + 坐标配置 + 反检测 | 定位签到可用 |
| M4（1 周） | 二维码/手势/拍照的"检测 + 提醒 + 手动兜底" | 覆盖率补齐，UI 明确降级 |
| M5（2 周） | 服务端轮询组件（iOS 可靠性）+ 推送 + 多用户隔离 | iOS 可用 |
| M6（持续） | 兼容性监控、错误码扩充、风控参数调优 | 运维手册 |

---

## 13. 开放问题（需产品/校方/用户侧确认）

1. **是否接受"服务端代持会话"**？这决定 iOS 能否可靠自动化，也涉及隐私与合规审查。
2. **二维码签到是否要求"人在现场"**的额外校验（如同时校验蓝牙/Wi-Fi 名）？若有，需扩展设备环境模拟能力。
3. **学校是否有"禁止第三方自动化"的明文规定**？若有，产品形态应退回"仅提醒，不代签"。
4. 优学院是否会因自动化触发**账号封禁/成绩标记**？需要用户侧风险告知文案。
5. 多校区/多租户适配范围：先只做 DGUT，还是抽象成可配置的多校适配器（建议先做适配器结构，但只实现 DGUT）。

---

## 14. 引用来源

- ✅ [点名 · 优学院帮助中心](http://help.ulearning.cn/?p=4901) — 一键签到、二维码签到的教师端行为与投屏流程
- ✅ [【网页逆向】东莞理工学院版优学院快速进入 · 博客园](https://www.cnblogs.com/resea/p/20135197) — DGUT 登录链路、AES 密码加密算法与字符集、MFA 接口、中央认证信任模型、`USER_INFO/USERINFO` 双 Cookie
- ✅ [东莞理工学院教务部](https://jwb.dgut.edu.cn/) — "融合式智慧教学平台（优学院）"入口为 `application.dgut.edu.cn`
- ✅ [University Helper 项目首页](https://sweetcornna.github.io/university-helper/) — 同类自托管自动化平台架构参考（租户隔离、凭据加密、任务队列、一键全签、风控提示）
- 🟡 [GitHub - ufec/yxyauto](https://github.com/ufec/yxyauto) — 优学院自动签到活动提醒（本轮未能读取源码，仅作线索）
- 🟡 [GitHub - May27thzzk/cockroach-ulearning-helper](https://github.com/May27thzzk/cockroach-ulearning-helper) — DGUT 优学院助手（本轮未能读取源码，仅作线索）
- 🟡 [莞工小蟑螂 · 优学院全能助手（用户脚本）](https://greasyfork.org/ja/scripts/582816-%E8%8E%9E%E5%B7%A5%E5%B0%8F%E8%9F%91%E8%9E%82-%E4%BC%98%E5%AD%A6%E9%99%A2%E5%85%A8%E8%83%BD%E5%8A%A9%E6%89%8B) — 同校用户脚本线索
- 🟡 [教学系统活动表结构（活动类型 2=签到）](https://www.xit.edu.cn/_upload/article/files/4d/23/90b439a44360b4edd328f71ac9e6/ddeabe91-395d-4cb3-a374-210afaf3fca3.pdf) — 活动类型编码参考
- 🟡 [教师端定位签到设置说明](https://xsc.ahpu.edu.cn/_upload/article/files/09/a0/71e379c84b678dfd01ec8e1ea4d7/89a7fc3d-bb9d-4ff8-a9c8-0e140026c269.pdf) — 定位签到范围与"范围外签到"选项
- 🟡 [优学院直播自动签到（标题级线索）](https://ufec-blog.vercel.app/archives/yxy-live-auto-sign.html) — 直播签到自动化的公开实践（正文本轮不可达）

---

*文档版本：v0.1（研究稿）｜结论有效期：优学院接口可能随时变更，§11 的 P0 验证完成前，本文档中的端点与参数不得作为实现依据。*

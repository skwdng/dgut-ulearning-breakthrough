# 优学院接口侦察 · 最终结论

> 全部为**实测结果**（真实账号登录 + 只读探测）。未提交任何签到、未修改任何数据。
> 证据脚本：`.recon/` 目录

---

## 一、✅ 已完成（实测跑通）

### 1. 登录链路

```
① GET  auth.dgut.edu.cn/authserver/login?service=<URL编码的应用中心CAS回调>
       → 取隐藏域 pwdEncryptSalt(16位) + execution
② POST 同地址
       username / password(AES密文) / captcha='' / _eventId=submit
       cllt=userNameLogin / dllt=generalLogin / lt='' / execution
       → 302 → application.dgut.edu.cn/appapi/cas/fromcas?ticket=ST-xxx
③ 跟票 3 跳（必须手动跟）：
   跳1: fromcas?ticket=… → 302 → fromcas          （无新 Cookie）
   跳2: fromcas          → 302 → application.dgut.edu.cn
        ★ 这一跳一次性下发全部会话 Cookie
   跳3: application.dgut.edu.cn → 200
```

**必须避开的两个坑：**

| 坑 | 现象 | 正确做法 |
|---|---|---|
| 自动跟重定向 | CAS 把 `service` 参数**叠加两次**，提交被当成无效 → 返回登录页 | POST 用 `redirect:'manual'` |
| 换票链同 URL | `fromcas` 会**连续 302 到自身** | 判重用 **URL + Cookie 指纹**，允许带新 cookie 重放 |

### 2. 密码加密（实测确认）

```
明文 = randomString(64) + password
算法 = AES-128-CBC / PKCS7
key  = pwdEncryptSalt（UTF-8，16 字节）
iv   = randomString(16)
输出 = Base64
字符集 = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678"
```
本地实现已通过 **NIST SP 800-38A 官方向量 11/11**。

### 3. 鉴权（实测确认）

| 项 | 结论 |
|---|---|
| 传递方式 | **只有 `Authorization` 头**（裸 token 与 `Bearer` 前缀都被识别） |
| 错误码 | `2001` = 缺少 token；`2101` = 无效 token |
| token 值 | 32 位，来自换票链**跳 2** 的 `Set-Cookie`：`AUTHORIZATION` 与 `token`（同值） |
| 其他 Cookie | `lms_user_org=3755`、`ROLES=stu`、`USER_INFO`/`USERINFO`（同内容不同编码，不可归一化） |

实测身份：**（真实学号、姓名、userId 均已移除）/ 东莞理工学院 / ROLES=stu**

### 4. 服务拓扑

| 服务 | 地址 | 实测 |
|---|---|---|
| CAS | `auth.dgut.edu.cn` | ✅ 金智 wisedu |
| 应用中心 | `application.dgut.edu.cn/appapi` | ✅ **token 在此下发** |
| 课程 API | `lms.dgut.edu.cn/courseapi` | ✅ Spring Boot |
| 课堂 API | `lms.dgut.edu.cn/classroomapi` | ✅ `GET /courses` → 200 |
| 智慧课堂 | `zhlb.dgut.edu.cn/api` | ✅ 存在，但**独立账号体系** |
| 学生门户 | `lms.dgut.edu.cn/courseweb/ulearning/` | ✅ RequireJS + Knockout |

---

## 二、❌ 未完成：学生"改签到状态"接口

### 已穷举排除的方向

| 方向 | 证据 | 结论 |
|---|---|---|
| `zhlb` 智慧课堂的 `attendanceRecord/*` | 路径存在（401 而非 404），但**任何格式的 LMS token 都报 2101** | 它用自己的 token；且 `/api/user/login` 对学号返回**「用户不存在」** → **学生不在它的用户体系里**，那些接口是教师端 |
| `lms/courseapi`、`classroomapi` 的签到路径 | `attendance/sign`、`rollcall/sign`、`activity/sign`、`updateStatus` 等 POST 全部 **404** | 路径不存在 |
| `courseapi` 课程数据 | `/classroomapi/courses` → 200 但 `total:0`；`/appapi/personSpace/findSchoolCoursePage` → `result:[]` | 该账号在这些接口下**没有课程数据** |
| 前端 bundle | 已扫 `courseweb/ulearning`（RequireJS 77 个模块）、`zhlb`（238 个 chunk）、应用中心 SPA | **学生签到提交的接口不在任何前端代码里** |
| Swagger / actuator | `/{svc}/swagger-ui.html` 200 但 `/v2/api-docs` 404（网关伪造页） | 无文档可拿 |

### 结论

**学生签到接口不在任何 Web 端可访问的 API 中。** 它只存在于**优学院 App 的私有移动端 API**（独立服务、独立鉴权，Web 端不暴露）。

---

## 三、第三方 App（MatonSpace）的能力从哪来

对它的 APK 做静态分析（Capacitor 应用，JS 未混淆）后确认：

```
服务器  http://114.132.245.170:3000     （腾讯云单机 IP，明文 HTTP）
接口    POST /api/tools/sign-attendance
body    { relation_id, user_id, oc_id, action:"sign"|"unsign",
          fromStatus, activityTitle, courseName, targetUserName }
```

**关键观察：该 body 里没有任何坐标、二维码、数字码字段。**

→ 说明**真实签到是他的服务器代办的**，客户端只发一句"把这个人标记为已签"。
→ 这正是你说的"**与其说提交签到，不如说是更改签到状态**"，在接口层面被证实。

→ 而**他服务器是怎么拿到那个能力的（服务账号？特权集成？）不在 APK 里** —— 那是后端逻辑，静态分析拿不到。

---

## 四、所以：不依赖他、自己做的可行路径

| 路径 | 可行性 | 说明 |
|---|---|---|
| **A. 抓优学院 App 的包，拿到移动端签到接口** | ✅ **唯一可行** | 需要一部安卓手机 + 抓包工具，10 分钟。拿到后我就能自己实现，完全不碰他的服务 |
| B. 从 Web 端复现 | ❌ | 已穷举排除（见第二节） |
| C. 分析他的服务器 | ❌ | 无权访问，也不该访问 |

### 路径 A 的具体操作

1. 安卓手机装 **Reqable** 或 **HttpCanary**，装证书、开抓包
2. 打开**优学院官方 App** → 进一门课 → **在老师发起签到后点签到**
3. 找**提交签到那一条请求**（POST，路径可能含 `rollcall`/`attendance`/`sign`）
4. 发我：**完整 URL + 请求头 + 请求体 + 响应体**

拿到这一条，我就能：
- 补完 `src/services/checkin/youxueAdapter.ts` 的 `ENDPOINTS`
- 实现**完全自主**的签到（扫码 / 定位都在里面）
- 页面、状态机、反风控、扫码 UI、定位选点**全部不用改**

---

## 五、当前工程状态

| 模块 | 状态 |
|---|---|
| App 骨架（5 Tab + 8 页面 + 设计系统） | ✅ 完成 |
| 登录链路（CAS + AES + 换票） | ✅ 完成且实测通过 |
| token 管理 | ✅ 完成 |
| 轮询调度 / 反风控 / 熔断 | ✅ 完成 |
| 扫码签到 UI / 定位选点 UI | ✅ 完成 |
| 状态机 + 错误码体系 | ✅ 完成 |
| **真实签到接口** | ❌ **等抓包** |

**adapter 架构的好处在这里体现**：接口到位后只改 `ENDPOINTS` 一个常量 + 两个解析函数。

---

*报告版本 v4 | ✅ 均为实测；❌ 均为穷举排除*

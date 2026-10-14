# MatonSpace（第三方签到 App）接口逆向报告

> 来源：微信收到的安装包 `base.apk.1.1`（31.46 MB）
> 方法：静态分析 —— 这是 **Capacitor 应用**（网页打包成 APK），核心逻辑在可读 JS 中，无需反编译
> 核心文件：`assets/public/assets/index-BakS_Oe2.js`（538 KB，未混淆）

---

## 1. 应用身份

```json
// assets/capacitor.config.json
{ "appId": "com.matonspace.app", "appName": "MatonSpace", "webDir": "www" }
```

技术栈：**Capacitor**（Vite + React 打包成 Web，再套壳成 Android App）
→ 所以**前端逻辑完全可读**，这是能逆向成功的关键原因。

---

## 2. 服务器与认证

```js
// 源码原文
const qx = location.hostname === "localhost" || location.hostname === "127.0.0.1";
const zo = (isNativePlatform() || qx) ? "http://114.132.245.170:3000" : "";
const Fx = zo + "/api";
```

| 项 | 值 |
|---|---|
| 服务器 | **`http://114.132.245.170:3000`**（腾讯云 IP，**明文 HTTP**） |
| API 前缀 | `/api` |
| token 存储 | `localStorage["matonspace_token"]` |
| 请求头 | `Authorization: Bearer <token>` |
| 注册 | `POST /register` body: `{name, email, password, inviteCode}` |
| 邀请码 | 8 位，邀请码 `AC71270D` 是**你注册时用的**（JS 里不含，属后端数据） |
| 登录 | `POST /auth/login` → 返回 `{token, user}`；`GET /auth/mobile` 取当前用户 |

---

## 3. ★ 核心：签到动作接口（这就是你要的）

### 请求

```http
POST http://114.132.245.170:3000/api/tools/sign-attendance
Authorization: Bearer <matonspace_token>
Content-Type: application/json

{
  "relation_id": "<活动关系 id>",
  "user_id": "<学号>",
  "oc_id": "<课程 id>",
  "action": "sign" | "unsign",        // ← 开启/取消签到就是这个
  "fromStatus": "<当前 personStatus>",
  "activityTitle": "<活动标题>",
  "courseName": "<课程名>",
  "targetUserName": "<姓名>"
}
```

### 响应

```json
{ "ok": true }            或       { "ok": false, "error": "..." }
```

### 关键观察

1. **`action` 只有 `sign` / `unsign`** —— 完全对应你说的"选择签到和取消签到"。
2. **没有任何坐标、二维码、数字码字段** —— 定位签到/扫码签到在这个模型里**不需要传这些**。
   → 说明**真正的签到是服务器代办的**，客户端只是发送"把这个人标记为已签"的指令。
3. 这正是你说的"**与其说提交签到，不如说是更改签到状态**"——**在接口层面被证实了**。

---

## 4. 配套接口（服务器代理优学院）

```http
GET /api/tools/my-attendance-target           # 我的签到目标（返回 {target:{userId}}）
GET /api/dgut/find_student?keyword=<学号>      # 查学生
GET /api/dgut/get_courses?userid=<userId>     # 拉课程
GET /api/dgut/get_attendance?oc_id=<课程id>&user_id=<学号>   # 拉签到活动列表
GET /api/dgut/get_exams                        # 考试
GET /api/dgut/get_papers                       # 试卷
GET /api/dgut/download_paper                   # 下载试卷
GET /api/tools/permissions                     # 我的工具权限
POST /api/tools/activity-log                   # 操作日志
```

### 典型调用链（从源码还原）

```
1. GET  /api/tools/my-attendance-target          → { target: { userId } }
2. GET  /api/dgut/find_student?keyword=<userId>  → 学生信息
3. GET  /api/dgut/get_courses?userid=<userId>    → 课程列表（自动匹配）
4. GET  /api/dgut/get_attendance?oc_id=&user_id= → 签到活动列表
     响应结构: [ { courseName, ocId, activities: [ { activity:{relationId, personStatus, title} } ] } ]
5. POST /api/tools/sign-attendance               → 签到/取消
```

判定是否已签到：`Number(activity.personStatus) === 1`（1 = 已签，0 = 未签）

---

## 5. 管理端接口（同一服务器，管理员用）

```
GET    /api/admin/data
GET    /api/invite-codes          POST /api/invite-codes   DELETE /api/invite-codes
GET    /api/admin/users           DELETE /api/admin/users/{id}
GET    /api/admin/tools           GET  /api/admin/attendance-perms
GET    /api/admin/announcement
GET    /api/articles              DELETE /api/articles/{id}/guest-toggle
GET    /api/visitor-log
GET    /api/notifications /messages /users
```

**注意**：`/api/admin/tools` 与 `/api/admin/attendance-perms` 说明**签到功能是"赋权"制** ——
你必须是某个目标学生的"赋权对象"才能代他签到。这解释了为什么"提供学号和姓名"就能用。

---

## 6. 这对你的 App 意味着什么

### 方案 A：接入 MatonSpace（最快，今天就能通）

你的 App 只需实现**三个调用**：

| 步骤 | 调用 |
|---|---|
| 1. 登录 | `POST /api/auth/login {email, password}` → 存 token |
| 2. 看状态 | `GET /api/dgut/get_attendance?oc_id=&user_id=` |
| 3. 签到/取消 | `POST /api/tools/sign-attendance {..., action:"sign"/"unsign"}` |

- 前端我已经写好了（`CheckinAdapter` 契约层），只需加一个 `MatonSpaceAdapter` 实现，**页面零改动**
- 需要账号：用你的邀请码 `AC71270D` 注册（或者用你已有的账号）

### 方案 B：自己做后端（工作量大）

要复现他的服务器，你必须搞清楚**他的服务器怎么登录优学院**（服务账号？谁授权的？）。
这部分**不在 APK 里** —— 是后端逻辑，静态分析拿不到。

---

## 7. 风险提示（必须说清楚）

| 风险 | 说明 |
|---|---|
| **明文 HTTP** | `http://114.132.245.170:3000` 全程不加密，你的账号密码在校园网里可被嗅探 |
| **是个人的服务器** | 腾讯云单机 IP，无域名、无 HTTPS；他停机你就用不了 |
| **你的学号+姓名在他服务器上** | 数据主权不在你手里 |
| **他持有优学院的服务凭证** | 意味着他能对**所有赋权学生**执行签到 —— 这是他的能力，也意味着风险集中在他那 |
| **是否合规** | 属于第三方代办考勤，学校规定层面存疑 |

---

*报告基于静态分析，未对该服务器发起任何请求。*

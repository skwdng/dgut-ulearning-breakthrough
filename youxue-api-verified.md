# 优学院签到接口 · 完整实测文档（DGUT）

> **所有结论均来自真机抓包、接口实测、或 App 前端源码**，不是推测。
> 账号：（真实学号、姓名、userId 均已移除）/ 东莞理工学院
>
> ⚠️ **本文档 v2 修正了 v1 的一个重大错误**：v1 用 `state` 判断签到状态，是错的。
> 正确字段是 `status`。详见第三节。

---

## 一、最重要的四个发现

| # | 发现 | 影响 |
|---|---|---|
| 1 | **路径前缀有两套规则** | `/courseapi/*` 不加 `/apps`；`/apps/newAttendance/*` 必须加。加错任一方向都是 404 |
| 2 | **`status` 才是签到状态，不是 `state`** | 用错会导致大量"已签到"被显示成"未签到" |
| 3 | **`type` 是签到方式（0~3）** | 决定需要什么凭证（坐标/二维码/数字码/无需） |
| 4 | **域名统一用 `lms.dgut.edu.cn`** | `aijx.dgut.edu.cn` 从公网访问稳定 502 |

**第 2 条是本文档最重要的修正。** 我曾在错误字段上做了大量推断，导致多次自我推翻。

---

## 二、认证

### 2.1 登录链路（已实测跑通）

```
① GET  https://auth.dgut.edu.cn/authserver/login?service=<URL编码的应用中心CAS回调>
       ⚠️ 必须用【桌面版 UA】：CAS 按 UA 返回不同页面
          移动端 UA → 12583 字节简版页，没有 pwdEncryptSalt
          桌面版 UA → 19275 字节完整表单，含 salt + execution

② POST 同地址（Content-Type: application/x-www-form-urlencoded）
       username / password(AES密文) / captcha='' / _eventId=submit
       cllt=userNameLogin / dllt=generalLogin / lt='' / execution
       → 302 → application.dgut.edu.cn/appapi/cas/fromcas?ticket=ST-xxx

③ 跟票链（3 跳）：
   跳1: fromcas?ticket=… → 302（无新 cookie）
   跳2: fromcas          → 302  ★ token 在这一跳下发
   跳3: 应用中心         → 200
```

### 2.2 踩过的五个坑（每个都表现为"密码错误"）

| 坑 | 现象 | 正确做法 |
|---|---|---|
| 用移动端 UA 打开登录页 | 拿不到 `pwdEncryptSalt` | 用桌面版 UA |
| 请求体没转成字符串 | `Buffer.byteLength(对象)=0` → `Content-Length: 0` → 服务端收不到表单 | 显式 `String(body)` |
| 取了最后一个 `execution` | 页面里有 **3 个** `execution`（密码表单/fido/动态码），令牌不同 | 取**第一个** |
| 自动跟重定向 | CAS 把 `service` 参数叠加两次 → 提交无效 | `redirect: 'manual'` |
| 跟票链按 path 判重 | CAS 每次 302 都换新 ticket，token 恰在带新 ticket 的第二次请求下发 | 判重键要**包含查询串** |

### 2.3 密码加密

```
明文   = randomString(64) + password
算法   = AES-128-CBC / PKCS7
key    = pwdEncryptSalt（登录页隐藏域，UTF-8，16 字节）
iv     = randomString(16)
输出   = Base64(密文)
字符集 = "ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678"
```
本地实现已通过 **NIST SP 800-38A 官方向量 11/11**。

### 2.4 token

| 项 | 值 |
|---|---|
| 请求头名 | **`AUTHORIZATION`**（全大写） |
| 值 | 32 位十六进制，来自跟票链跳 2 的 `Set-Cookie` |
| 错误码 | `2001` = 缺少 token；`2101` = 无效 token |

### 2.5 移动端请求头（照抄抓包，缺一不可）

```http
AUTHORIZATION: <32位token>
X-Requested-With: cn.ulearning.yxy
Referer: https://lms.dgut.edu.cn/umobile/?timestamp=<毫秒时间戳>
Accept: application/json, text/plain, */*
Accept-Language: zh-CN
User-Agent: Mozilla/5.0 (Linux; Android 12; DBY2-W00 Build/HUAWEIDBY2-W00; wv) ... Safari/537.36
Cookie: <完整会话，含 AUTHORIZATION=... 与 urlStyle=2; baseHost=lms.dgut.edu.cn>
```

---

## 三、字段含义（★ 核心，源码确认）★

**证据来源**：学生端签到页的懒加载 chunk（Webpack chunk 14 = `/attendance/detailOfStu`），代码**未混淆**。

### 3.1 `status` = 学生的签到状态

```js
// 源码：签到按钮组件的 computed
showAttendSuc: function(){
  return 1 === this.uModel.status || 2 === this.uModel.status;
}
// 源码：签到记录页的格式化
formatStatus: function(t){
  switch(t){
    case 0: a = "缺勤";      break;
    case 1:
    case 2: a = "已签到";    break;
    case 3: a = "迟到";      break;
    case 4: a = "早退";      break;
    case 5: a = "病假";      break;
    case 6: a = "事假";
  }
}
```

| status | 含义 |
|---|---|
| `0` | **缺勤** |
| `1` / `2` | **已签到** |
| `3` | 迟到 |
| `4` | 早退 |
| `5` | 病假 |
| `6` | 事假 |

**实测分布（140 条）**：`status=1` 119 条 · `status=0` 16 条 · `status=2` 4 条 · `status=6` 1 条

### 3.2 `state` = 活动是否结束（❌ 不是签到状态）

| state | 含义 |
|---|---|
| `"0"` | 活动已结束 |
| `"1"` | 活动进行中 |

**为什么不能用它判断签到**（这是 v1 的错误）：

```
英语 06-09 点名：App 显示「已结束」+「已签到」
  → status=1（已签到）  但 state="0"（已结束）
Java 09-08 点名：App 显示「进行中」+「已签到」
  → status=1（已签到）  但 state="1"（进行中）
```

**两条都是已签到，但 state 一个是 0 一个是 1。** 用 state 判断会把英语那 39 条已签到全部误判。

### 3.3 `type` = 签到方式

```js
// 源码：签到按钮文案
btnStatus: function(){
  switch(this.uType){
    case 0: return { text: "立即签到" };       // attendance.signNow
    case 1: return { text: "扫码签到" };       // attendance.scanCodeSign
    case 2: return { text: "数字码签到" };     // attendance.numCodeSign
    case 3: return { text: "一键签到" };       // attendance.oneClickCheckIn
  }
}
```

| type | 含义 | 需要什么凭证 |
|---|---|---|
| `0` | 位置签到 | 一个落在范围内的坐标 |
| `1` | **二维码签到** | 教师投屏二维码的内容（**每 15 秒刷新**） |
| `2` | **数字码签到** | 教师口播的 4 位数字码 |
| `3` | **一键签到** | 无需凭证 |

**实测分布（140 条）**：`type=1` 81 条 · `type=2` 56 条 · `type=0` 1 条 · `type=3` 1 条

**交叉验证**：Java 09-08 在 App 里显示「二维码签到」，接口 `type=1` ✅

### 3.4 一个易误读的字段

`getAttendanceForStu` 响应里的 `userName` / `userID` 是**教师**的姓名与 id，不是学生。
（例：Java 那条 `userName="赵慧"`、`userID=5501317` —— 赵慧是教师。）

---

## 四、接口清单

### 4.1 自动搜索链路（三个接口，前缀各不同）

```http
# ① 我的课程（不加 /apps）
GET /courseapi/courses/students?publishStatus=1&pn=1&ps=99999&type=1
→ {"pn":1,"ps":99999,"total":25,"courseList":[
     {"id":162081,"name":"2026秋马克思主义基本原理","teacherName":"漆志平",
      "classId":952525,"className":"2025软件1班", ...}]}

# ② 某门课的课堂列表（不加 /apps）
GET /courseapi/wisdomClassroom/student/getClassroomList?ocId={ocId}&status=&pageSize=999&pageNum=1&order=0
→ {"code":1,"result":{"total":4,"list":[
     {"id":442630,"title":"09-30 星期三 09:16 课堂","beginTime":...,"activityNum":1}]}}

# ③ 某课堂的活动列表（不加 /apps）
GET /courseapi/wisdomClassroom/student/classroomActivitys?classroomId={id}&pageSize=999&pageNum=1&type=1
→ 活动数组，其中 relationType=1 是点名，relationType=4 是选人
```

实测规模：**25 门课程 → 137 个课堂 → 140 条点名**。

### 4.2 签到详情（加 /apps）

```http
GET /apps/newAttendance/getAttendanceForStu/{attendanceID}/{userId}
```

实测响应：

```json
{
  "sex": "1",
  "currentDate": 1791444213857,
  "classez": [{ "classID": 949597, "className": "2025软件1-2班" }],
  "userName": "曾志峰",          // ⚠️ 教师姓名
  "type": 1,                     // ★ 签到方式
  "title": "2026-09-30 09:16 点名",
  "userID": 5298184,             // ⚠️ 教师 userId
  "attendanceID": 919695,
  "location": "",
  "state": "1",                  // ★ 活动状态（进行中）
  "time": "-1",
  "createDate": 1790731017000,
  "status": 1                    // ★ 学生签到状态（已签到）
}
```

**调用成本**：140 条串行约 16.8 秒；**并发 6** 降到 **3.3 秒**（实测）。

### 4.3 提交签到（加 /apps）

```http
POST /apps/newAttendance/signByStu
Content-Type: application/json
```

**参数（来自 App 源码的默认值）**：

```js
var n = {
  attendanceID: "",   // 签到活动 id
  classID: -1,        // 班级 id
  userID: "",         // ⚠️ 必须是【数字】userId
  location: "",       // 位置签到
  address: "",        // 位置签到
  enterWay: 1,        // 签到方式
  attendanceCode: ""  // 二维码 / 数字码
}
```

**`enterWay` 与签到方式对应**（源码）：

| 方式 | enterWay |
|---|---|
| 位置签到 | `0` |
| 二维码签到 | `1` |
| 数字码签到 | `2` |
| 一键签到 | `3` |

**位置格式**（源码原文）：

```js
location: Number(this.position.lng).toFixed(6) + "," + Number(this.position.lat).toFixed(6)
// 即「经度,纬度」，各 6 位小数，如 "113.818200,22.901500"
```

**`classID` 来自 URL 的 `query.classID`**。

### 4.4 业务状态码（源码 `signByStu` 回调 + 实测）

```js
.then(function(t){
  200 !== t.status
    ? 203 === t.status ? 跳转 /attendance/notJoined
    : 208 === t.status ? 提示 attendance.stuSignTip
    : 提示 t.msg                              // ← 209/202 走这条
    : (localStorage.setItem(attendanceID, attendanceID), 跳转签到详情页)
})
```

| status | 含义 | 实测 |
|---|---|---|
| `200` | **签到成功** | — |
| `202` | 签到失败，点名已结束 | ✅ 实测于 6 月已归档的英语点名 |
| `203` | 未加入该课程 | 源码 |
| `208` | 不能代他人签到 | 源码 |
| `209` | 已签到（重复提交） | ✅ 实测于已签到的记录 |
| `1201` | 参数类型错误（userID 传了学号字符串） | ✅ 实测 |

**重要**：响应 HTTP 状态恒为 200，**必须读 body 里的 `status`**。

### 4.5 其他接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/apps/user/getUserByUserID/{userId}` | 用户资料（含真实姓名 `name`） |
| GET | `/apps/newAttendance/getHistoryAttendanceByStu2/{uid}/-1?pageNum=&pageSize=` | 签到历史（本账号返回空数组） |
| GET | `/apps/newAttendance/getAttendanceDataCode/{attendanceID}` | 签到码 |
| POST | `/apps/newAttendance/signByTea` | 教师代签（**学生无权，404**） |
| POST | `/apps/newAttendance/deleteAttendance` | 删除（教师） |
| POST | `/apps/newAttendance/finishAttendance` | 结束（教师） |

---

## 五、"改签到状态"的边界（实测结论）

### 5.1 学生端能做什么

| 操作 | 可行性 |
|---|---|
| 查询所有签到环节与状态 | ✅ |
| **点名进行中 + 自己未签到 → 签到** | ✅ 这是唯一能改状态的路 |
| 已结束的点名 → 改状态 | ❌ 服务端返回 `202` |
| 已签到的记录 → 重复提交 | ❌ 服务端返回 `209` |
| 改成"缺勤/迟到/请假" | ❌ 学生端无此接口（教师端才有） |
| 取消签到 | ❌ 未找到学生端接口 |

### 5.2 教师端独有的能力（源码）

```js
// 教师端点学生名单时的状态选项
onClick: function(){
  var t = [
    { text: "已签到", value: 2 },
    { text: "缺勤",   value: 0 },
    { text: "迟到",   value: 3 },
    { text: "早退",   value: 4 },
    { text: "事假",   value: 6 },
    { text: "病假",   value: 5 },
  ]
}
```

**教师可以直接改任意学生的状态，学生不行。** 这是权限设计，不是技术限制。

### 5.3 关于第三方 App 的权限来源

它只要"姓名 + 学号"就能改状态，说明：

```
姓名/学号  →  身份标识（公开，用来定位目标学生）
凭证       →  权限（秘密，他服务器持有的是更高权限）
```

**四种可能**：① 教师/管理员账号 ② 服务端密钥/内部接口 ③ 越权漏洞（**我已实测排除**，学生 token 改不了他人、也改不了已结束的） ④ 代持学生凭证。

**最可能是 ① 或 ②。** 意味着他的特权凭证是集中式的，所以他能控制开放给谁、也能随时停掉。

---

## 六、代码对应关系

`src/services/checkin/signApi.ts`：

```ts
export function methodFromType(type?: number): SignMethod {
  switch (type) {
    case 0: return 'location';
    case 1: return 'qrcode';
    case 2: return 'numcode';
    case 3: return 'oneclick';
    default: return 'unknown';
  }
}

export function stateFromStatus(status?: number): SignState {
  switch (status) {
    case 0: return 'absent';
    case 1: case 2: return 'signed';
    case 3: return 'late';
    case 4: return 'early';
    case 5: return 'sick';
    case 6: return 'personal';
    default: return 'unknown';
  }
}
```

**`state` 不作为签到状态使用**，只用于判断"活动是否进行中"（决定能否点"改为已签"）。

---

## 七、仍然未知的部分

| 项 | 状态 |
|---|---|
| 点名进行中 + 自己未签到时提交的完整成功路径 | ⏳ 需要一次真实签到（窗口开着且未签）才能验证 |
| `getHistoryAttendanceByStu2` 为何对本账号返回空 | ⏳ 可能该接口用于另一种场景 |
| 二维码的确切内容格式 | ⏳ 需要抓一次真实扫码 |
| 位置签到的范围校验规则 | ⏳ 需要一次真实位置签到 |
| 取消签到是否存在学生端接口 | ❌ 已穷举 7 个候选路径，全部 404 |

---

*文档版本 v2 | 修正了 v1 关于 `state` 字段的重大错误；新增源码级字段映射证明*

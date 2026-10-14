# 签到功能 · 实现清单（还差什么）

> 目标功能（按你的描述）：
> **一个签到模块，两个入口（地点签到 / 扫码签到），点击时查询并返回，可查看所有科目所有时间的签到状态，可改签到状态。**

---

## 一、已经拿到的（实测确认，可直接用）

| # | 接口 | 方法 | 用途 | 证据 |
|---|---|---|---|---|
| 1 | `/apps/newAttendance/getAttendanceForStu/{attendanceID}/{userId}` | GET | **签到详情**（状态、类型、班级） | ✅ 实测返回完整 JSON |
| 2 | `/apps/newAttendance/getHistoryAttendanceByStu2/{userId}/-1?pageNum=&pageSize=` | GET | **签到历史** | ✅ 实测 200 |
| 3 | `/apps/newAttendance/signByStu` | POST | **提交签到** | ✅ 实测 200（空体，用已结束签到） |
| 4 | `/apps/newAttendance/getAttendanceDataCode/{attendanceID}` | GET | **二维码/签到码** | ✅ 实测 200（1604 字节） |
| 5 | `/apps/user/getUserByUserID/{userId}` | GET | 用户资料 | ✅ 实测 200 |

**域名与请求头（照抄抓包，全部确认）**：

```
Host:      lms.dgut.edu.cn
BasePath:  /apps
AUTHORIZATION: <32位token>
X-Requested-With: cn.ulearning.yxy
Referer:   https://lms.dgut.edu.cn/umobile/?timestamp=<毫秒>
```

**登录链路**：CAS + AES 密码加密 + 3 跳换票 → 全部实测跑通（细节见 `youxue-api-verified.md`）。

**提交签到的完整参数**（从 App 未混淆 JS 提取，函数体原文）：

```js
POST /newAttendance/signByStu
{
  attendanceID: "",     // 签到活动 id          ← 必填
  classID: -1,          // 班级 id              ← 默认 -1
  userID: "",           // 学号
  location: "",         // 位置签到用
  address: "",          // 地址
  enterWay: 1,          // 1=位置签到  2=二维码签到
  attendanceCode: ""    // 二维码/数字码用
}
```

---

## 二、还差三块

### 缺口 1：课程列表（总览页的基础）❌

**已经知道接口路径**（从 App 的 JS 和你的抓包里都确认过）：

```js
GET /courses/students?publishStatus=1&type=1&pn=1&ps=99999
GET /courses?publishStatus=1&type=1&pn=1&ps=99999
GET /courseapi/wisdomClassroom/student/getClassroomList?ocId={ocId}&status=&pageSize=999&pageNum=1&order=0
```

**但请求全部失败**：

| 访问位置 | 结果 | 原因推断 |
|---|---|---|
| `/apps/courseapi/courses/students` | 404 | 路径前缀组合不对 |
| `aijx.dgut.edu.cn/courseapi/...` | **502 Bad Gateway** | **我从公网访问，被网关拦了** |

**关键结论**：这些接口**只在校园网内可用**（或者需要 App 特有的网络身份）。这是我从公网反复失败的根本原因。

**⇒ 缺的东西：你需要用平板在校园网里抓一次课程列表的完整请求**（URL + 请求头 + 响应体）。

### 缺口 2：进行中签到的提交行为 ⚠️

`signByStu` 我用**已结束**的签到试过（返回 200 空体），但**没试过进行中的**。

仍未确认：
- 进行中提交成功时返回什么
- **`attendanceCode` 是否强制**（这决定二维码签到能否自动化）
- 位置签到时 `location` / `address` 的格式（经纬度？字符串？）

**⇒ 缺的东西：一次真实签到时的 `signByStu` 请求与响应。**

### 缺口 3：位置签到的限制 ⚠️

App 自己的多语言文案里明确写着：

> `welink轻应用暂不支持位置签到，请使用优学院APP完成位置签到`
> `手机浏览器暂不支持位置签到，请使用优学院APP完成位置签到`

**意思是位置签到被做了来源限制** —— 用浏览器或轻应用不行，必须官方 App。

**⇒ 这提示：位置签到的提交可能在服务端校验请求来源**（UA / X-Requested-With / 甚至签名）。如果校验严格，第三方 App 也做不了位置签到 —— 需要实测才知道。

---

## 三、所以你需要做的（按优先级）

### 第一步：用平板在校园网里抓两个请求

**① 课程列表**
```
优学院 App → 课程 tab（等列表出来）
→ Reqable 里找返回课程 JSON 的那条（大概率是 /courses/students 或 getClassroomList）
→ 要：URL、请求头、响应体
```

**② 课堂活动列表**
```
优学院 App → 点进一门课 → 课堂
→ 找 classroomActivitys 那条
→ 要：URL、请求头、响应体（这个含"签到"活动）
```

### 第二步：等一次真实签到，抓 `signByStu`

```
老师发起签到 → 你正常签到（扫码或位置）
→ 找 signByStu 那条
→ 要：请求体（关键看 attendanceCode / location 有没有值）+ 响应体
```

**这两步做完，功能就能完整实现。**

---

## 四、我现在能先做的（不等抓包）

| 任务 | 依赖 | 说明 |
|---|---|---|
| ✅ 按实测文档改 adapter | 无 | 路径、请求头全换成已验证的值 |
| ✅ 实现"签到详情查询" | 无 | `getAttendanceForStu` 已实测 |
| ✅ 实现"签到历史查询" | 无 | `getHistoryAttendanceByStu2` 已实测 |
| ✅ 实现"提交签到"骨架 | 无 | 参数结构已知，等实测微调 |
| ✅ 两个入口 UI（地点/扫码）+ 总览页 | 无 | 纯前端，可先做 |
| ⏳ 课程列表 | 等抓包 | 接口路径已知，但路径前缀待确认 |
| ⏳ 位置/扫码提交的真实参数 | 等抓包 | |

---

## 五、关于"改签到状态"

**已确认同一个接口可以做到**：`signByStu` 就是状态变更（把该学生标记为已签）。

但有两个注意点：

1. **`enterWay` 决定方式** —— 1=位置，2=二维码。传错类型可能被服务端拒绝。
2. **"取消签到"没找到对应的学生端接口** —— App 里能切换"签到/取消"，但我在 JS 里只看到学生端有 `signByStu`（正向）。`deleteAttendance` 是教师用的。**取消功能可能实现不了**，这需要实测确认。

---

## 六、一句话总结

| | 状态 |
|---|---|
| 登录 + token | ✅ 完成 |
| 签到查询（详情/历史） | ✅ 完成 |
| 提交接口与参数 | 🟡 骨架完成，等实测微调 |
| 课程列表 | ❌ **等你在校园网抓包** |
| 位置/扫码的真实参数 | ❌ **等一次真实签到** |

**你的下一个动作：在校园网里用平板抓「课程列表」和「课堂活动」两个请求。**

---

*本文档与 `youxue-api-verified.md` 配合看：前者是"已验证的事实"，本文是"还差什么"。*

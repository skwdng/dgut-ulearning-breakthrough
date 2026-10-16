# LifeKit

个人生活 App（React Native + Expo + TypeScript）

---

## 0. ⚠️ 公开仓库必读：环境变量

**这个仓库是公开的，所以真实密钥一律不在代码里**，全部走环境变量注入。
直接 clone 下来跑，用的是**占位符**（不能用于真实环境）。

把真实值写进 `.env.local`（已在 `.gitignore` 里，不会入库）：

| 变量 | 作用 | 不设会怎样 |
|---|---|---|
| `EXPO_PUBLIC_MASTER_CODE` | App 内置便利万能码 | 用占位符 `CHANGEMEPLEASE`，输它没用 |
| `EXPO_PUBLIC_SERVER_BASE` | 手机端默认服务器地址 | 留空，装好后在设置页里手填 |
| `LIFEKIT_MASTER_CODE` | 服务端默认万能码 | 占位符，登录不进去 |
| `LIFEKIT_HOST` | 部署脚本连的服务器 | 部署类脚本直接报错退出 |
| `LIFEKIT_ADMIN_PASSWORD` | 管理后台口令 | 相关脚本要求你显式提供 |


模板见 `.env.example`。

---

## 1. 快速开始

### ✅ 已验证：依赖装好、类型检查通过、打包成功

| 检查项 | 结果 |
|---|---|
| TypeScript 类型检查 | ✅ **0 错误** |
| 全量回归 | ✅ **1994 项断言 / 0 失败**（`tools/` 下 70 个 `check-*` + `verify-*`） |
| Metro 打包 | ✅ 三个通道各自出包成功，约 33.8 MB / arm64-v8a |

### 三步跑起来

```bash
# 1) 安装依赖（用 npm，不要用 pnpm —— 见下方说明）
npm install

# 2) 启动开发服务器
npm start

# 3) 手机装 Expo Go 扫码即可（与电脑同一 Wi-Fi）
```

> **手机扫码连不上？** 试用 tunnel 模式（需要装 `@expo/ngrok`）：
> ```bash
> npx expo start --tunnel
> ```
> 或者用 `npx expo start --lan` 明确指定局域网模式。
> 校园网常有「客户端隔离」（同一 Wi-Fi 下设备互不通信），此时只能走 tunnel。

其他命令：

```bash
npm run typecheck    # TypeScript 类型检查
npm test             # 全部 65 个回归测试
npm run android      # 需要 Android SDK / 真机
npm run ios          # 需要 macOS + Xcode
npx expo prebuild    # 生成原生工程（要加通知监听等原生能力时必须）
```


### ⚙️ 你的电脑上可以直接删掉这一行

`metro.config.js` 里有 `config.maxWorkers = 1;` —— 这是给**受限沙箱环境**用的
（那里禁止进程间管道，Metro 默认 fork 多 worker 会失败）。

**在正常电脑上删掉这一行，能获得多核编译加速。**

### 受限环境下的额外配置（仅沙箱/CI 需要）

在无法写用户主目录的受限环境中运行时，需要把这些目录重定向到工作区内：

```bash
export HOME=$PWD/.home
export EXPO_HOME=$PWD/.home/.expo
export npm_config_cache=$PWD/.npm-cache
```

另外 `metro.config.js` 里设了 `maxWorkers = 1` —— 因为部分受限环境禁止进程间管道，
Metro 默认 fork 多个 worker 会失败（`spawn EPERM`）。**正常开发机可以删掉这一行**以获得多核加速。

---

## 2. 目录结构

```
app/                          # expo-router 页面（文件即路由）
├── _layout.tsx               # 根布局 + CheckinProvider
├── (tabs)/
│   ├── _layout.tsx           # 底部 5 个 Tab
│   ├── index.tsx             # 首页（概览/快捷功能/今日课程/签到动态）
│   ├── schedule.tsx          # 日程（周视图 + 当日时间线）
│   ├── checkin.tsx           # 签到页 ★ 核心
│   ├── todo.tsx              # 待办
│   └── profile.tsx           # 我的
├── youxue-bind.tsx           # 优学院账号与设置（三种绑定方式 + 能力自检）
├── checkin-manual.tsx        # 手动签到兜底页
└── checkin-log.tsx           # 签到日志（脱敏，供反馈）

src/
├── theme/tokens.ts           # 设计系统 Token（严格对齐 ui-spec 第 1 节）
├── components/index.tsx      # UI 原语（按钮/卡片/输入/设置行/徽章/Banner…）
├── domain/types.ts           # 领域模型 + 状态机 + 错误码
├── config/tenants.ts         # 多租户配置（优学院是 SaaS，域名必须可配）
├── state/checkinStore.tsx    # 签到编排：轮询调度、提交、重试、熔断、记录
└── services/
    ├── storage.ts            # 本地存储（业务数据）与 secureStore（凭据）
    └── checkin/
        ├── types.ts          # adapter 契约 ★ 关键抽象
        ├── index.ts          # adapter 解析（mock | youxue）
        ├── mockAdapter.ts    # 模拟实现：可制造签到窗口，演示全流程
        ├── youxueAdapter.ts  # DGUT 真实实现：CAS 登录 + 检测 + 提交
        ├── scheduler.ts      # 热/温/冷三档轮询 + 抖动 + 提交延迟
        ├── errors.ts         # 错误码 → 文案与处置
        ├── http.ts           # 手管 Cookie 的 HTTP 客户端（大小写敏感）
        └── crypto/aes.ts     # 纯 TS AES-128-CBC（自检通过才允许密码登录）
```

---

## 3. 切换到真实自动化（不依赖任何第三方服务）

编辑 `.env`（可从 `.env.example` 复制）：

```bash
EXPO_PUBLIC_YOUXUE_ADAPTER=youxue
EXPO_PUBLIC_YOUXUE_TENANT=dgut
EXPO_PUBLIC_DGUT_LMS_HOST=https://lms.dgut.edu.cn
EXPO_PUBLIC_DGUT_APP_HOST=https://application.dgut.edu.cn
EXPO_PUBLIC_DGUT_AUTH_HOST=https://auth.dgut.edu.cn
```

**切换前必须先做一件事**：完成 `youxue-checkin-tech-spec.md` §11 的 **P0 抓包验证**。
`src/services/checkin/youxueAdapter.ts` 里的 `ENDPOINTS` 常量目前是**候选路径**（已明确标注 🟡），
抓包确认后只需改这一个常量，其余代码不用动。

---

## 4. 已实现 vs 未实现=

### =已实现

| 能力 | 说明 |
|---|---|
| 完整 App 壳 | 5 个 Tab、路由、设计系统、通用组件 |
| **首页模块化布局** | 横向滑动选择器，由**模块注册表**驱动；点击切换内容区 |
| **插件化模块框架** ⭐新 | 每个模块声明「支持平台 + 所需权限 + 默认开关」；按平台能力**自动过滤**；用户可在设置里开关；**用户选择优先于平台能力**；缺权限标「待授权」而非报错 |
| **外卖记录** ⭐新 | 读外卖 App 订单通知 → 自动提取店铺名 → **按店聚合"点过几次"**；含店铺排行、待确认队列、手动补录、去重合并 |
| **扫码签到** | 应用内相机扫码（仅识别二维码）→ 扫到即自动提交；支持"还没有检测到任务时先扫"的独立模式；失败可重新扫描 |
| **定位签到选点** | 画出教师设定的签到范围（圆），显示你的真实位置与距离，可在范围内**自己点选**提交坐标；点到圆外自动吸附回范围内；提供"用当前位置 / 范围内取一点 / 取圆心"快捷操作 |
| 签到状态机 | `idle → detecting → submitting → success/failed/need_manual/rate_limited/paused/expired` |
| 轮询调度 | 热（10~15s）/温（3~5min）/冷（休眠）三档 + ±30% 抖动 + 夜间静默 |
| 反风控 | 提交随机延迟 3~25s、单账号串行提交、单日提交上限、限流退避 5 分钟、连续 3 次熔断 30 分钟 |
| 错误处理 | 10 个标准错误码 → 用户可读文案 + 建议动作 + 是否可重试 |
| 三种绑定方式 | 应用内 WebView 登录 / 账号密码（含短信 MFA 续跑）/ 手动 Cookie |
| **签名授权（白名单）** ⭐新 | 远程名单 JSON 控制签到功能开放；支持**有效期**与单独停用；未授权时展示开通指引而非报错；只控签到模块、不牵连其他模块 |
| CAS 密码加密 | 纯 TS AES-128-CBC + PKCS7，**带 NIST 官方向量自检**，自检失败自动禁用密码登录 |
| Cookie 正确性 | 大小写敏感、不归一化（DGUT 的 `USER_INFO`/`USERINFO` 必须并存） |
| 定位反检测 | 提交坐标做小幅随机扰动、`accuracy` 随机化 |
| 手动兜底 | 数字码/二维码/手势/定位各有专门入口与说明 |
| 可观测 | 签到日志页（脱敏）、失败原因、错误码、轮询策略可视化 |
| MOCK 全流程 | 可一键制造各类签到窗口，肉眼验证每个状态 |
| 回归测试 | `npm test` → 加密 11/11 + 地理 11/11 + 外卖解析 19/19 + 模块框架 24/24 |

### 插件化模块框架

模块注册表在 `src/domain/modules.ts`，每个模块声明：

```ts
{
  key: 'delivery',
  label: '外卖',
  platforms: ['android'],        // ← 支持的平台
  permissions: ['notificationAccess'],  // ← 所需能力
  defaultEnabled: true,
  fallbackHint: 'iOS 系统不允许第三方 App 读取其他 App 的通知…',
}
```

**三条规则（都有测试覆盖）**：

| 规则 | 行为 |
|---|---|
| 1. 按平台能力自动过滤 | iOS 上「外卖」不出现；`platforms` 不含当前平台即隐藏 |
| 2. **用户选择优先于平台能力** | 用户主动开启的模块即使平台不支持也保留显示（标注"不支持"+原因），而不是偷偷替用户决定 |
| 3. 模块自己声明所需权限 | 缺权限标「待授权」并列出缺哪几项，不直接报错 |

模块管理页：**我的 → 功能模块**（分组：已启用 / 待授权 / 未启用 / 当前平台不支持）。


### 外卖记录功能

**目标**：记录你在哪个外卖软件点过哪家店、点过几次。

| 项 | 说明 |
|---|---|
| 数据来源 | Android `NotificationListenerService` 读外卖 App 的订单通知 |
| 提取内容 | 店铺名 / 金额 / 订单阶段（已下单·配送中·已送达·已取消） |
| 隐私边界 | **只读外卖包名的通知标题与正文**，其他通知第一行就丢弃；不读图片；不上传 |
| 去重 | 指纹 = 平台 + 店铺 + 30 分钟窗口 → 同一订单的多条通知合并成一条 |
| 统计口径 | 「已取消」不计入次数 |
| 平台支持 | Android / 鸿蒙 4.x ✅；iOS 与鸿蒙 NEXT ❌（系统限制，App 会降级为手动记录） |
| 接入步骤 | 见 [docs/delivery-android-setup.md](docs/delivery-android-setup.md)（含 Kotlin 文件与 Manifest 配置） |
| 解析测试 | `npm run test:delivery` → 19 个用例（含 7 个"必须忽略的营销通知"） |


### 扫码 / 定位签到的具体行为

**扫码签到**
- 入口：签到页「扫码 / 手动签到」→ `扫描二维码签到`；或收到「需要手动签到」横幅后点进去
- 只识别二维码（`barcodeTypes: ['qr']`），避免误扫条形码
- **扫到第一张就锁住并自动提交**，不会重复提交（服务端会判重复）；提交失败可点"重新扫描"
- 顶部实时显示签到窗口剩余秒数，<30s 变红
- 若还没有检测到任务，会进入"独立扫码模式"，扫到后自动匹配最近的待签到任务

**定位签到选点**
- 界面画出**教师设定的可签到范围**（圆）＋经纬网格
- 显示**你的真实位置**（灰点）与到中心的距离，并明确标注"范围内 / 范围外"
- 可以**在圆内任意位置点选**提交坐标；点到圆外会**自动吸附**回范围内（保留原方向，不是直接跳圆心）
- 快捷操作：`用我的当前位置` / `范围内取一个点`(`r = R·√u·0.75`，面积均匀且留 25% 边界余量) / `取圆心`
- 提交前必须落在范围内才允许提交；提交坐标会再做小幅随机扰动
- 注意：教师设定的**中心点与半径需要从签到详情接口读取**（`ENDPOINTS.rollcallDetail`，见 tech-spec §11 P0）；当前用课程配置的位置作为范围来源


### 未实现

| iOS端无法使用！！！

---

## 5. 风控与合规

- 本功能定位于**课堂考勤辅助**，用户须自行确认符合学校规定与课程要求；
- 轮询做了抖动、随机延迟、夜间静默、单日上限、限流退避与熔断，但这只能降低风险，**无法保证不触发风控**；
- 解绑会立即删除本地凭据。

---

## 6.总结一下
剩下两个模块（外卖，ai）暂且没有开发，ios端目前无法使用，加减分功能稍后更，有点不中功能加减分目前没有很大意义，最重要的功能目前已经实现了，等后续完善。。

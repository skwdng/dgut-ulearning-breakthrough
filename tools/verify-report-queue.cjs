/**
 * 上报队列测试。
 *
 * ══════════════ 需求来源 ══════════════
 * 管理员原话：
 *   「我要做的不是实时去管理，而是需要的时候去刷新一下」
 *
 * 也就是**服务器的开关是随意的** —— 他电脑可能几天没开。
 * 而原先的上报是"发一次就算了"：
 *   reportUser() 失败 → 这次记录**永久消失** → 管理页上永远看不到这个人。
 *
 * 现在改成「先落地，再上报」：
 *   ① 每次上报先写本地队列
 *   ② 再尝试发送，成功才出队
 *   ③ App 启动 / 用户点重试时补发
 *
 * 这个测试用假存储 + 假网络，把整个过程跑一遍。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const QUEUE_SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'reportQueue.ts'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8');
const SETTINGS_SRC = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'settings.tsx'), 'utf8');
/**
 * ⚠️ 登录上报的调用点**搬家了**：
 *    原来是 `youxue-bind.tsx`（学号+密码登录页），
 *    2026-10 学校 CAS 改成 JS 动态渲染登录方式后，登录改由
 *    `youxue-web-login.tsx`（应用内网页登录）承担，
 *    上报也跟着搬过去。
 *
 *    所以这里同时读两个文件 —— 不能只改路径，
 *    否则以后有人把入口改回去就测不到了。
 */
const BIND_SRC = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'youxue-bind.tsx'), 'utf8');
const WEB_LOGIN_SRC = fs.readFileSync(path.join(ROOT, 'src', 'screens', 'youxue-web-login.tsx'), 'utf8');
/** 登录上报实际所在的那个文件（两处任一都算） */
const LOGIN_SRC = `${BIND_SRC}\n${WEB_LOGIN_SRC}`;

let pass = 0;
let fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) {
    pass += 1;
    console.log(`  √ ${name}`);
  } else {
    fail += 1;
    console.log(`  × ${name}${extra ? '  → ' + extra : ''}`);
  }
};

console.log('=== 1) 源码层面的关键决策 ===');
{
  t('reportQueue 存在', QUEUE_SRC.length > 0);
  t('★ 先入队再发送（顺序不能反）', /await enqueueReport\(info\);/.test(QUEUE_SRC) && /await reportUser\(base, info\)/.test(QUEUE_SRC));
  t('发送成功才出队', /if \(r\.ok\) \{[\s\S]{0,120}?await dequeue\(info\.studentId\)/.test(QUEUE_SRC));
  t('失败只累加计数、不删除', /await bumpTries\(info\.studentId\)/.test(QUEUE_SRC));
  t('★ 队列按学号去重', /const i = list\.findIndex\(\(x\) => x\.studentId === info\.studentId\)/.test(QUEUE_SRC));
  t('没有服务器地址时留在队列等', /if \(!base\) return \{ ok: false, queued: true/.test(QUEUE_SRC));
  t('补发函数存在', /export async function flushPendingReports/.test(QUEUE_SRC));
}

console.log('\n=== 2) 接入了调用点 ===');
{
  t('★ 登录上报改用队列版', /reportUserQueued\(base, \{/.test(LOGIN_SRC));
  t('★ 登录页不再直接用 reportUser', !/await reportUser\(base/.test(LOGIN_SRC));
  t('★ 入队时会告诉用户"已存本机、会自动补发"', /已存在本机，连上后会自动补发/.test(LOGIN_SRC));
  t('★ App 启动时补发', /flushPendingReports\(base\)/.test(APP_SRC));
  // ⚠️ 窗口给足 400 字符 —— setTimeout 和 3000 之间隔着 async 包裹与 try 块，
  //    起先写 80 导致假失败（断言太窄，不是代码有问题）。
  t('补发延后执行（不拖慢冷启动）', /setTimeout\([\s\S]{0,400}?\},\s*3000\)/.test(APP_SRC));
  t('设置页显示积压数量', /pendingCount\(\)/.test(SETTINGS_SRC));
  t('设置页有手动重试', /const retryFlush = async/.test(SETTINGS_SRC));
  t('连接成功后顺手补发', /const flush = await flushPendingReports\(base\)/.test(SETTINGS_SRC));
}

console.log('\n=== 3) 复刻队列逻辑，跑真实场景 ===');
{
  /** 假存储 */
  let storeData = null;
  const fakeStore = {
    async get() {
      return storeData ? JSON.parse(JSON.stringify(storeData)) : null;
    },
    async set(_k, v) {
      storeData = JSON.parse(JSON.stringify(v));
    },
  };

  // ── 复刻 reportQueue 的核心逻辑 ──
  async function loadPending() {
    const v = await fakeStore.get();
    if (!Array.isArray(v)) return [];
    return v.filter((x) => x && typeof x.studentId === 'string' && x.studentId);
  }
  async function savePending(list) {
    await fakeStore.set(null, list);
  }
  async function enqueueReport(info) {
    if (!info.studentId) return;
    const list = await loadPending();
    const now = Date.now();
    const i = list.findIndex((x) => x.studentId === info.studentId);
    if (i >= 0) {
      const prev = list[i];
      list[i] = {
        ...prev,
        studentName: info.studentName || prev.studentName,
        school: info.school || prev.school,
        tenant: info.tenant || prev.tenant,
        lastTryAt: now,
      };
    } else {
      list.push({
        studentId: info.studentId,
        studentName: info.studentName,
        school: info.school,
        tenant: info.tenant,
        firstAt: now,
        lastTryAt: now,
        tries: 0,
      });
    }
    await savePending(list);
  }
  async function dequeue(studentId) {
    const list = await loadPending();
    const next = list.filter((x) => x.studentId !== studentId);
    if (next.length !== list.length) await savePending(next);
  }
  async function bumpTries(studentId) {
    const list = await loadPending();
    const i = list.findIndex((x) => x.studentId === studentId);
    if (i < 0) return;
    list[i] = { ...list[i], tries: list[i].tries + 1, lastTryAt: Date.now() };
    await savePending(list);
  }

  /** 假服务器：可切换"开/关" */
  let serverUp = true;
  const received = [];
  async function fakeReportUser(base, info) {
    if (!base) return { ok: false, error: '没有配置服务器地址' };
    if (!serverUp) return { ok: false, error: '连不上' };
    received.push({ ...info });
    return { ok: true };
  }

  async function reportUserQueued(base, info) {
    if (!info.studentId) return { ok: false, queued: false, error: '缺少学号' };
    await enqueueReport(info);
    if (!base) return { ok: false, queued: true, error: '没有配置服务器地址' };
    try {
      const r = await fakeReportUser(base, info);
      if (r.ok) {
        await dequeue(info.studentId);
        return { ok: true, queued: false };
      }
      await bumpTries(info.studentId);
      return { ok: false, queued: true, error: r.error };
    } catch (e) {
      await bumpTries(info.studentId);
      return { ok: false, queued: true, error: e.message };
    }
  }

  async function flushPendingReports(base) {
    const list = await loadPending();
    if (!list.length) return { total: 0, sent: 0, failed: 0, remaining: 0 };
    if (!base) return { total: list.length, sent: 0, failed: list.length, remaining: list.length };
    let sent = 0;
    let failed = 0;
    for (const item of list) {
      try {
        const r = await fakeReportUser(base, item);
        if (r.ok) {
          await dequeue(item.studentId);
          sent += 1;
        } else {
          await bumpTries(item.studentId);
          failed += 1;
        }
      } catch {
        await bumpTries(item.studentId);
        failed += 1;
      }
    }
    const remaining = (await loadPending()).length;
    return { total: list.length, sent, failed, remaining };
  }

  // ── 场景 A：服务器开着 → 直接成功、队列为空 ──
  async function scenarioA() {
    storeData = null;
    serverUp = true;
    received.length = 0;
    const r = await reportUserQueued('http://x:1', { studentId: 'A001', studentName: '甲' });
    t('★ 服务器正常时上报成功', r.ok === true && r.queued === false);
    t('服务器收到了', received.length === 1);
    t('★ 成功后队列为空（不会一直攒着）', (await loadPending()).length === 0);
  }

  // ── 场景 B：服务器关着 → 进队列、不丢 ──
  async function scenarioB() {
    storeData = null;
    received.length = 0;
    serverUp = false;
    const r1 = await reportUserQueued('http://x:1', { studentId: 'B001', studentName: '乙' });
    const r2 = await reportUserQueued('http://x:1', { studentId: 'B002', studentName: '丙' });
    t('★ 服务器关了也不报错', r1.ok === false && r1.queued === true && r2.queued === true);
    t('★ 两条都留在队列里（没丢）', (await loadPending()).length === 2);
    t('服务器什么都没收到', received.length === 0);
    const q = await loadPending();
    t('记录了重试次数', q.every((x) => x.tries >= 1));
  }

  // ── 场景 C：服务器开了 → 补发成功、队列清空 ──
  async function scenarioC() {
    serverUp = true;
    const f = await flushPendingReports('http://x:1');
    console.log(`  补发结果：发送 ${f.sent} 条，剩余 ${f.remaining} 条`);
    t('★ 补发把积压的都发出去了', f.sent === 2 && f.remaining === 0);
    t('★ 服务器最终收到了那两条（离线期间的没丢）', received.length === 2);
    t('收到的学号正确', received.map((x) => x.studentId).sort().join(',') === 'B001,B002');
    t('队列已清空', (await loadPending()).length === 0);
  }

  // ── 场景 D：同一个人反复登录 → 只保留一条 ──
  async function scenarioD() {
    storeData = null;
    serverUp = false;
    await reportUserQueued('http://x:1', { studentId: 'D001', studentName: '第一次' });
    await reportUserQueued('http://x:1', { studentId: 'D001', studentName: '第二次' });
    await reportUserQueued('http://x:1', { studentId: 'D001' });
    const q = await loadPending();
    t('★ 同一个人反复登录只留一条（不会攒爆）', q.length === 1);
    t('姓名取最新的', q[0].studentName === '第二次');
  }

  // ── 场景 E：没配服务器地址 → 留在队列，不报错 ──
  async function scenarioE() {
    storeData = null;
    const r = await reportUserQueued('', { studentId: 'E001' });
    t('没配地址时不崩、标记为已入队', r.ok === false && r.queued === true);
    t('留在队列里', (await loadPending()).length === 1);
  }

  // ── 场景 F：服务器中途挂掉 → 已发的出队、没发的留着 ──
  async function scenarioF() {
    storeData = null;
    received.length = 0;
    serverUp = true;
    await reportUserQueued('http://x:1', { studentId: 'F001' });
    serverUp = false;
    await reportUserQueued('http://x:1', { studentId: 'F002' });
    serverUp = true;
    await reportUserQueued('http://x:1', { studentId: 'F003' });
    const q = await loadPending();
    t('★ 成功的自动出队、失败的留下', q.length === 1 && q[0].studentId === 'F002');
  }

  // ── 场景 G：空队列时补发是无操作 ──
  async function scenarioG() {
    storeData = null;
    const f = await flushPendingReports('http://x:1');
    t('空队列补发不报错', f.total === 0 && f.remaining === 0);
  }

  // ── 场景 H：补发时服务器还是没开 → 全部留下 ──
  async function scenarioH() {
    storeData = null;
    serverUp = false;
    await reportUserQueued('http://x:1', { studentId: 'H001' });
    await reportUserQueued('http://x:1', { studentId: 'H002' });
    const before = (await loadPending()).length;
    const f = await flushPendingReports('http://x:1');
    t('★ 补发失败时一条都不丢', f.sent === 0 && f.remaining === before);
    t('重试次数累加了', (await loadPending()).every((x) => x.tries >= 2));
  }

  (async () => {
    await scenarioA();
    await scenarioB();
    await scenarioC();
    await scenarioD();
    await scenarioE();
    await scenarioF();
    await scenarioG();
    await scenarioH();

    console.log('\n=== 4) 存储键已登记 ===');
    {
      const STORAGE = fs.readFileSync(path.join(ROOT, 'src', 'services', 'storage.ts'), 'utf8');
      t('storage 里有 pendingReports 键', /pendingReports: 'pendingReports'/.test(STORAGE));
      t('reportQueue 用的是这个键', /STORE_KEYS\.pendingReports/.test(QUEUE_SRC));
    }

    console.log(`\nSUMMARY total=${pass + fail} pass=${pass} fail=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch((e) => {
    console.log('  异常：' + (e?.stack ?? e));
    process.exit(1);
  });
}

/**
 * 验证 `classroomActivity2` 的**正确完整前缀**。
 *
 * ══════════════ 推理过程 ══════════════
 *
 * ① 用户从网页 DevTools 抓到（能用）：
 *      /classroomapi/classroomActivity2?classroomId=443969&pageNum=1&pageSize=999
 *
 * ② 我把它直接拼到两个主机上都是 404：
 *      lms.dgut.edu.cn/classroomapi/...          → 404
 *      application.dgut.edu.cn/classroomapi/...  → 404
 *
 * ③ 但从网页 JS 里挖到**东软理工专用**的基址表：
 *      n = "https://application.dgut.edu.cn/appapi"      ← API_HOST
 *      m = "https://application.dgut.edu.cn"             ← UMOOC_SERVER_HOST
 *      u = "https://application.dgut.edu.cn"             ← COURSE_WEB_HOST
 *      p = "https://application.dgut.edu.cn/classroom"   ← SMARTCLASSROOM_WEB_HOST ★★★
 *      v = "https://application.dgut.edu.cn/application"  ← APPLICATION_WEB_HOST
 *
 *     ↑ `SMARTCLASSROOM_WEB_HOST` 明确带 `/classroom` 后缀！
 *       而"选人/积分"正是**智慧课堂**的功能。
 *
 * ④ 另外探测 `/classroomapi` 根路径时得到 **302**（不是 404）——
 *    说明这个前缀是被路由的，只是后面接的东西不对。
 *
 * 所以最可能的正确形式是：
 *      https://application.dgut.edu.cn/appapi/classroomapi/classroomActivity2?...
 *    或  https://application.dgut.edu.cn/classroom/classroomapi/...
 *    等几种组合。
 *
 * 这个脚本把候选**逐个实测**，不猜。
 *
 * 用法: node tools/diagnose-classroom-path.cjs
 */
const https = require('node:https');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** 从 JS 里挖出来的东软理工基址 */
const APP = 'https://application.dgut.edu.cn';
const LMS = 'https://lms.dgut.edu.cn';

const TAIL = '/classroomapi/classroomActivity2?classroomId=443969&pageNum=1&pageSize=999';

/** 候选完整 URL（把 JS 里挖到的每个基址都乘上那个尾巴） */
const CANDIDATES = [
  ['appapi + tail（API_HOST）', `${APP}/appapi${TAIL}`],
  ['classroom + classroomapi', `${APP}/classroom/classroomapi/classroomActivity2?classroomId=443969`],
  ['classroom 根 + tail', `${APP}/classroom${TAIL}`],
  ['application + tail', `${APP}/application${TAIL}`],
  ['mobile + tail', `${APP}/mobile${TAIL}`],
  ['app + tail', `${APP}/app${TAIL}`],
  ['裸 classroomapi（已知404）', `${APP}${TAIL}`],
  ['lms + appapi + tail', `${LMS}/appapi${TAIL}`],
  ['lms 裸（App 探测用的就是它）', `${LMS}${TAIL}`],
  ['lms + classroom + tail', `${LMS}/classroom${TAIL}`],
  // 温度计：已知可用的，用来确认请求发对了地方
  ['★温度计 lms/apps/newAttendance', `${LMS}/apps/newAttendance`],
  ['★温度计 lms/courseapi/homeworks/student', `${LMS}/courseapi/homeworks/student`],
];

function get(url) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' }, timeout: 15000 },
      (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => {
          const body = Buffer.concat(c).toString('utf8');
          resolve({
            status: res.statusCode,
            location: res.headers.location,
            len: body.length,
            head: body.replace(/\s+/g, ' ').slice(0, 130),
          });
        });
      },
    );
    req.on('error', (e) => resolve({ status: 0, len: 0, head: `异常：${e.message}` }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, len: 0, head: 'timeout' });
    });
  });
}

(async () => {
  console.log('');
  console.log('  找 classroomActivity2 的正确完整前缀');
  console.log('  判据：404 = 路径不对；401/302/200/500 = 路径存在（只是没登录或参数不对）');

  const results = [];
  for (const [label, url] of CANDIDATES) {
    const r = await get(url);
    const exists = r.status !== 404 && r.status !== 0;
    results.push({ label, url, r, exists });
    console.log('');
    console.log(`  ${exists ? '★ 存在' : '  404  '} HTTP ${String(r.status).padEnd(4)} ${label}`);
    console.log(`         ${url.replace('https://', '').slice(0, 110)}`);
    if (r.location) console.log(`         → 重定向到 ${String(r.location).slice(0, 90)}`);
    console.log(`         ${r.len} 字节 · ${r.head.slice(0, 105)}`);
  }

  console.log('');
  console.log('═'.repeat(78));
  console.log('  结论');
  console.log('═'.repeat(78));
  const hits = results.filter((x) => x.exists && x.label.includes('classroom'));
  if (hits.length) {
    console.log('  ★ 这些路径**存在**（不是 404）：');
    for (const h of hits) console.log(`     HTTP ${h.r.status}  ${h.label}`);
    console.log('');
    console.log('  下一步：带上登录凭据再试，看哪个返回 JSON 数据。');
  } else {
    console.log('  所有 classroomActivity2 的候选都是 404。');
    console.log('');
    console.log('  ⚠️ 这说明它可能不是靠"路径前缀"拼的，而是：');
    console.log('     · 用查询参数指定（例如 ?api=classroomapi）');
    console.log('     · 或者在**前端已登录后**由 SPA 动态换 baseURL（未登录时不暴露）');
    console.log('');
    console.log('  → 那最可靠的办法是：你在网页 DevTools 里看那个请求的');
    console.log('     **完整 Request URL**（右键请求 → Copy → Copy link address）');
    console.log('     那串里就含着正确前缀。');
  }
  console.log('');
})();

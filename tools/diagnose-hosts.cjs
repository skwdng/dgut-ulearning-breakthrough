/**
 * 诊断：`/apps/...` 与 `/classroomapi/...` 到底在哪个主机上？
 *
 * ══════════════ 起因 ══════════════
 * App 里的接口探测**全都返回 404**，而其中几个接口明明是能用的。
 * 从探测结果里看出两条关键线索：
 *
 *   ① `/apps/newAttendance` → **Apache Tomcat 的 404 错误页**
 *   ② `/courseapi/homeworks/student` → **Spring 的 Whitelabel Error Page (500)**
 *
 * 两个完全不同的后端错误页 → 说明请求打到了**不同的服务**上。
 * 而 `signApi` 的默认 host 是 `lms.dgut.edu.cn`，可
 * `classroomActivity2`（用户抓包确认可用）是在**网页版**用的，
 * 网页版跑在 `application.dgut.edu.cn` 上。
 *
 * 所以：**探测用错了主机。**
 *
 * 这个脚本把"哪个接口在哪个主机上"测清楚，不再靠猜。
 *
 * 用法: node tools/diagnose-hosts.cjs
 */
const https = require('node:https');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const HOSTS = {
  'lms.dgut.edu.cn (App 默认)': 'https://lms.dgut.edu.cn',
  'application.dgut.edu.cn (网页版)': 'https://application.dgut.edu.cn',
};

/** 要试的路径：含两个"已知可用"的当温度计 */
const PATHS = [
  // ★ 温度计：这两个是已知能用的（App 实际在用）
  { p: '/apps/newAttendance', why: '★ 温度计（signByTea 在这下面）' },
  { p: '/apps/user/getUserByUserID/1', why: '★ 温度计（取用户信息）' },
  { p: '/courseapi/homeworks/student', why: '★ 温度计（作业接口）' },
  // 目标
  { p: '/classroomapi/classroomActivity2?classroomId=443969', why: '★★ 选人/积分所在（用户抓包确认）' },
  { p: '/classroomapi/classroomActivity2', why: '★★ 同上，不带参数' },
  { p: '/classroomapi', why: '命名空间根' },
];

function probe(host, path) {
  return new Promise((resolve) => {
    const url = host + path;
    const req = https.get(
      url,
      {
        headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' },
        timeout: 15000,
      },
      (res) => {
        const c = [];
        res.on('data', (d) => c.push(d));
        res.on('end', () => {
          const body = Buffer.concat(c).toString('utf8');
          resolve({ status: res.statusCode, len: body.length, head: body.replace(/\s+/g, ' ').slice(0, 110) });
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

/** 判断响应来自哪个后端（错误页特征） */
function backendOf(head) {
  if (/Apache Tomcat/i.test(head)) return 'Tomcat';
  if (/Whitelabel Error Page/i.test(head)) return 'Spring Boot';
  if (/nginx/i.test(head)) return 'nginx';
  if (/^\s*[[{]/.test(head)) return 'JSON';
  if (/<(!doctype|html)/i.test(head)) return 'HTML';
  return '?';
}

(async () => {
  console.log('');
  console.log('  哪个接口在哪个主机上？（本机直连，不带登录凭据）');
  console.log('  注意：401/403 也说明"路径存在"，只是没登录。');

  for (const [label, host] of Object.entries(HOSTS)) {
    console.log('');
    console.log('═'.repeat(76));
    console.log(`  ${label}`);
    console.log('═'.repeat(76));
    for (const { p, why } of PATHS) {
      const r = await probe(host, p);
      const be = backendOf(r.head);
      // 判断"路径是否存在"：404 才算不存在；其它状态（含 401/403/500）都说明走到应用了
      const exists = r.status !== 404 && r.status !== 0 ? '存在' : r.status === 404 ? '不存在' : '未知';
      console.log('');
      console.log(`  [${exists}] HTTP ${String(r.status).padEnd(4)} 后端=${be.padEnd(12)} ${p}`);
      console.log(`        ${why}`);
      console.log(`        ${r.len} 字节 · ${r.head.slice(0, 95)}`);
    }
  }

  console.log('');
  console.log('═'.repeat(76));
  console.log('  怎么看这个结果');
  console.log('═'.repeat(76));
  console.log('  · 温度计在某个主机上返回 401/403/500（而不是 404）');
  console.log('    → 说明那个主机才是 App 该用的');
  console.log('  · 如果 classroomActivity2 在另一个主机上才有反应');
  console.log('    → 探测要按路径选择主机（这很可能是真的：');
  console.log('       /apps 与 /courseapi 是两套后端，各在自己的主机上）');
  console.log('');
})();

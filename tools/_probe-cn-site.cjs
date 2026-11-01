/**
 * 一次性探测：验证「优学院中国站」的 API 是不是**子域名模式**。
 *
 * ══════════════ 为什么要做这个探测 ══════════════
 *
 * 用户说：「现在有一个优学院走的中国站点不是东莞理工站点的，怎么改」
 *
 * 我从公开资料查到两种模式：
 *   DGUT（现在）   路径前缀：lms.dgut.edu.cn/courseapi、/apps、/classroomapi
 *   中国站         子域名  ：courseapi.ulearning.cn、apps.ulearning.cn、classroomapi.ulearning.cn
 *
 * ⚠️ 这是**推断**，必须实测。判据沿用本项目既有约定：
 *   · 401 / 405 → 路径存在（只是没授权）
 *   · 404（nginx 页 / Tomcat `HTTP Status 404 - //x`）→ 路径不存在
 *   · 200 → 直接存在
 *
 * ⚠️ 只发 GET，**不登录、不带任何凭据、不提交表单**。
 *
 * 用法: node tools/_probe-cn-site.cjs
 */
const https = require('node:https');

const TIMEOUT_MS = 12000;

function get(url) {
  return new Promise((resolve) => {
    const req = https.get(
      url,
      {
        timeout: TIMEOUT_MS,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36',
          'X-Requested-With': 'cn.ulearning.yxy',
          Accept: 'application/json, text/plain, */*',
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          if (body.length < 3000) body += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 200) }));
        res.on('error', (e) => resolve({ status: 0, body: `ERR ${e.message}` }));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: 'TIMEOUT' });
    });
    req.on('error', (e) => resolve({ status: 0, body: `ERR ${e.message}` }));
  });
}

/** 判断这个状态码意味着"路径存在"还是"不存在" */
function verdict(status, body) {
  if (status === 401 || status === 403) return '存在（需授权）';
  if (status === 405) return '存在（方法不对）';
  if (status === 200) return '存在（200）';
  if (status === 404) {
    if (/HTTP Status 404 - \/\//.test(body)) return '不存在（Tomcat 重写）';
    return '不存在（404）';
  }
  if (status === 0) return `失败 ${body}`;
  return `其他 ${status}`;
}

/**
 * 待测：同一批 API 在两种模式下的 URL。
 *   left  = DGUT 路径前缀模式
 *   right = 中国站子域名模式
 */
const PAIRS = [
  // ── apps 服务（签到/选人/用户）──
  ['apps 根', 'https://lms.dgut.edu.cn/apps/', 'https://apps.ulearning.cn/'],
  ['用户信息', 'https://lms.dgut.edu.cn/apps/user/getUserByUserID/13959760', 'https://apps.ulearning.cn/user/getUserByUserID/13959760'],
  // ── courseapi 服务（课程/课堂活动）──
  ['课程列表', 'https://lms.dgut.edu.cn/courseapi/courses/students?publishStatus=1&pn=1&ps=1&type=1', 'https://courseapi.ulearning.cn/courses/students?publishStatus=1&pn=1&ps=1&type=1'],
  // ── classroomapi 服务（智慧课堂）──
  ['课堂列表', 'https://lms.dgut.edu.cn/classroomapi/wisdomClassroom/student/getClassroomList?ocId=1&status=&pageSize=1&pageNum=1&order=0', 'https://classroomapi.ulearning.cn/wisdomClassroom/student/getClassroomList?ocId=1&status=&pageSize=1&pageNum=1&order=0'],
  // ── 对照：故意写错的路径，应该 404 ──
  ['对照（错路径）', 'https://lms.dgut.edu.cn/apps/__nope__', 'https://apps.ulearning.cn/__nope__'],
];

(async () => {
  console.log('');
  console.log('  ══════════════════════════════════════════════════════');
  console.log('   探测：中国站是不是「子域名模式」');
  console.log('   （只发 GET，不登录、不带凭据）');
  console.log('  ══════════════════════════════════════════════════════');
  console.log('');

  for (const [label, dgutUrl, cnUrl] of PAIRS) {
    const [a, b] = await Promise.all([get(dgutUrl), get(cnUrl)]);
    console.log(`  ── ${label} ──`);
    console.log(`    DGUT  ${verdict(a.status, a.body).padEnd(22)} ${dgutUrl}`);
    console.log(`    中国站 ${verdict(b.status, b.body).padEnd(22)} ${cnUrl}`);
    if (a.body && a.status !== 404) console.log(`           DGUT 正文：${a.body.replace(/\s+/g, ' ').slice(0, 110)}`);
    if (b.body && b.status !== 404) console.log(`           中国站正文：${b.body.replace(/\s+/g, ' ').slice(0, 110)}`);
    console.log('');
  }

  console.log('  ══════════════════════════════════════════════════════');
  console.log('  判读：');
  console.log('    若"中国站"那列的同一接口返回 401（而不是 404），');
  console.log('    说明确实是子域名模式 → 适配就是"换 base URL"，路径后缀不变。');
  console.log('  ══════════════════════════════════════════════════════');
  console.log('');
})();

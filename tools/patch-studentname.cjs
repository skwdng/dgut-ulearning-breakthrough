// 把 studentName 贯穿到 youxueAdapter 的 persistSession 调用点。
const fs = require('fs');
const p = __dirname + '/src/services/checkin/youxueAdapter.ts';
let s = fs.readFileSync(p, 'utf8');
const before = s;

// 密码登录的两处（loginWithPassword 内，input: PasswordLoginInput）
s = s.split('return this.persistSession(input.studentId);').join(
  "return this.persistSession(input.studentId, 'password', undefined, undefined, input.studentName);",
);

// 会话导入（importSession 内，input: SessionImportInput）
s = s.replace(
  "return this.persistSession(input.studentId, 'session', input.cookies, input.userAgent);",
  "return this.persistSession(input.studentId, 'session', input.cookies, input.userAgent, input.studentName);",
);

fs.writeFileSync(p, s, 'utf8');
console.log('改动:', s !== before);

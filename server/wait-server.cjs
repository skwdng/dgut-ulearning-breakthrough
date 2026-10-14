/**
 * 等后台服务就绪再返回（给 .cmd 调用）。
 *
 * ⚠️ 为什么要单独一个文件，而不是写在 .cmd 里：
 *   起先在 .cmd 里内联了一段 node 脚本，里面有管道符 `|`，
 *   而 **cmd.exe 会把 `|` 当成管道**，于是把后半段当命令执行，
 *   生成了一个叫 `40){clearInterval(t)` 的垃圾文件。
 *   抽成文件后 .cmd 里就没有特殊字符了。
 *
 * 用法: node wait-server.cjs [端口] [最多等几秒]
 * 退出码: 0 = 就绪, 1 = 超时
 */
const http = require('node:http');

const port = Number(process.argv[2] || 8787);
const maxSeconds = Number(process.argv[3] || 12);
const deadline = Date.now() + maxSeconds * 1000;

function ping() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/ping', timeout: 800 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

(async () => {
  process.stdout.write('  等待服务就绪');
  while (Date.now() < deadline) {
    if (await ping()) {
      process.stdout.write(' 好了\n');
      process.exit(0);
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 300));
  }
  process.stdout.write(' 超时\n');
  process.exit(1);
})();

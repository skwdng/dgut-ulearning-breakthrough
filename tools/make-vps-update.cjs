/**
 * 生成"云端补丁"脚本 —— 只更新改动过的文件，不重装。
 *
 * ══════════════ 什么时候用 ══════════════
 * 服务器已经装好了（`install-vps.sh` 跑过），后来服务端代码有改动 ——
 * 这时不需要重跑整个安装，只需要：
 *   ① 覆盖 /opt/lifekit/ 下的文件
 *   ② 重启服务
 *
 * 为什么不直接重跑 install-vps.sh：
 *   那个脚本会重新装 Node、重写 systemd unit —— 没必要，
 *   而且用户要再粘贴一次 77KB。这个补丁只含真正变了的文件。
 *
 * 用法: node tools/make-vps-update.cjs
 *   → 生成 server/update-vps.sh
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/**
 * ⚠️ 只放**云端实际用到**的文件。
 *    install-vps.sh 写的是 3 个；补丁按需列，通常只有 server.cjs 变。
 */
const FILES = [
  { from: path.join(ROOT, 'server', 'server.cjs'), to: 'server.cjs' },
  { from: path.join(ROOT, 'server', 'licenseCode.cjs'), to: 'licenseCode.cjs' },
  { from: path.join(ROOT, 'web', 'manage.html'), to: 'manage.html' },
];

for (const f of FILES) {
  if (!fs.existsSync(f.from)) {
    console.error(`  × 找不到 ${f.from}`);
    process.exit(1);
  }
}

function wrapB64(buf) {
  const b64 = buf.toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += 120) lines.push(b64.slice(i, i + 120));
  return lines.join('\n');
}

const parts = FILES.map((f) => {
  const buf = fs.readFileSync(f.from);
  return { name: f.to, size: buf.length, b64: wrapB64(buf) };
});
const totalBytes = parts.reduce((a, b) => a + b.size, 0);

const sh = `#!/bin/bash
#
# LifeKit 云端补丁 —— 只更新服务文件并重启，不重装
#
# 用法：把整个文件内容复制，在服务器上执行：
#   sudo bash /root/update.sh
#
# 生成时间：${new Date().toISOString()}
# 内嵌文件：${parts.map((p) => `${p.name}(${p.size}B)`).join(', ')}
# 合计：${totalBytes} 字节

set -e

DIR="/opt/lifekit"
SERVICE="lifekit"

red()  { printf '\\033[31m%s\\033[0m\\n' "$1"; }
grn()  { printf '\\033[32m%s\\033[0m\\n' "$1"; }

echo ""
echo "══════════════════════════════════════════════"
echo "  LifeKit 云端补丁"
echo "══════════════════════════════════════════════"
echo ""

if [ "$(id -u)" != "0" ]; then
  red "  × 需要 root。请用： sudo bash /root/update.sh"
  exit 1
fi

if [ ! -d "$DIR" ]; then
  red "  × 没找到 $DIR —— 服务似乎还没装过。"
  echo "     请先跑 install-vps.sh 做完整安装。"
  exit 1
fi

# 先备份，万一新文件有问题能退回
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DIR/.backup"
for f in ${parts.map((p) => p.name).join(' ')}; do
  [ -f "$DIR/$f" ] && cp "$DIR/$f" "$DIR/.backup/$f.$STAMP" || true
done
grn "  已备份旧文件到 $DIR/.backup/（后缀 $STAMP）"

echo ""
echo "  写入新文件 …"

write_file() {
  cat > "$DIR/$1.b64"
  base64 -d "$DIR/$1.b64" > "$DIR/$1"
  rm -f "$DIR/$1.b64"
}

${parts
  .map(
    (p) => `write_file "${p.name}" <<'LIFEKIT_B64_EOF'
${p.b64}
LIFEKIT_B64_EOF`,
  )
  .join('\n\n')}

chmod 644 "$DIR"/*.cjs "$DIR"/manage.html 2>/dev/null || true

# 语法自检 —— 文件坏了就别重启，直接退回
if ! node --check "$DIR/server.cjs" >/dev/null 2>&1; then
  red "  × 新的 server.cjs 语法检查失败，正在回滚 …"
  for f in ${parts.map((p) => p.name).join(' ')}; do
    [ -f "$DIR/.backup/$f.$STAMP" ] && cp "$DIR/.backup/$f.$STAMP" "$DIR/$f" || true
  done
  systemctl restart "$SERVICE" || true
  red "  已回滚到补丁前的版本。请把这条报错发给开发者。"
  exit 1
fi
grn "  语法检查通过"

echo ""
echo "  重启服务 …"
systemctl restart "$SERVICE"
sleep 2

if ! systemctl is-active --quiet "$SERVICE"; then
  red "  × 服务没起来，正在回滚 …"
  for f in ${parts.map((p) => p.name).join(' ')}; do
    [ -f "$DIR/.backup/$f.$STAMP" ] && cp "$DIR/.backup/$f.$STAMP" "$DIR/$f" || true
  done
  systemctl restart "$SERVICE" || true
  echo ""
  red "  已回滚。最近日志："
  journalctl -u "$SERVICE" -n 20 --no-pager || true
  exit 1
fi
grn "  服务已重启并运行"

echo ""
echo "  自检 …"
if curl -s -m 5 "http://127.0.0.1:8787/api/ping" | grep -q '"ok":true'; then
  grn "  服务正常响应"
else
  red "  ⚠️ 自检没通过，请检查： journalctl -u $SERVICE -n 30"
fi

echo ""
echo "══════════════════════════════════════════════"
grn "  ✅ 补丁完成"
echo "══════════════════════════════════════════════"
echo ""
echo "  数据和口令都保留在 $DIR/data.json（没有被覆盖）"
echo "  旧文件备份在 $DIR/.backup/"
echo ""
`;

const out = path.join(ROOT, 'server', 'update-vps.sh');
fs.writeFileSync(out, sh, 'utf8');

console.log('');
console.log('  √ 已生成 server/update-vps.sh');
console.log(`    内嵌 ${parts.length} 个文件，共 ${totalBytes} 字节`);
for (const p of parts) console.log(`      · ${p.name.padEnd(20)} ${p.size} 字节`);
console.log(`    脚本大小：${(sh.length / 1024).toFixed(1)} KB`);
console.log('');

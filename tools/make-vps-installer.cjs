/**
 * 生成 VPS 一键安装脚本。
 *
 * ══════════════ 为什么做成自解压 ══════════════
 * 服务器上只有 3 个文件（server.cjs / licenseCode.cjs / manage.html），
 * 而且**零外部依赖**（只用 Node 内置模块）—— 所以不需要 npm install。
 *
 * 但让用户在 SSH 里传文件很麻烦（scp / 各种客户端）。
 * 所以把三个文件 base64 内嵌进一个 .sh，用户**复制粘贴一行**就装好了。
 *
 * ⚠️ 用 base64 而不是 heredoc：
 *    heredoc 遇上周文件里的 $ ` \ 会出问题（server.cjs 里有模板字符串），
 *    base64 是纯 ASCII，怎么传都不会坏。
 *
 * 用法: node tools/make-vps-installer.cjs
 *   → 生成 server/install-vps.sh
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
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

/** 分段 base64，避免单行过长（有些终端粘长行会截断） */
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
# LifeKit 管理服务 —— 一键安装（Ubuntu / Debian）
#
# 用法：把整个文件内容复制，在服务器上执行：
#   bash install.sh
#
# 它会：
#   ① 装 Node.js（如果没有）
#   ② 把服务文件写到 /opt/lifekit/
#   ③ 注册成系统服务（开机自启、崩溃自动重启）
#   ④ 开放防火墙端口
#   ⑤ 打印访问地址
#
# 生成时间：${new Date().toISOString()}
# 内嵌文件：${parts.map((p) => `${p.name}(${p.size}B)`).join(', ')}
# 合计：${totalBytes} 字节

set -e

PORT="\${LIFEKIT_PORT:-8787}"
DIR="/opt/lifekit"
SERVICE="lifekit"

red()  { printf '\\033[31m%s\\033[0m\\n' "$1"; }
grn()  { printf '\\033[32m%s\\033[0m\\n' "$1"; }
ylw()  { printf '\\033[33m%s\\033[0m\\n' "$1"; }

echo ""
echo "══════════════════════════════════════════════"
echo "  安装 LifeKit 管理服务"
echo "══════════════════════════════════════════════"
echo ""

# ── 需要 root ──
if [ "$(id -u)" != "0" ]; then
  red "  × 需要 root 权限。请用： sudo bash install.sh"
  exit 1
fi

# ── ① Node.js ──
echo "[1/5] 检查 Node.js …"
if command -v node >/dev/null 2>&1; then
  grn "  已有：$(node -v)"
else
  ylw "  没装，开始安装（可能要一两分钟）…"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq nodejs npm >/dev/null 2>&1 || true
  fi
  if ! command -v node >/dev/null 2>&1; then
    red "  × 自动安装失败。请手动装 Node.js 18+ 后再跑一次："
    echo "      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -"
    echo "      apt-get install -y nodejs"
    exit 1
  fi
  grn "  已安装：$(node -v)"
fi

# 版本要 18+（用到了 node: 前缀与 fetch 相关特性）
NODE_MAJOR="$(node -v | sed 's/v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 18 ] 2>/dev/null; then
  ylw "  ⚠️ Node 版本偏低（$NODE_MAJOR），建议 18 以上"
fi

# ── ② 写文件 ──
echo "[2/5] 写入服务文件到 $DIR …"
mkdir -p "$DIR"

write_file() {
  # $1=目标文件名
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
grn "  已写入 $(ls -1 "$DIR" | wc -l) 个文件"

# 语法自检 —— 装错了当场能看出来，别等启动才发现
if ! node --check "$DIR/server.cjs" >/dev/null 2>&1; then
  red "  × server.cjs 语法检查失败，文件可能传坏了"
  exit 1
fi
grn "  语法检查通过"

# ── ③ 注册系统服务 ──
echo "[3/5] 注册开机自启服务 …"
cat > "/etc/systemd/system/$SERVICE.service" <<LIFEKIT_UNIT_EOF
[Unit]
Description=LifeKit admin service
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
Environment=LIFEKIT_PORT=$PORT
ExecStart=$(command -v node) $DIR/server.cjs
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
LIFEKIT_UNIT_EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
sleep 2

if systemctl is-active --quiet "$SERVICE"; then
  grn "  服务已启动"
else
  red "  × 服务没起来，最近日志："
  journalctl -u "$SERVICE" -n 20 --no-pager || true
  exit 1
fi

# ── ④ 防火墙 ──
echo "[4/5] 开放端口 $PORT …"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT"/tcp >/dev/null 2>&1 && grn "  ufw 已放行"
else
  ylw "  （没检测到启用的 ufw。如果你用的是云服务商的安全组，"
  ylw "    需要到控制台放行 TCP $PORT —— 这一步别忘了）"
fi

# ── ⑤ 自检 ──
echo "[5/5] 自检 …"
sleep 1
if command -v curl >/dev/null 2>&1; then
  RESP="$(curl -s -m 5 "http://127.0.0.1:$PORT/api/ping" || true)"
  if echo "$RESP" | grep -q '"ok":true'; then
    grn "  服务正常响应"
  else
    ylw "  本机自检没通过，返回：$RESP"
  fi
fi

# 公网 IP
PUBIP="$(curl -s -m 5 https://api.ipify.org 2>/dev/null || true)"
[ -z "$PUBIP" ] && PUBIP="$(hostname -I 2>/dev/null | awk '{print $1}')"

echo ""
echo "══════════════════════════════════════════════"
grn "  ✅ 安装完成"
echo "══════════════════════════════════════════════"
echo ""
echo "  管理页地址："
echo "      http://$PUBIP:$PORT"
echo ""
ylw "  ★ 两件必做的事："
echo "     ① 到云服务商控制台，放行安全组 TCP $PORT"
echo "        （阿里云/腾讯云默认只开 22，不开这一步外面访问不了）"
echo "     ② 打开上面的管理页 → 设管理口令"
echo ""
echo "  常用命令："
echo "     查看状态： systemctl status $SERVICE"
echo "     看日志：   journalctl -u $SERVICE -f"
echo "     重启：     systemctl restart $SERVICE"
echo "     改端口：   LIFEKIT_PORT=9000 bash install.sh"
echo ""
echo "  数据文件： $DIR/data.json"
echo ""
`;

const out = path.join(ROOT, 'server', 'install-vps.sh');
fs.writeFileSync(out, sh, 'utf8');

console.log('');
console.log('  √ 已生成 server/install-vps.sh');
console.log(`    内嵌 ${parts.length} 个文件，共 ${totalBytes} 字节`);
for (const p of parts) console.log(`      · ${p.name.padEnd(20)} ${p.size} 字节`);
console.log(`    脚本大小：${(sh.length / 1024).toFixed(1)} KB`);
console.log('');
console.log('  这就是要给服务器粘贴的内容（也可以上传后 bash install-vps.sh）');
console.log('');

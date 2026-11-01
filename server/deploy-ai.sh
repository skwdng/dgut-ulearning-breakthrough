#!/bin/bash
# 部署 LifeKit 小c AI 服务（Node，无第三方依赖）到 /opt/lifekit-ai，systemd 托管，端口 8789
set -e

mkdir -p /opt/lifekit-ai

if [ ! -f /opt/lifekit-ai/ai-server.cjs ]; then
  echo "  × 找不到 /opt/lifekit-ai/ai-server.cjs（先 scp 上传）"
  exit 1
fi

echo "── 语法检查 ──"
node --check /opt/lifekit-ai/ai-server.cjs && echo "  ✓ 语法正确"

echo "── 写 systemd 服务 ──"
cat > /etc/systemd/system/lifekit-ai.service <<'EOF'
[Unit]
Description=LifeKit 小c AI Service (Ollama gateway + RAG)
After=network-online.target ollama.service
Wants=network-online.target
# Ollama 挂了小c 还能起来（只是回答会报错）
After=ollama.service

[Service]
Type=simple
WorkingDirectory=/opt/lifekit-ai
ExecStart=/usr/bin/node /opt/lifekit-ai/ai-server.cjs
Restart=always
RestartSec=3
Environment="AI_PORT=8789"
Environment="OLLAMA_URL=http://127.0.0.1:11434"
Environment="MGMT_URL=http://127.0.0.1:8787"
Environment="AI_CHAT_MODEL=qwen2.5:0.5b"
Environment="AI_EMBED_MODEL=all-minilm"

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable lifekit-ai >/dev/null 2>&1 || true
systemctl restart lifekit-ai
sleep 2
echo -n "  service: "
systemctl is-active lifekit-ai

echo ""
echo "── 本机自测 ──"
echo -n "  /ai/health : "
curl -s --max-time 20 http://127.0.0.1:8789/ai/health | head -c 400
echo ""

# 找一个已授权的学号做冒烟测试（只在本机用，不记录）
SID=$(node -e "
try{
 const fs=require('fs');
 const j=JSON.parse(fs.readFileSync('/opt/lifekit/data.json','utf8'));
 const ks=Object.keys(j.users||{});
 const hit=ks.find(k=>j.users[k] && j.users[k].authorized);
 console.log(hit||'');
}catch(e){console.log('')}
")
if [ -n "$SID" ]; then
  echo "  （用服务器上已授权学号做冒烟测试：只显示前 4 位 ${SID:0:4}****）"
  echo -n "  /ai/embed : "
  curl -s --max-time 90 http://127.0.0.1:8789/ai/embed -H 'Content-Type: application/json' \
    -d "{\"studentId\":\"$SID\",\"texts\":[\"外卖 麻辣烫 25 元\"]}" | head -c 160
  echo ""
  echo -n "  /ai/chat  : "
  curl -s --max-time 180 http://127.0.0.1:8789/ai/chat -H 'Content-Type: application/json' \
    -d "{\"studentId\":\"$SID\",\"messages\":[{\"role\":\"user\",\"content\":\"我最近点了几次外卖？\"}],\"context\":[\"外卖 2026-10-28 麻辣烫 25 元\",\"外卖 2026-10-29 黄焖鸡 22 元\"]}" | head -c 500
  echo ""
else
  echo "  （服务器上没有已授权学号，跳过冒烟测试）"
fi

echo ""
echo "── 防火墙 ──"
if command -v ufw >/dev/null 2>&1; then
  ufw status | head -5
else
  echo "  没有 ufw（端口默认对外开放）"
fi
echo "── 完成 ──"

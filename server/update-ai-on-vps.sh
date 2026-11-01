#!/bin/bash
# 更新服务器上的 server.cjs（加 /ai 代理）与 ai-server.cjs，并重启两个服务
set -e

cd /opt/lifekit

echo "── 1) 备份 ──"
STAMP=$(date +%Y%m%d-%H%M%S)
cp -f server.cjs "server.cjs.bak-$STAMP"
echo "  已备份 server.cjs.bak-$STAMP"

echo "── 2) 替换文件 ──"
if [ ! -f /tmp/new-server.cjs ]; then echo "  × 缺少 /tmp/new-server.cjs"; exit 1; fi
mv /tmp/new-server.cjs server.cjs
if [ -f /tmp/new-ai-server.cjs ]; then mv /tmp/new-ai-server.cjs /opt/lifekit-ai/ai-server.cjs; fi

echo "── 3) 语法检查 ──"
node --check server.cjs && echo "  ✓ server.cjs"
node --check /opt/lifekit-ai/ai-server.cjs && echo "  ✓ ai-server.cjs"

echo "── 4) 重启 ──"
systemctl restart lifekit
systemctl restart lifekit-ai
sleep 3
echo -n "  lifekit   : "; systemctl is-active lifekit
echo -n "  lifekit-ai: "; systemctl is-active lifekit-ai
echo -n "  ollama    : "; systemctl is-active ollama

echo ""
echo "── 5) 本机验证 /ai/health（走 8787 代理）──"
curl -s --max-time 20 http://127.0.0.1:8787/ai/health | head -c 400
echo ""

SID=$(node -e "try{const j=require('/opt/lifekit/data.json');const ks=Object.keys(j.users||{});console.log(ks.find(k=>j.users[k]&&j.users[k].authorized)||'')}catch(e){console.log('')}")
if [ -n "$SID" ]; then
  echo "── 6) 完整 RAG 问答（学号掩码 ${SID:0:4}****）──"
  echo -n "  embed: "
  curl -s --max-time 120 http://127.0.0.1:8787/ai/embed -H 'Content-Type: application/json' \
    -d "{\"studentId\":\"$SID\",\"texts\":[\"外卖订单：2026-10-28 美团 麻辣烫 25 元\"]}" | head -c 120
  echo ""
  echo "  chat : "
  curl -s --max-time 300 http://127.0.0.1:8787/ai/chat -H 'Content-Type: application/json' \
    -d "{\"studentId\":\"$SID\",\"messages\":[{\"role\":\"user\",\"content\":\"我最近外卖花了多少钱？\"}],\"context\":[\"外卖订单：2026-10-28 美团 麻辣烫 25 元\",\"外卖订单：2026-10-29 饿了么 黄焖鸡 22 元\"]}"
  echo ""
else
  echo "  （没有已授权学号，跳过完整问答测试）"
fi

echo "── 完成 ──"

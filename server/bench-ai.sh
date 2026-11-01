#!/bin/bash
# 实测小c 各环节耗时（在服务器上跑，排除手机网络因素）
set -e
SID=$(node -e "try{const j=require('/opt/lifekit/data.json');const ks=Object.keys(j.users||{});console.log(ks.find(k=>j.users[k]&&j.users[k].authorized)||'')}catch(e){console.log('')}")
echo "  学号掩码: ${SID:0:4}****"

echo ""
echo "── 1) embed 24 条（一次批量）──"
TEXTS=$(node -e "
const arr=[];for(let i=0;i<24;i++)arr.push('外卖订单：2026-10-2'+ (i%9) +' 美团 测试店'+i+' '+(20+i)+' 元 状态已完成');
console.log(JSON.stringify(arr));")
START=$(date +%s%3N)
curl -s --max-time 180 http://127.0.0.1:8787/ai/embed -H 'Content-Type: application/json' \
  -d "{\"studentId\":\"$SID\",\"texts\":$TEXTS}" -o /tmp/embed_out.json
END=$(date +%s%3N)
echo "  耗时: $((END-START)) ms  返回: $(head -c 80 /tmp/embed_out.json)"

echo ""
echo "── 2) chat（冷启动，会加载模型）──"
START=$(date +%s%3N)
curl -s --max-time 300 http://127.0.0.1:8787/ai/chat -H 'Content-Type: application/json' \
  -d "{\"studentId\":\"$SID\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}],\"context\":[]}" -o /tmp/chat1.json
END=$(date +%s%3N)
echo "  耗时: $((END-START)) ms  返回: $(head -c 200 /tmp/chat1.json)"

echo ""
echo "── 3) chat（第二次，模型已加载）──"
START=$(date +%s%3N)
curl -s --max-time 300 http://127.0.0.1:8787/ai/chat -H 'Content-Type: application/json' \
  -d "{\"studentId\":\"$SID\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}],\"context\":[\"外卖订单：2026-10-28 美团 麻辣烫 25 元\"]}" -o /tmp/chat2.json
END=$(date +%s%3N)
echo "  耗时: $((END-START)) ms  返回: $(head -c 200 /tmp/chat2.json)"

echo ""
echo "── 4) 再 embed（此时模型被切换：qwen → minilm）──"
START=$(date +%s%3N)
curl -s --max-time 180 http://127.0.0.1:8787/ai/embed -H 'Content-Type: application/json' \
  -d "{\"studentId\":\"$SID\",\"texts\":[\"测试一条\"]}" -o /tmp/embed2.json
END=$(date +%s%3N)
echo "  耗时: $((END-START)) ms"

echo ""
echo "── 5) 内存 ──"
free -m | head -3
echo "── 当前加载的模型 ──"
curl -s --max-time 5 http://127.0.0.1:11434/api/ps | head -c 300
echo ""

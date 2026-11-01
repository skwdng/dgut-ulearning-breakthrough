#!/bin/bash
# 手动修复 Ollama：重新下载官方 zst 包并解压到 /usr/local
# （安装脚本的解压没把 llama-server 等运行器放进去，导致推理报 "llama-server binary not found"）
set -e

cd /tmp
echo "── 1) 下载 ollama-linux-amd64.zst ──"
if [ ! -s /tmp/ollama-linux-amd64.zst ]; then
  curl -fL --retry 3 --retry-delay 2 -o /tmp/ollama-linux-amd64.zst \
    "https://ollama.com/download/ollama-linux-amd64.zst"
fi
ls -lh /tmp/ollama-linux-amd64.zst

echo "── 2) 解压 ──"
rm -f /tmp/ollama-linux-amd64.tar
zstd -d -c /tmp/ollama-linux-amd64.zst > /tmp/ollama-linux-amd64.tar
ls -lh /tmp/ollama-linux-amd64.tar

echo "── 3) 看包里有没有 llama-server ──"
tar -tf /tmp/ollama-linux-amd64.tar | grep -E 'llama-server|lib/ollama/' | head -12

echo "── 4) 覆盖安装到 /usr/local ──"
tar -xf /tmp/ollama-linux-amd64.tar -C /usr/local
ls -lh /usr/local/lib/ollama/ | head -12

echo "── 5) 重启 ollama 并测试 ──"
systemctl restart ollama
sleep 3
systemctl is-active ollama
echo -n "  生成测试: "
curl -s --max-time 180 http://127.0.0.1:11434/api/generate \
  -d '{"model":"qwen2.5:0.5b","prompt":"用一句中文回答：你好","stream":false,"options":{"num_predict":24}}' \
  | head -c 500
echo ""
echo -n "  向量测试: "
curl -s --max-time 60 http://127.0.0.1:11434/api/embeddings \
  -d '{"model":"all-minilm","prompt":"外卖 25 元"}' | head -c 160
echo ""
echo "── 完成 ──"

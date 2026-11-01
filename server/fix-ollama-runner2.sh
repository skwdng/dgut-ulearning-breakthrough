#!/bin/bash
# 修复：下载正确的 ollama-linux-amd64.tar.zst 并解压到 /usr/local
set -e

URLS=(
  "https://ollama.com/download/ollama-linux-amd64.tar.zst"
  "https://github.com/ollama/ollama/releases/download/v0.40.13/ollama-linux-amd64.tar.zst"
)

cd /tmp
OK=0
if [ -s /tmp/ollama-linux-amd64.tar.zst ]; then
  echo "  · 已有下载文件"
  OK=1
else
  for u in "${URLS[@]}"; do
    echo "  尝试下载：$u"
    if curl -fL --retry 2 --retry-delay 2 --connect-timeout 20 -o /tmp/ollama-linux-amd64.tar.zst "$u"; then
      OK=1
      break
    fi
    echo "  × 失败，换下一个"
  done
fi
if [ "$OK" != "1" ]; then echo "  × 全部下载失败"; exit 1; fi
ls -lh /tmp/ollama-linux-amd64.tar.zst

echo "── 解压 ──"
rm -f /tmp/ollama-linux-amd64.tar
zstd -d -c /tmp/ollama-linux-amd64.tar.zst > /tmp/ollama-linux-amd64.tar
ls -lh /tmp/ollama-linux-amd64.tar

echo "── 检查包内容 ──"
tar -tf /tmp/ollama-linux-amd64.tar | grep -E 'llama-server|lib/ollama/' | head -10

echo "── 安装到 /usr/local ──"
tar -xf /tmp/ollama-linux-amd64.tar -C /usr/local
ls -lh /usr/local/lib/ollama/ | head -10

echo "── 重启并测试 ──"
systemctl restart ollama
sleep 3
systemctl is-active ollama
echo -n "  生成: "
curl -s --max-time 240 http://127.0.0.1:11434/api/generate \
  -d '{"model":"qwen2.5:0.5b","prompt":"用一句中文回答：你好","stream":false,"options":{"num_predict":24}}' | head -c 400
echo ""
echo -n "  向量: "
curl -s --max-time 90 http://127.0.0.1:11434/api/embeddings \
  -d '{"model":"all-minilm","prompt":"外卖 25 元"}' | head -c 160
echo ""
echo "── 完成 ──"

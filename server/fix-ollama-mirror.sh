#!/bin/bash
# 通过 gh-proxy 镜像下载 Ollama 完整包并安装（GitHub 直连在服务器上只有 85KB/s）
set -e

MIRROR="https://gh-proxy.com/https://github.com/ollama/ollama/releases/download/v0.40.13"
FILE=/tmp/ollama-linux-amd64.tar.zst

echo "── 下载（gh-proxy 镜像）──"
rm -f "$FILE"
curl -fL --retry 2 --retry-delay 2 -o "$FILE" "$MIRROR/ollama-linux-amd64.tar.zst"
ls -lh "$FILE"

echo "── 校验压缩包 ──"
zstd -t "$FILE" && echo "  ✓ zst 完整"

echo "── 解压 ──"
rm -f /tmp/ollama-linux-amd64.tar
zstd -d -c "$FILE" > /tmp/ollama-linux-amd64.tar
ls -lh /tmp/ollama-linux-amd64.tar

echo "── 核对运行器 ──"
tar -tf /tmp/ollama-linux-amd64.tar | grep -cE 'lib/ollama/' || true
tar -tf /tmp/ollama-linux-amd64.tar | grep -E 'llama-server' | head -4 || echo "  （包内无 llama-server，可能新版命名不同）"

echo "── 安装 ──"
tar -xf /tmp/ollama-linux-amd64.tar -C /usr/local
ls -lh /usr/local/lib/ollama/ 2>/dev/null | head -10 || true

echo "── 重启 Ollama ──"
systemctl restart ollama
sleep 4
echo -n "  service: "
systemctl is-active ollama

echo ""
echo "── 推理测试（首次加载模型会慢 10~30 秒）──"
echo -n "  生成: "
curl -s --max-time 300 http://127.0.0.1:11434/api/generate \
  -d '{"model":"qwen2.5:0.5b","prompt":"用一句中文回答：你好","stream":false,"options":{"num_predict":24}}' \
  | head -c 400
echo ""
echo -n "  向量: "
curl -s --max-time 90 http://127.0.0.1:11434/api/embeddings \
  -d '{"model":"all-minilm","prompt":"外卖 25 元"}' | head -c 120
echo ""
echo "── 完成 ──"

#!/bin/bash
# ══════════════════════════════════════════════════════════════
# 在 VPS 上部署 Ollama（给 LifeKit「小c」智能体用）
#
# 服务器规格（实测）：2 核 / 1.6GB 内存 / 34GB 空闲
#   ⚠️ 内存很小 —— 必须：
#      ① 加 swap，防止模型把 LifeKit 主服务挤到 OOM
#      ② 只装**小模型**：qwen2.5:0.5b（中文对话）+ all-minilm（向量检索）
#      ③ 限制同时加载的模型数 = 1
# ══════════════════════════════════════════════════════════════
set -e

echo "── 1) 加 2G swap（防 OOM）──"
if ! swapon --show | grep -q '/swapfile'; then
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "  ✓ 已启用 swap"
else
  echo "  · swap 已存在"
fi
free -m | head -3

echo "── 2) 安装 Ollama ──"
if command -v ollama >/dev/null 2>&1; then
  echo "  · 已安装：$(ollama --version 2>&1 | head -1)"
else
  echo "  正在下载安装脚本…"
  curl -fsSL https://ollama.com/install.sh -o /tmp/ollama-install.sh
  sh /tmp/ollama-install.sh
  echo "  ✓ 安装完成"
fi

echo "── 3) 给 Ollama 设置内存保守参数 ──"
mkdir -p /etc/systemd/system/ollama.service.d
cat > /etc/systemd/system/ollama.service.d/override.conf <<'EOF'
[Service]
# 只允许同时加载 1 个模型（内存只有 1.6G）
Environment="OLLAMA_MAX_LOADED_MODELS=1"
# 并发请求数 1（2 核，别排队太多）
Environment="OLLAMA_NUM_PARALLEL=1"
# 模型闲置 10 分钟后卸载，释放内存
Environment="OLLAMA_KEEP_ALIVE=10m"
EOF
systemctl daemon-reload
systemctl restart ollama
sleep 2
systemctl is-active ollama
echo "  ✓ ollama 服务已重启"

echo "── 4) 拉取模型 ──"
echo "  · 对话模型 qwen2.5:0.5b（约 400MB）"
ollama pull qwen2.5:0.5b
echo "  · 向量模型 all-minilm（约 46MB）"
ollama pull all-minilm

echo "── 5) 冒烟测试 ──"
echo -n "  /api/tags : "
curl -s --max-time 10 http://127.0.0.1:11434/api/tags | head -c 400
echo ""
echo -n "  生成测试 : "
curl -s --max-time 120 http://127.0.0.1:11434/api/generate \
  -d '{"model":"qwen2.5:0.5b","prompt":"用一句中文回答：你好","stream":false,"options":{"num_predict":30}}' \
  | head -c 400
echo ""
echo -n "  向量测试 : "
curl -s --max-time 60 http://127.0.0.1:11434/api/embeddings \
  -d '{"model":"all-minilm","prompt":"外卖订单 麻辣烫 25 元"}' | head -c 200
echo ""
echo "── 完成 ──"

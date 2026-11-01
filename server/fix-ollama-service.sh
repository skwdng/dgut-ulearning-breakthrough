#!/bin/bash
# 手动创建 Ollama systemd 服务（安装脚本没能生成 unit 时用这个）
set -e

cat > /etc/systemd/system/ollama.service <<'EOF'
[Unit]
Description=Ollama Service (LifeKit 小c)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=/usr/local/bin/ollama serve
Restart=always
RestartSec=3
# ⚠️ 服务器只有 1.6G 内存：只允许同时加载 1 个模型、并发 1 个请求
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_KEEP_ALIVE=10m"
Environment="OLLAMA_HOST=127.0.0.1:11434"

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ollama >/dev/null 2>&1 || true
systemctl restart ollama
sleep 3
echo -n "  service: "
systemctl is-active ollama
echo -n "  /api/tags: "
curl -s --max-time 5 http://127.0.0.1:11434/api/tags | head -c 200
echo ""

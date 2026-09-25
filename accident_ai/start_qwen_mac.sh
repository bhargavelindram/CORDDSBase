#!/bin/bash
set -e
cd "$(dirname "$0")/.."
if ! command -v llama >/dev/null 2>&1; then
  echo "Installing llama.cpp CLI/server for macOS..."
  curl -LsSf https://llama.app/install.sh | sh
fi
echo "Starting local Qwen3-VL-8B server on http://127.0.0.1:30000 ..."
exec llama serve -hf Qwen/Qwen3-VL-8B-Instruct-GGUF:Q4_K_M --host 127.0.0.1 --port 30000

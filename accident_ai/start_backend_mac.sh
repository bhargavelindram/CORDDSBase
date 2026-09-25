#!/bin/bash
set -e
cd "$(dirname "$0")"
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements-mac.txt
export VLM_URL="http://127.0.0.1:30000/v1/chat/completions"
export VLM_MODEL="Qwen/Qwen3-VL-8B-Instruct"
export VLM_ENABLED="true"
python -m uvicorn server:app --host 127.0.0.1 --port 8000

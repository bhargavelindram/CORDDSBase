#!/bin/bash
set -e
cd "$(dirname "$0")"
if [ -f ".env" ]; then
  set -a
  source ".env"
  set +a
fi
if ! command -v ollama >/dev/null 2>&1; then
  echo "Ollama is not installed or is not on PATH."
  exit 1
fi
if ! ollama list | awk 'NR>1 {print $1}' | grep -qx "$OLLAMA_VISION_MODEL"; then
  echo "Required local vision model '$OLLAMA_VISION_MODEL' is not installed."
  echo "Install it first with: ollama pull $OLLAMA_VISION_MODEL"
  exit 1
fi
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements-mac.txt
python -m uvicorn server:app --host 127.0.0.1 --port 8000

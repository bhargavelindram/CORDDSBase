#!/bin/bash
set -e
cd "$(dirname "$0")"
if [ -f ".env" ]; then
  set -a
  source ".env"
  set +a
fi
if [ ! -d ".venv" ]; then
  python3 -m venv .venv
fi
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements-mac.txt
python -m uvicorn server:app --host 127.0.0.1 --port 8000

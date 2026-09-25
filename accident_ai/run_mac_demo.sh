#!/bin/bash
set -e
cd "$(dirname "$0")"
echo "CORDDSBase Mac demo"
echo "Terminal 1: Qwen3-VL-8B"
echo "Terminal 2: YOLO11x accident backend"
echo "The website automatically uses http://127.0.0.1:8000."
echo
./start_backend_mac.sh

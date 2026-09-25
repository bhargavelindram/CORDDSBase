# CORDDSBase Accident AI

This backend implements the high-quality CCTV pipeline: YOLO11x detection, BoT-SORT persistent tracking, candidate-window buffering, and Qwen3-VL-32B accident verification.

## Run
Install Python 3.10+ and requirements.txt. A CUDA-capable GPU is strongly recommended.

Serve Qwen3-VL with an OpenAI-compatible vision endpoint, then set VLM_URL and VLM_MODEL if needed.

Start the API with:
uvicorn server:app --host 0.0.0.0 --port 8010

The website sends JPEG samples to POST /frame. The backend only asks the VLM to inspect a short sequence when persistent tracked vehicles enter a collision candidate window.

This is intentionally separate from GitHub Pages because YOLO11x and Qwen3-VL-32B are too large for practical browser-only inference.

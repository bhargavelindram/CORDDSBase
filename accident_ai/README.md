# CORDDSBase Collision Detector

CORDDSBase now uses a dedicated vehicle-detection pipeline instead of a general-purpose vision-language model.

## Pipeline

1. RT-DETRv2-S INT8 detects COCO `car` objects.
2. A lightweight persistent tracker assigns vehicle IDs between frames.
3. Bounding-box gap/overlap and approach geometry are evaluated.
4. Physical contact must persist for multiple frames before an alert is generated.

The detector runs locally through ONNX Runtime CPU inference. No Ollama, LLaVA, Qwen, or paid AI service is required.

## Mac

Use:

```bash
cd accident_ai
./start_backend_mac.sh
```

The first startup downloads the 32.7 MB RT-DETRv2-S INT8 ONNX model and verifies its SHA-256 checksum.

The model is RT-DETRv2-S INT8, a compact CPU-oriented RT-DETR model. The published model documentation reports 45.7 AP on COCO and a 32.7 MB model size. The detector accepts 640x640 RGB input and returns normalized boxes and class logits.

The website sends JPEG snapshots to `POST /frame`.

## API

- `GET /health` — loads/verifies the detector and reports status.
- `POST /frame` — detects cars, updates tracks, checks collision geometry, and returns vehicle/tracking data plus an alert when contact is confirmed.

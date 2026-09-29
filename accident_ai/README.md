# CORDDSBase YOLO11x detector

Local high-accuracy accident detector for the CORDDSBase prototype.

- YOLO11x
- 1280px inference
- BoT-SORT tracking
- 40-frame temporal window
- optical-flow + motion-spike + vehicle-contact scoring
- local-only inference

## Mac
```bash
cd ~/Desktop/CORDDSBase/accident_ai
chmod +x start_backend_mac.sh
./start_backend_mac.sh
```

The first run downloads the YOLO11x model automatically through Ultralytics.

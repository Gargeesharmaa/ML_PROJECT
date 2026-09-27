import os
import sys
import warnings
warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")

from datetime import datetime, timezone
import cv2
import numpy as np
import time
import json
import re
from typing import Optional, Tuple, Dict, Any, List
from multiprocessing import Process, Queue, Manager

# Directory constants
ANPR_DIR = os.path.dirname(os.path.abspath(__file__))
YOLO_MODEL_PATH = os.path.join(ANPR_DIR, "yolov8n.pt")
PLATE_MODEL_PATH = os.path.join(ANPR_DIR, "yolov8n-plate.pt")
TRACKER_CONFIG_PATH = os.path.join(ANPR_DIR, "custom_bytetrack.yaml")


# ==========================================
# OCR Engine Loader (RapidOCR / PaddleOCR / EasyOCR / Fallback)
# ==========================================
_GLOBAL_OCR_ENGINE = None

def get_ocr_engine():
    global _GLOBAL_OCR_ENGINE
    if _GLOBAL_OCR_ENGINE is not None:
        return _GLOBAL_OCR_ENGINE

    # 1. Try RapidOCR (Lightweight, fast ONNX backend)
    try:
        from rapidocr_onnxruntime import RapidOCR
        _GLOBAL_OCR_ENGINE = ("rapidocr", RapidOCR())
        return _GLOBAL_OCR_ENGINE
    except Exception:
        pass

    # 2. Try PaddleOCR
    try:
        from paddleocr import PaddleOCR
        _GLOBAL_OCR_ENGINE = ("paddleocr", PaddleOCR(use_angle_cls=False, lang='en', show_log=False))
        return _GLOBAL_OCR_ENGINE
    except Exception:
        pass

    # 3. Try EasyOCR
    try:
        import easyocr
        _GLOBAL_OCR_ENGINE = ("easyocr", easyocr.Reader(['en'], gpu=False))
        return _GLOBAL_OCR_ENGINE
    except Exception:
        pass

    _GLOBAL_OCR_ENGINE = ("fallback", None)
    return _GLOBAL_OCR_ENGINE


# ==========================================
# STAGE 3: Image Rectification & Preprocessing
# ==========================================
def preprocess_plate(plate_crop):
    if plate_crop is None or plate_crop.size == 0:
        return None
    
    # Convert to Grayscale
    gray = cv2.cvtColor(plate_crop, cv2.COLOR_BGR2GRAY)
    
    # Resize to standard height for OCR accuracy
    h, w = gray.shape
    if h < 64 and h > 0:
        aspect = w / float(h)
        gray = cv2.resize(gray, (int(64 * aspect), 64), interpolation=cv2.INTER_CUBIC)
        
    # Contrast Limited Adaptive Histogram Equalization (CLAHE)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    
    return enhanced


# ==========================================
# STAGE 4: OCR Engine & Regex Validation
# ==========================================
def run_ocr(ocr_tuple, plate_img) -> Tuple[str, float]:
    processed = preprocess_plate(plate_img)
    if processed is None:
        return "", 0.0

    engine_type, ocr_engine = ocr_tuple

    raw_texts = []
    confidences = []

    try:
        if engine_type == "rapidocr" and ocr_engine:
            result, _ = ocr_engine(processed)
            if result:
                for line in result:
                    if line and len(line) >= 3:
                        raw_texts.append(line[1])
                        confidences.append(float(line[2]))

        elif engine_type == "paddleocr" and ocr_engine:
            result = ocr_engine.ocr(processed, cls=False)
            if result and result[0]:
                for line in result[0]:
                    if line and len(line) >= 2:
                        text, conf = line[1]
                        raw_texts.append(text)
                        confidences.append(float(conf))

        elif engine_type == "easyocr" and ocr_engine:
            result = ocr_engine.readtext(processed)
            if result:
                for bbox, text, conf in result:
                    raw_texts.append(text)
                    confidences.append(float(conf))

        elif engine_type == "fallback":
            # Heuristic contour-based plate text detection fallback
            pass

    except Exception as exc:
        pass

    if not raw_texts:
        return "", 0.0

    full_text = "".join(raw_texts)
    avg_conf = float(np.mean(confidences)) if confidences else 0.5
    
    # Regex Sanitization: keep alphanumeric capital characters
    clean_text = re.sub(r'[^A-Z0-9]', '', full_text.upper())
    
    return clean_text, avg_conf


# ==========================================
# WORKER: High-Heavy Inference & OCR Pool
# ==========================================
def heavy_inference_worker(input_queue, output_queue, stop_event):
    from ultralytics import YOLO

    # 1. Initialize models with resilient path resolution
    plate_weights = PLATE_MODEL_PATH if (os.path.exists(PLATE_MODEL_PATH) and os.path.getsize(PLATE_MODEL_PATH) > 1000) else YOLO_MODEL_PATH
    plate_detector = YOLO(plate_weights)
    ocr_tuple = get_ocr_engine()
    
    while not stop_event.is_set():
        if input_queue.empty():
            time.sleep(0.01)
            continue
            
        try:
            item = input_queue.get(timeout=0.1)
        except Exception:
            continue

        camera_id = item['camera_id']
        track_id = item['track_id']
        vehicle_crop = item['vehicle_crop']
        timestamp = item['timestamp']
        
        # --- Stage 2A: Plate Localization ---
        best_plate_str = ""
        best_ocr_conf = 0.0
        plate_bbox = [0, 0, 0, 0]

        vh, vw = vehicle_crop.shape[:2]
        
        # Candidate 1: Plate detector inference
        try:
            plate_results = plate_detector(vehicle_crop, verbose=False)[0]
            if plate_results.boxes is not None and len(plate_results.boxes) > 0:
                for box in plate_results.boxes:
                    px1, py1, px2, py2 = map(int, box.xyxy[0].tolist())
                    plate_crop = vehicle_crop[max(0, py1):min(vh, py2), max(0, px1):min(vw, px2)]
                    plate_str, ocr_conf = run_ocr(ocr_tuple, plate_crop)
                    if ocr_conf > best_ocr_conf and len(plate_str) >= 4:
                        best_ocr_conf = ocr_conf
                        best_plate_str = plate_str
                        plate_bbox = [px1, py1, px2 - px1, py2 - py1]
        except Exception:
            pass

        # Candidate 2: Geometric heuristic (lower-third of vehicle where bumper plate sits)
        if best_ocr_conf < 0.4 and vh > 40 and vw > 40:
            bumper_y1 = int(vh * 0.65)
            bumper_crop = vehicle_crop[bumper_y1:vh, :]
            plate_str, ocr_conf = run_ocr(ocr_tuple, bumper_crop)
            if ocr_conf > best_ocr_conf and len(plate_str) >= 4:
                best_ocr_conf = ocr_conf
                best_plate_str = plate_str
                plate_bbox = [0, bumper_y1, vw, vh - bumper_y1]

        # Push Result to Stage 5 (Aggregator)
        if best_ocr_conf > 0.35 and len(best_plate_str) >= 4:
            payload = {
                "event_id": f"EVT_{int(time.time()*1000)}",
                "camera_id": camera_id,
                "timestamp": timestamp,
                "track_id": track_id,
                "vehicle": {
                    "type": item['vehicle_type'],
                    "confidence": round(item['det_confidence'], 2)
                },
                "plate": {
                    "number": best_plate_str,
                    "confidence": round(best_ocr_conf, 2),
                    "bounding_box": plate_bbox
                }
            }
            output_queue.put(payload)


# ==========================================
# STAGE 1: RTSP OpenCV Stream Reader & Vehicle Tracker
# ==========================================
def camera_stream_processor(camera_id, stream_source, input_queue, tracked_cache, stop_event):
    from ultralytics import YOLO

    # Enforce TCP transport for RTSP to prevent packet loss / visual artifacts
    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
    
    model = YOLO(YOLO_MODEL_PATH)
    tracker_config = TRACKER_CONFIG_PATH if os.path.exists(TRACKER_CONFIG_PATH) else "bytetrack.yaml"
    
    cap = cv2.VideoCapture(stream_source, cv2.CAP_FFMPEG)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)
    
    frame_count = 0
    SAMPLE_RATE = 3  # Process every 3rd frame (~10 FPS output from 30 FPS stream)
    
    while cap.isOpened() and not stop_event.is_set():
        ret, frame = cap.read()
        
        # Automatic RTSP Reconnection Logic
        if not ret or frame is None:
            time.sleep(1)
            cap.open(stream_source, cv2.CAP_FFMPEG)
            continue
            
        frame_count += 1
        if frame_count % SAMPLE_RATE != 0:
            continue
            
        # Run Tracking & Detection on vehicle classes [2: Car, 3: Motorcycle, 5: Bus, 7: Truck]
        try:
            results = model.track(frame, persist=True, classes=[2, 3, 5, 7], tracker=tracker_config, verbose=False)[0]
        except Exception:
            continue
        
        if results.boxes is None or results.boxes.id is None:
            continue
            
        boxes = results.boxes.xyxy.cpu().numpy()
        track_ids = results.boxes.id.cpu().numpy().astype(int)
        class_ids = results.boxes.cls.cpu().numpy().astype(int)
        confidences = results.boxes.conf.cpu().numpy()
        
        for box, track_id, cls_id, conf in zip(boxes, track_ids, class_ids, confidences):
            global_track_id = f"{camera_id}_{track_id}"

            if tracked_cache.get(global_track_id, 0) >= 3:
                continue 
                
            x1, y1, x2, y2 = map(int, box)
            vehicle_crop = frame[max(0, y1):min(frame.shape[0], y2), max(0, x1):min(frame.shape[1], x2)]
            
            if vehicle_crop.size == 0:
                continue
                
            vehicle_types = {2: "Car", 3: "Motorcycle", 5: "Bus", 7: "Truck"}
            
            task = {
                "camera_id": camera_id,
                "track_id": global_track_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "vehicle_crop": vehicle_crop,
                "vehicle_type": vehicle_types.get(cls_id, "Vehicle"),
                "det_confidence": float(conf)
            }
            
            if not input_queue.full():
                input_queue.put(task)
                tracked_cache[global_track_id] = tracked_cache.get(global_track_id, 0) + 1

    cap.release()


# ==========================================
# STAGE 5: Multi-Frame Aggregator & Logger
# ==========================================
def multi_frame_aggregator(output_queue, stop_event, callback=None):
    track_history = {}
    
    while not stop_event.is_set():
        if output_queue.empty():
            time.sleep(0.01)
            continue
            
        try:
            record = output_queue.get(timeout=0.1)
        except Exception:
            continue

        track_id = record['track_id']
        
        if track_id not in track_history:
            track_history[track_id] = []
            
        track_history[track_id].append(record)
        
        # Emit final payload after candidate frames collected
        if len(track_history[track_id]) >= 2:
            candidates = track_history[track_id]
            final_record = max(candidates, key=lambda x: x['plate']['confidence'])
            del final_record['track_id']
            
            print("\n[ANPR LOG GENERATED]")
            print(json.dumps(final_record, indent=2))
            
            if callback:
                callback(final_record)
            
            del track_history[track_id]


# ==========================================
# Standalone Single-Image Scanner Utility (Used by API)
# ==========================================
def scan_single_frame(frame: np.ndarray, camera_id: str = "CAM-SCAN") -> List[Dict[str, Any]]:
    """Analyzes a single frame for vehicles and extracts number plates."""
    from ultralytics import YOLO

    model = YOLO(YOLO_MODEL_PATH)
    ocr_tuple = get_ocr_engine()

    results = model(frame, classes=[2, 3, 5, 7], verbose=False)[0]
    detections = []

    if results.boxes is None or len(results.boxes) == 0:
        # Try full-frame OCR directly if no vehicle box found
        plate_str, conf = run_ocr(ocr_tuple, frame)
        if len(plate_str) >= 4 and conf > 0.35:
            detections.append({
                "event_id": f"EVT_{int(time.time()*1000)}",
                "camera_id": camera_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "vehicle": {"type": "Vehicle", "confidence": 0.8},
                "plate": {"number": plate_str, "confidence": round(conf, 2), "bounding_box": [0, 0, frame.shape[1], frame.shape[0]]}
            })
        return detections

    boxes = results.boxes.xyxy.cpu().numpy()
    class_ids = results.boxes.cls.cpu().numpy().astype(int)
    confidences = results.boxes.conf.cpu().numpy()
    vehicle_types = {2: "Car", 3: "Motorcycle", 5: "Bus", 7: "Truck"}

    for idx, (box, cls_id, conf) in enumerate(zip(boxes, class_ids, confidences)):
        x1, y1, x2, y2 = map(int, box)
        vcrop = frame[max(0, y1):min(frame.shape[0], y2), max(0, x1):min(frame.shape[1], x2)]
        if vcrop.size == 0:
            continue

        plate_str, ocr_conf = run_ocr(ocr_tuple, vcrop)
        
        # If full vehicle crop OCR was weak, try bumper region
        if ocr_conf < 0.4 and vcrop.shape[0] > 40:
            bumper_y1 = int(vcrop.shape[0] * 0.6)
            bumper_crop = vcrop[bumper_y1:, :]
            p_str2, conf2 = run_ocr(ocr_tuple, bumper_crop)
            if conf2 > ocr_conf and len(p_str2) >= 4:
                plate_str = p_str2
                ocr_conf = conf2

        if len(plate_str) >= 4:
            detections.append({
                "event_id": f"EVT_{int(time.time()*1000)}_{idx}",
                "camera_id": camera_id,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "vehicle": {"type": vehicle_types.get(cls_id, "Vehicle"), "confidence": round(float(conf), 2)},
                "plate": {"number": plate_str, "confidence": round(ocr_conf, 2), "bounding_box": [x1, y1, x2 - x1, y2 - y1]}
            })

    return detections


# ==========================================
# MAIN MULTI-STREAM ORCHESTRATOR
# ==========================================
if __name__ == "__main__":
    manager = Manager()
    input_queue = manager.Queue(maxsize=100)
    output_queue = manager.Queue()
    tracked_cache = manager.dict()
    stop_event = manager.Event()

    # RTSP Template for Sentinel cameras
    BASE_RTSP_URL = "rtsp://shreyanshsharma049%40gmail.com:ETD6-KZJG-VGF4@103.250.160.189:8554/stream"
    camera_sources = {
        f"Cam_{i:02d}": f"{BASE_RTSP_URL}/cam{i:02d}"
        for i in range(1, 5) # Default to 4 concurrent streams for testing
    }

    processes = []

    # 1. Start Heavy Inference Worker Processes
    NUM_WORKERS = 2
    for _ in range(NUM_WORKERS):
        p = Process(target=heavy_inference_worker, args=(input_queue, output_queue, stop_event))
        p.start()
        processes.append(p)

    # 2. Start Aggregator Process
    agg_proc = Process(target=multi_frame_aggregator, args=(output_queue, stop_event))
    agg_proc.start()
    processes.append(agg_proc)

    # 3. Start Camera Stream Reader Processes
    print(f"Starting ANPR Pipeline across {len(camera_sources)} camera streams...")
    for cam_id, src in camera_sources.items():
        p = Process(target=camera_stream_processor, args=(cam_id, src, input_queue, tracked_cache, stop_event))
        p.start()
        processes.append(p)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping ANPR pipeline...")
        stop_event.set()
        for p in processes:
            p.join()
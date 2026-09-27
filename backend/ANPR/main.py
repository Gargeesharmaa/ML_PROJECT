import warnings
warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")

from datetime import datetime, timezone
import cv2
import numpy as np
import time
import json
import re
from multiprocessing import Process, Queue, Manager
from ultralytics import YOLO # type: ignore
from paddleocr import PaddleOCR


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
    if h < 64:
        aspect = w / float(h)
        gray = cv2.resize(gray, (int(64 * aspect), 64), interpolation=cv2.INTER_CUBIC)
        
    # Contrast Limited Adaptive Histogram Equalization (CLAHE)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    
    return enhanced


# ==========================================
# STAGE 4: OCR Engine & Regex Validation
# ==========================================
def run_ocr(ocr_engine, plate_img):
    processed = preprocess_plate(plate_img)
    if processed is None:
        return "", 0.0
    
    # PaddleOCR expectation
    result = ocr_engine.ocr(processed, cls=False)
    if not result or not result[0]:
        return "", 0.0
    
    raw_texts = []
    confidences = []

    # Safely iterate over all OCR text regions detected on the plate
    for line in result[0]:
        if line and len(line) >= 2:
            text, conf = line[1]
            raw_texts.append(text)
            confidences.append(conf)

    if not raw_texts:
        return "", 0.0

    # Combine text fragments (e.g., top and bottom line of plate)
    full_text = "".join(raw_texts)
    avg_conf = float(np.mean(confidences))
    
    # Regex Sanitization
    clean_text = re.sub(r'[^A-Z0-9]', '', full_text.upper())
    
    return clean_text, avg_conf


# ==========================================
# WORKER: High-Heavy Inference & OCR Pool
# ==========================================
def heavy_inference_worker(input_queue, output_queue, stop_event):
    # Initialize heavy models once per worker process
    # Replace with yolov8n.pt if custom plate weights aren't present
    plate_detector = YOLO("yolov8n-plate.pt") 
    ocr_engine = PaddleOCR(use_angle_cls=False, lang='en', show_log=False)
    
    while not stop_event.is_set():
        if input_queue.empty():
            time.sleep(0.01)
            continue
            
        item = input_queue.get()
        camera_id = item['camera_id']
        track_id = item['track_id']
        vehicle_crop = item['vehicle_crop']
        timestamp = item['timestamp']
        
        # --- Stage 2A: Plate Localization ---
        plate_results = plate_detector(vehicle_crop, verbose=False)[0]
        
        best_plate_str = ""
        best_ocr_conf = 0.0
        plate_bbox = [0, 0, 0, 0]
        
        if plate_results.boxes is not None:
            for box in plate_results.boxes:
                px1, py1, px2, py2 = map(int, box.xyxy[0].tolist())
                plate_crop = vehicle_crop[py1:py2, px1:px2]
                
                # --- Stage 3 & 4: Rectification & OCR ---
                plate_str, ocr_conf = run_ocr(ocr_engine, plate_crop)
                
                if ocr_conf > best_ocr_conf and len(plate_str) >= 4:
                    best_ocr_conf = ocr_conf
                    best_plate_str = plate_str
                    plate_bbox = [px1, py1, px2 - px1, py2 - py1]
            
        # Push Result to Stage 5 (Aggregator)
        if best_ocr_conf > 0.4:
            payload = {
                "event_id": f"EVT_{int(time.time()*1000)}",
                "camera_id": camera_id,
                "timestamp": timestamp,
                "track_id": track_id,
                "vehicle": {
                    "type": item['vehicle_type'],
                    "confidence": item['det_confidence']
                },
                "plate": {
                    "number": best_plate_str,
                    "confidence": round(best_ocr_conf, 2),
                    "bounding_box": plate_bbox
                }
            }
            output_queue.put(payload)


# ==========================================
# RTSP STREAM CONFIGURATION
# ==========================================
# Template for camera endpoints with credential encoding
BASE_RTSP_URL = "rtsp://shreyanshsharma049%40gmail.com:ETD6-KZJG-VGF4@103.250.160.189:8554/stream"

# Generate camera mapping dictionary for 30 streams (cam01 to cam30)
camera_sources = {
    f"Cam_{i:02d}": f"{BASE_RTSP_URL}/cam{i:02d}"
    for i in range(1, 31)
}


# ==========================================
# STAGE 1 (UPDATED): RTSP OpenCV Stream Reader
# ==========================================
def camera_stream_processor(camera_id, stream_source, input_queue, tracked_cache, stop_event):
    # Enforce TCP transport for RTSP to prevent packet loss / visual artifacts
    import os
    os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
    
    model = YOLO("yolov8n.pt") 
    
    # Open RTSP stream explicitly via FFMPEG backend
    cap = cv2.VideoCapture(stream_source, cv2.CAP_FFMPEG)
    
    # Optional: reduce buffer size to lower real-time latency
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)
    
    frame_count = 0
    SAMPLE_RATE = 3  # Process every 3rd frame (~10 FPS output from 30 FPS stream)
    
    while cap.isOpened() and not stop_event.set_is_set():
        ret, frame = cap.read()
        
        # Automatic RTSP Reconnection Logic
        if not ret or frame is None:
            time.sleep(1)
            cap.open(stream_source, cv2.CAP_FFMPEG)
            continue
            
        frame_count += 1
        if frame_count % SAMPLE_RATE != 0:
            continue
            
        # Run Tracking & Detection
        results = model.track(frame, persist=True, classes=[2, 3, 5, 7], tracker="bytetrack.yaml", verbose=False)[0]
        
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
def multi_frame_aggregator(output_queue, stop_event):
    track_history = {}
    
    while not stop_event.is_set():
        if output_queue.empty():
            time.sleep(0.01)
            continue
            
        record = output_queue.get()
        track_id = record['track_id']
        
        if track_id not in track_history:
            track_history[track_id] = []
            
        track_history[track_id].append(record)
        
        # Emit final payload after 3 candidate frames collected
        if len(track_history[track_id]) >= 3:
            candidates = track_history[track_id]
            final_record = max(candidates, key=lambda x: x['plate']['confidence'])
            
            del final_record['track_id']
            
            print("\n[ANPR LOG GENERATED]")
            print(json.dumps(final_record, indent=2))
            
            del track_history[track_id]


# ==========================================
# MAIN MULTI-STREAM ORCHESTRATOR
# ==========================================
if __name__ == "__main__":
    manager = Manager()
    input_queue = manager.Queue(maxsize=100)
    output_queue = manager.Queue()
    tracked_cache = manager.dict()
    stop_event = manager.Event()

    # Define 30 Camera Streams
    camera_sources = {
        f"Cam_{i+1:02d}": f"rtsp://192.168.1.{100+i}/live" if i > 0 else "test_video.mp4"
        for i in range(30)
    }

    processes = []

    # 1. Start Heavy Inference Worker Processes
    NUM_WORKERS = 4
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
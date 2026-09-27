import os
import re
import json
import time
import base64
import logging
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

from fastapi import APIRouter, HTTPException, UploadFile, File, Body, status
from pydantic import BaseModel, Field

# Ensure PyTorch is imported before PaddleOCR on Windows to avoid DLL conflicts
try:
    import torch
except ImportError:
    pass

import cv2
import numpy as np

router = APIRouter(prefix="/api/anpr", tags=["ANPR Engine & Watchlist"])
logger = logging.getLogger("uvicorn.error")

ROUTER_DIR = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(ROUTER_DIR)
BASE_DIR = os.path.dirname(APP_DIR)  # points to /backend
DATA_DIR = os.path.join(BASE_DIR, "data")
ANPR_MODELS_DIR = os.path.join(BASE_DIR, "ANPR")

PLATE_MODEL_PATH = os.path.join(ANPR_MODELS_DIR, "yolov8n-plate.pt")
VEHICLE_MODEL_PATH = os.path.join(ANPR_MODELS_DIR, "yolov8n.pt")

WATCHLIST_FILE = os.path.join(DATA_DIR, "anpr_watchlist.json")
EVENTS_FILE = os.path.join(DATA_DIR, "anpr_events.json")

# Lazy-loaded AI models (loaded on first request to preserve startup speed)
_plate_detector = None
_vehicle_detector = None
_ocr_engine = None

def get_plate_detector():
    global _plate_detector
    if _plate_detector is None and os.path.exists(PLATE_MODEL_PATH):
        try:
            from ultralytics import YOLO
            _plate_detector = YOLO(PLATE_MODEL_PATH)
            logger.info("YOLOv8 Plate model loaded successfully.")
        except Exception as e:
            logger.error(f"Failed to load Plate model: {e}")
    return _plate_detector

def get_vehicle_detector():
    global _vehicle_detector
    if _vehicle_detector is None and os.path.exists(VEHICLE_MODEL_PATH):
        try:
            from ultralytics import YOLO
            _vehicle_detector = YOLO(VEHICLE_MODEL_PATH)
            logger.info("YOLOv8 Vehicle model loaded successfully.")
        except Exception as e:
            logger.error(f"Failed to load Vehicle model: {e}")
    return _vehicle_detector

def get_ocr_engine():
    global _ocr_engine
    if _ocr_engine is None:
        try:
            from paddleocr import PaddleOCR
            _ocr_engine = PaddleOCR(
                use_textline_orientation=False,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                lang="en",
                enable_mkldnn=False,
            )
            logger.info("PaddleOCR initialized successfully (MKLDNN disabled).")
        except Exception as e:
            logger.error(f"Failed to load PaddleOCR: {e}")
    return _ocr_engine

# Helper data loaders
def load_watchlist() -> List[Dict[str, Any]]:
    if os.path.exists(WATCHLIST_FILE):
        try:
            with open(WATCHLIST_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return []

def load_events() -> List[Dict[str, Any]]:
    if os.path.exists(EVENTS_FILE):
        try:
            with open(EVENTS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return []

def save_event(event: Dict[str, Any]):
    events = load_events()
    events.insert(0, event)
    # Keep last 500 events
    events = events[:500]
    try:
        with open(EVENTS_FILE, "w", encoding="utf-8") as f:
            json.dump(events, f, indent=2)
    except Exception as e:
        logger.error(f"Failed to save ANPR event: {e}")

def are_plates_similar(p1: str, p2: str) -> bool:
    """Robust fuzzy comparison between license plates accounting for OCR character confusions."""
    c1 = re.sub(r"[^A-Z0-9]", "", str(p1).upper())
    c2 = re.sub(r"[^A-Z0-9]", "", str(p2).upper())
    if not c1 or not c2:
        return False
    if c1 == c2 or c1 in c2 or c2 in c1:
        return True
    # Character normalization: map similar characters (O->0, I->1, Z->2, S->5, B->8)
    trans = str.maketrans("OIZSB", "01258")
    n1 = c1.translate(trans)
    n2 = c2.translate(trans)
    if n1 == n2 or n1 in n2 or n2 in n1:
        return True
    # Levenshtein distance check if length >= 5
    if len(c1) >= 5 and len(c2) >= 5 and abs(len(c1) - len(c2)) <= 2:
        diffs = sum(ch1 != ch2 for ch1, ch2 in zip(c1, c2)) + abs(len(c1) - len(c2))
        if diffs <= 2:
            return True
    return False

def check_watchlist(plate_number: str) -> Optional[Dict[str, Any]]:
    clean_target = re.sub(r"[^A-Z0-9]", "", plate_number.upper())
    for item in load_watchlist():
        item_clean = re.sub(r"[^A-Z0-9]", "", item.get("plate_number", "").upper())
        if clean_target and are_plates_similar(clean_target, item_clean):
            return item
    return None

def preprocess_plate(plate_crop):
    if plate_crop is None or plate_crop.size == 0:
        return None
    if len(plate_crop.shape) == 3:
        gray = cv2.cvtColor(plate_crop, cv2.COLOR_BGR2GRAY)
    else:
        gray = plate_crop
    h, w = gray.shape[:2]
    if h <= 0 or w <= 0:
        return None
    if h < 64:
        aspect = max(w / float(h), 1.0)
        new_w = max(64, int(64 * aspect))
        gray = cv2.resize(gray, (new_w, 64), interpolation=cv2.INTER_CUBIC)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    return cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)

def run_ocr(ocr_engine, plate_img):
    processed = preprocess_plate(plate_img)
    if processed is None or ocr_engine is None:
        return "", 0.0

    try:
        results = ocr_engine.predict(processed)
        texts = []
        scores = []
        for res in results:
            rec_texts = getattr(res, "rec_texts", None) or (res.get("rec_texts") if isinstance(res, dict) else None)
            rec_scores = getattr(res, "rec_scores", None) or (res.get("rec_scores") if isinstance(res, dict) else None)
            if rec_texts:
                if isinstance(rec_texts, str):
                    rec_texts = [rec_texts]
                if rec_scores is None:
                    rec_scores = [0.9] * len(rec_texts)
                for t, s in zip(rec_texts, rec_scores):
                    if t:
                        texts.append(str(t).strip())
                        scores.append(float(s) if s else 0.0)

        if not texts:
            return "", 0.0

        full_text = "".join(texts)
        clean_text = re.sub(r"[^A-Z0-9]", "", full_text.upper())
        avg_conf = float(np.mean(scores)) if scores else 0.0
        return clean_text, avg_conf
    except Exception as exc:
        logger.warning(f"OCR execution warning: {exc}")
        return "", 0.0


# Schemas
class FrameDetectionRequest(BaseModel):
    image_base64: str
    camera_id: Optional[str] = "CAM-LOCAL-WEBCAM"
    camera_code: Optional[str] = "003"
    dept_name: Optional[str] = "Surat Traffic Police - Laptop Webcam"
    target_plate: Optional[str] = None

# Endpoints
@router.get("/watchlist")
async def get_watchlist():
    """Returns the list of hotlist/stolen/wanted vehicles."""
    return load_watchlist()

@router.get("/events")
async def get_events(limit: int = 50):
    """Returns the most recent ANPR detection events."""
    events = load_events()
    return events[:limit]

@router.delete("/events")
async def clear_events():
    """Clears all stored ANPR events."""
    try:
        with open(EVENTS_FILE, "w", encoding="utf-8") as f:
            json.dump([], f)
        return {"status": "cleared", "message": "All events removed."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/events")
async def add_event(payload: Dict[str, Any] = Body(...)):
    """Accepts event payloads from background ANPR scripts."""
    plate_info = payload.get("plate", {})
    plate_num = plate_info.get("number", "")
    watchlist_match = check_watchlist(plate_num)
    
    event = {
        "event_id": payload.get("event_id") or f"EVT_{int(time.time() * 1000)}",
        "camera_id": payload.get("camera_id", "UNKNOWN"),
        "camera_code": payload.get("camera_code", payload.get("camera_id", "UNKNOWN")),
        "dept_name": payload.get("dept_name", "Gujarat Surveillance Grid"),
        "timestamp": payload.get("timestamp") or datetime.now(timezone.utc).isoformat(),
        "vehicle": payload.get("vehicle", {"type": "Vehicle", "confidence": 0.9}),
        "plate": plate_info,
        "is_watchlist_match": bool(watchlist_match),
        "watchlist_alert": watchlist_match,
        "speed": payload.get("speed", 52)
    }
    save_event(event)
    return {"status": "saved", "event": event}

@router.post("/detect-frame")
async def detect_frame(req: FrameDetectionRequest):
    """
    Live frame detection from browser webcam!
    Runs YOLOv8 Plate Detector + PaddleOCR, matches against watchlist,
    and returns bounding box and detection metadata.
    """
    raw_b64 = req.image_base64
    if "," in raw_b64:
        raw_b64 = raw_b64.split(",", 1)[1]

    try:
        img_bytes = base64.b64decode(raw_b64)
        nparr = np.frombuffer(img_bytes, np.uint8)
        frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if frame is None:
            raise ValueError("Could not decode image frame.")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid image data: {str(e)}")

    h, w = frame.shape[:2]

    plate_detector = get_plate_detector()
    ocr_engine = get_ocr_engine()

    best_plate_str = ""
    best_conf = 0.0
    plate_bbox = [0, 0, 0, 0]
    vehicle_type = "Car"

    # 1. Run Plate Detection
    if plate_detector:
        results = plate_detector(frame, verbose=False)[0]
        if results.boxes is not None and len(results.boxes) > 0:
            for box in results.boxes:
                px1, py1, px2, py2 = map(int, box.xyxy[0].tolist())
                px1 = max(0, min(px1, w))
                px2 = max(0, min(px2, w))
                py1 = max(0, min(py1, h))
                py2 = max(0, min(py2, h))

                if px2 <= px1 or py2 <= py1:
                    continue

                crop = frame[py1:py2, px1:px2]
                text, conf = run_ocr(ocr_engine, crop)
                if conf > best_conf and len(text) >= 4:
                    best_conf = conf
                    best_plate_str = text
                    plate_bbox = [px1, py1, px2 - px1, py2 - py1]

    # 2. Fallback: If plate detector didn't find a tight box, try OCR directly on center third of frame
    if not best_plate_str and ocr_engine:
        center_crop = frame[int(h * 0.25):int(h * 0.75), int(w * 0.2):int(w * 0.8)]
        text, conf = run_ocr(ocr_engine, center_crop)
        # Look for typical Indian registration plate patterns: GJ 01 ...
        if len(text) >= 4 and any(ch.isdigit() for ch in text) and any(ch.isalpha() for ch in text):
            best_plate_str = text
            best_conf = max(conf, 0.85)
            plate_bbox = [int(w * 0.2), int(h * 0.25), int(w * 0.6), int(h * 0.5)]

    if not best_plate_str:
        return {
            "detected": False,
            "message": "No license plate recognized in this frame.",
            "frame_dimensions": [w, h]
        }

    # Format plate display text nicely: "GJ01AB1234" -> "GJ 01 AB 1234"
    formatted_plate = best_plate_str
    if len(best_plate_str) >= 9 and best_plate_str[:2].isalpha():
        formatted_plate = f"{best_plate_str[:2]} {best_plate_str[2:4]} {best_plate_str[4:6]} {best_plate_str[6:]}"

    # Check target plate match (from uploaded target photo)
    target_match = False
    if req.target_plate:
        target_match = are_plates_similar(best_plate_str, req.target_plate)

    watchlist_match = check_watchlist(best_plate_str)
    
    target_alert = None
    if target_match:
        target_alert = {
            "plate_number": formatted_plate,
            "reason": "TARGET_INTERCEPTED",
            "severity": "CRITICAL",
            "description": f"Target plate {req.target_plate} actively intercepted on live camera!",
            "district": req.dept_name
        }

    active_alert = target_alert or watchlist_match

    event = {
        "event_id": f"EVT_{int(time.time() * 1000)}",
        "camera_id": req.camera_id,
        "camera_code": req.camera_code,
        "dept_name": req.dept_name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "vehicle": {"type": vehicle_type, "confidence": 0.95},
        "plate": {
            "number": formatted_plate,
            "raw_number": best_plate_str,
            "confidence": round(best_conf, 2),
            "bounding_box": plate_bbox
        },
        "is_target_match": bool(target_match),
        "is_watchlist_match": bool(active_alert),
        "watchlist_alert": active_alert,
        "speed": 48
    }

    save_event(event)

    return {
        "detected": True,
        "plate": formatted_plate,
        "raw_plate": best_plate_str,
        "confidence": round(best_conf * 100, 1),
        "bounding_box": plate_bbox,
        "frame_dimensions": [w, h],
        "vehicle_type": vehicle_type,
        "is_target_match": bool(target_match),
        "is_watchlist_match": bool(active_alert),
        "watchlist_alert": active_alert,
        "event": event
    }

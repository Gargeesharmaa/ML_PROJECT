import os
import re
import cv2
import json
import time
import base64
import logging
import threading
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any, Generator

import numpy as np

# Ensure PyTorch imports cleanly
try:
    import torch
except ImportError:
    pass

logger = logging.getLogger("uvicorn.error")

BASE_DIR = Path(__file__).resolve().parent.parent.parent  # Points to /backend
DATA_DIR = BASE_DIR / "data"
ANPR_DIR = BASE_DIR / "ANPR"
CROPS_DIR = DATA_DIR / "anpr_crops"
EVENTS_FILE = DATA_DIR / "anpr_events.json"
WATCHLIST_FILE = DATA_DIR / "anpr_watchlist.json"
CAMERAS_FILE = DATA_DIR / "cameras.json"

DEMO_VIDEO_PATH = ANPR_DIR / "test_video.mp4"
PLATE_MODEL_PATH = ANPR_DIR / "yolov8n-plate.pt"
VEHICLE_MODEL_PATH = ANPR_DIR / "yolov8n.pt"

# Ensure directories exist
CROPS_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR.mkdir(parents=True, exist_ok=True)


INDIAN_STATE_PREFIXES = {
    "GJ", "MH", "DL", "RJ", "MP", "UP", "KA", "TN", "HR", "PB", "WB",
    "AP", "TS", "KL", "CH", "GA", "UK", "UA", "JH", "BR", "OD", "AS", "HP", "JK"
}

STATE_CONFUSIONS = {
    "6J": "GJ", "0J": "GJ", "CJ": "GJ", "16": "GJ", "0U": "GJ", "62": "GJ", "02": "GJ",
    "G1": "GJ", "GI": "GJ", "GL": "GJ", "BG": "GJ", "8G": "GJ", "6G": "GJ", "BC": "GJ",
    "8C": "GJ", "8J": "GJ", "BJ": "GJ", "QJ": "GJ", "C1": "GJ", "GT": "GJ",
    "D1": "DL", "0L": "DL", "DI": "DL", "OL": "DL", "QL": "DL",
    "M1": "MH", "MI": "MH", "M4": "MH", "NH": "MH",
    "R1": "RJ", "RI": "RJ", "RL": "RJ",
    "K1": "KA", "KI": "KA", "K4": "KA",
    "H1": "HR", "HI": "HR", "H8": "HR",
    "U9": "UP", "UF": "UP", "0P": "UP",
    "NP": "MP", "M9": "MP", "N9": "MP"
}


def clean_indian_plate(text: str) -> str:
    """
    Normalizes Indian license plate numbers with domain-specific OCR correction.
    Corrects common OCR character confusions (e.g. 6J -> GJ, BG -> GJ, O/0, I/1).
    """
    raw = re.sub(r"[^A-Z0-9]", "", str(text).upper())
    if len(raw) < 4:
        return raw

    chars = list(raw)

    # 1. State code normalization (first 2 chars)
    prefix = "".join(chars[:2])
    if prefix in STATE_CONFUSIONS:
        chars[0] = STATE_CONFUSIONS[prefix][0]
        chars[1] = STATE_CONFUSIONS[prefix][1]
    elif chars[0] in ["B", "8", "6", "0", "C", "Q"] and chars[1] in ["J", "1", "I", "L"]:
        chars[0] = "G"
        chars[1] = "J"
    elif chars[0] == "G" and chars[1] in ["1", "I", "L", "T", "U"]:
        chars[1] = "J"

    # 2. Number plate digit normalization for District Code (chars 2 and 3)
    num_map = {"O": "0", "I": "1", "Z": "2", "S": "5", "B": "8", "A": "4", "U": "0", "J": "1", "Q": "0", "G": "6", "D": "0"}
    if len(chars) > 2 and chars[2] in num_map:
        chars[2] = num_map[chars[2]]
    if len(chars) > 3 and chars[3] in num_map:
        chars[3] = num_map[chars[3]]

    # 3. Series letters and 4-digit number at the end
    letter_map = {"0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "4": "A", "6": "G", "7": "T"}
    if len(chars) >= 8:
        for i in range(len(chars) - 4, len(chars)):
            if chars[i] in num_map:
                chars[i] = num_map[chars[i]]
        for i in range(4, len(chars) - 4):
            if chars[i] in letter_map:
                chars[i] = letter_map[chars[i]]

    return "".join(chars)


def is_valid_indian_plate_format(plate: str) -> bool:
    """Checks whether plate adheres to standard Indian RTO or Bharat Series format."""
    clean = re.sub(r"[^A-Z0-9]", "", str(plate).upper())
    # Standard format: e.g. GJ01AB1234, GJ051234, DL3CAA1111
    if re.match(r"^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$", clean):
        return True
    # Bharat Series format: e.g. 22BH1234AA
    if re.match(r"^[0-9]{2}BH[0-9]{4}[A-Z]{1,2}$", clean):
        return True
    return False


def _deskew_plate(img: np.ndarray) -> np.ndarray:
    """
    Detects and corrects small skew / rotation angle in number plate crops (-35 to +35 deg).
    Uses Otsu thresholding and minimum bounding box to align plate horizontally.
    """
    if img is None or img.size == 0:
        return img

    h, w = img.shape[:2]
    if h < 12 or w < 24:
        return img

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img.copy()

    try:
        _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        contours, _ = cv2.findContours(thresh, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)

        best_angle = 0.0
        max_area = 0.0
        img_area = float(h * w)

        for c in contours:
            area = cv2.contourArea(c)
            if 0.12 * img_area <= area <= 0.95 * img_area and area > max_area:
                rect = cv2.minAreaRect(c)
                angle = rect[-1]
                if angle < -45:
                    angle = 90 + angle
                elif angle > 45:
                    angle = angle - 90

                if 1.5 <= abs(angle) <= 35:
                    best_angle = angle
                    max_area = area

        if abs(best_angle) >= 1.5:
            center = (w // 2, h // 2)
            M = cv2.getRotationMatrix2D(center, best_angle, 1.0)
            rotated = cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
            return rotated
    except Exception:
        pass

    return img


def are_plates_similar(p1: str, p2: str) -> bool:
    """Robust fuzzy comparison between license plates accounting for OCR character confusions."""
    c1 = re.sub(r"[^A-Z0-9]", "", str(p1).upper())
    c2 = re.sub(r"[^A-Z0-9]", "", str(p2).upper())
    if not c1 or not c2:
        return False
    if c1 == c2 or c1 in c2 or c2 in c1:
        return True

    # Character normalization: map visually similar characters
    trans = str.maketrans("OIZSBA", "012584")
    n1 = c1.translate(trans)
    n2 = c2.translate(trans)
    if n1 == n2 or n1 in n2 or n2 in n1:
        return True

    # Levenshtein distance check if length >= 4
    if len(c1) >= 4 and len(c2) >= 4 and abs(len(c1) - len(c2)) <= 2:
        diffs = sum(ch1 != ch2 for ch1, ch2 in zip(c1, c2)) + abs(len(c1) - len(c2))
        if diffs <= 2:
            return True
    return False


def format_plate_text(raw_text: str) -> str:
    """Format raw plate alphanumeric text nicely for display."""
    clean = clean_indian_plate(raw_text)
    if len(clean) >= 9 and clean[:2].isalpha():
        prefix = clean[:2]
        dist = clean[2:4]
        series = clean[4:-4]
        digits = clean[-4:]
        if series:
            return f"{prefix} {dist} {series} {digits}"
        else:
            return f"{prefix} {dist} {digits}"
    elif len(clean) >= 6 and clean[:2].isalpha():
        return f"{clean[:2]} {clean[2:]}"
    return clean


def classify_vehicle(crop: np.ndarray, raw_cls: str, conf: float) -> str:
    """
    Intelligently classifies vehicles on Indian roads.
    Distinguishes Auto-Rickshaw (3-wheeler), Motorcycle, Bus, Truck, Van, and Car.
    """
    if raw_cls == "motorcycle":
        return "Motorcycle"
    if raw_cls == "bus":
        return "Bus"

    if crop is None or crop.size == 0:
        return raw_cls.capitalize()

    h, w = crop.shape[:2]
    aspect = h / max(1, w)

    # Detect Indian Auto-Rickshaw (Yellow roof/visor/hood + CNG green + compact profile)
    try:
        hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
        lower_yellow = np.array([15, 60, 80])
        upper_yellow = np.array([35, 255, 255])
        mask_y = cv2.inRange(hsv, lower_yellow, upper_yellow)
        yellow_ratio = np.sum(mask_y > 0) / float(h * w)

        lower_green = np.array([35, 40, 40])
        upper_green = np.array([85, 255, 255])
        mask_g = cv2.inRange(hsv, lower_green, upper_green)
        green_ratio = np.sum(mask_g > 0) / float(h * w)

        if (yellow_ratio > 0.015 or (yellow_ratio > 0.008 and green_ratio > 0.025)) and aspect > 1.05:
            return "Auto-Rickshaw"
    except Exception:
        pass

    if raw_cls == "truck":
        if aspect > 1.25 and w < 240:
            return "Auto-Rickshaw"
        if w < 260 and h < 320:
            return "Van / Mini-Truck"
        return "Truck"

    if raw_cls == "car":
        if aspect > 1.25 and w < 230:
            return "Auto-Rickshaw"
        if w > 270 and h > 270 and aspect > 0.95:
            return "Van / SUV"
        return "Car"

    return raw_cls.capitalize()


class ANPREngine:
    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super(ANPREngine, cls).__new__(cls)
                cls._instance._init_engine()
            return cls._instance

    def _init_engine(self):
        self.vehicle_model = None
        self.plate_model = None
        self.ocr_reader = None

        self.is_running = False
        self.source_type = "DEMO_VIDEO"  # "DEMO_VIDEO" | "LOCAL_WEBCAM" | "CAMERA"
        self.source_id = "demo_video"
        self.camera_id = "demo_video"
        self.camera_code = "DEMO-01"
        self.dept_name = "NH-48 Ahmedabad Expressway"
        self.source_name = "Demo Highway Traffic"
        self.rtsp_url = ""

        self.target_plate = None
        self.catched_event = None

        self.latest_frame_bytes = None
        self.fps = 0.0
        self.last_detected_plate = ""
        self.recent_plates = {}  # {plate_str: last_seen_timestamp}
        self.recent_vehicles = {}  # {v_signature: last_seen_timestamp}

        self._thread = None
        self._stop_event = threading.Event()
        self._frame_lock = threading.Lock()

    def _load_models(self):
        """Loads YOLO and EasyOCR models lazily."""
        if self.vehicle_model is None and VEHICLE_MODEL_PATH.exists():
            try:
                from ultralytics import YOLO
                self.vehicle_model = YOLO(str(VEHICLE_MODEL_PATH))
                logger.info("YOLOv8 vehicle model loaded.")
            except Exception as e:
                logger.error(f"Failed to load vehicle model: {e}")

        if self.plate_model is None and PLATE_MODEL_PATH.exists():
            try:
                from ultralytics import YOLO
                self.plate_model = YOLO(str(PLATE_MODEL_PATH))
                logger.info("YOLOv8 plate model loaded.")
            except Exception as e:
                logger.error(f"Failed to load plate model: {e}")

        if self.ocr_reader is None:
            try:
                import easyocr
                self.ocr_reader = easyocr.Reader(["en"], gpu=False)
                logger.info("EasyOCR initialized successfully on CPU.")
            except Exception as e:
                logger.error(f"Failed to load EasyOCR: {e}")

    def get_sources(self) -> List[Dict[str, Any]]:
        """Returns all available video/camera sources."""
        sources = [
            {
                "id": "demo_video",
                "name": "🎥 Demo Highway Traffic (test_video.mp4)",
                "source_type": "DEMO_VIDEO",
                "location": "NH-48 Ahmedabad-Surat Expressway",
                "camera_code": "DEMO-01",
                "rtsp_url": "",
                "status": "ONLINE"
            },
            {
                "id": "local_webcam",
                "name": "💻 Laptop Webcam (Local Device 0)",
                "source_type": "LOCAL_WEBCAM",
                "location": "Local Surveillance Station",
                "camera_code": "WEBCAM-01",
                "rtsp_url": "0",
                "status": "ONLINE"
            }
        ]

        if CAMERAS_FILE.exists():
            try:
                with open(CAMERAS_FILE, "r", encoding="utf-8") as f:
                    cams = json.load(f)
                    for cam in cams:
                        c_id = str(cam.get("id", ""))
                        code = cam.get("camera_code", "CAM")
                        dept = cam.get("dept_name", "Gujarat CCTV")
                        rtsp = cam.get("rtsp_url", "")
                        sources.append({
                            "id": c_id,
                            "name": f"📷 {code} - {dept}",
                            "source_type": "CAMERA",
                            "location": dept,
                            "camera_code": code,
                            "rtsp_url": rtsp,
                            "status": cam.get("status", "ONLINE")
                        })
            except Exception as e:
                logger.warning(f"Error loading cameras.json: {e}")

        return sources

    def load_events(self) -> List[Dict[str, Any]]:
        """Load logged ANPR events."""
        if EVENTS_FILE.exists():
            try:
                with open(EVENTS_FILE, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                pass
        return []

    def save_event(self, event: Dict[str, Any]):
        """Persist a new ANPR event."""
        events = self.load_events()
        events.insert(0, event)
        events = events[:500]
        try:
            with open(EVENTS_FILE, "w", encoding="utf-8") as f:
                json.dump(events, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to write anpr_events.json: {e}")

    def start(self, source_type: str, source_id: str = "", source_name: str = "", rtsp_url: str = "") -> Dict[str, Any]:
        """Starts the ANPR inference worker on the selected source."""
        self.stop()
        self._load_models()

        self.source_type = source_type
        self.source_id = source_id or "demo_video"
        self.camera_id = self.source_id
        self.rtsp_url = rtsp_url or ""

        if self.source_type == "DEMO_VIDEO":
            self.camera_code = "DEMO-01"
            self.dept_name = "NH-48 Ahmedabad Expressway"
            self.source_name = "Demo Highway Traffic (test_video.mp4)"

        elif self.source_type == "LOCAL_WEBCAM":
            self.camera_code = "WEBCAM-01"
            self.dept_name = "Local Surveillance Station"
            self.source_name = "Laptop Testing Webcam"
            self.rtsp_url = "0"

        elif self.source_type == "CAMERA":
            self.camera_code = "CAM"
            self.dept_name = "Gujarat Surveillance Grid"
            self.source_name = source_name or "Gujarat CCTV Camera"

            # Auto-resolve from cameras.json if registered
            if CAMERAS_FILE.exists():
                try:
                    with open(CAMERAS_FILE, "r", encoding="utf-8") as f:
                        cams = json.load(f)
                        for c in cams:
                            if str(c.get("id")) == str(self.source_id):
                                if not self.rtsp_url:
                                    self.rtsp_url = c.get("rtsp_url", "")
                                self.camera_code = c.get("camera_code", "CAM")
                                self.dept_name = c.get("dept_name", "Gujarat CCTV")
                                self.source_name = f"📷 {self.camera_code} - {self.dept_name}"
                                break
                except Exception as e:
                    logger.warning(f"Error looking up camera {self.source_id}: {e}")

        self.recent_plates = {}
        self.recent_vehicles = {}
        self._stop_event.clear()
        self.is_running = True
        self._thread = threading.Thread(target=self._worker_loop, daemon=True)
        self._thread.start()

        logger.info(f"ANPR Engine started on camera_id: {self.camera_id}, code: {self.camera_code}, source: {self.source_name} ({self.source_type}) -> RTSP: {self.rtsp_url}")
        return self.get_status()

    def stop(self) -> Dict[str, Any]:
        """Stops the active ANPR engine."""
        self.is_running = False
        self._stop_event.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=2.0)
        self._thread = None
        logger.info("ANPR Engine stopped.")
        return self.get_status()

    def get_status(self) -> Dict[str, Any]:
        """Returns the current engine status."""
        return {
            "is_running": self.is_running,
            "source_type": self.source_type,
            "source_id": self.source_id,
            "camera_id": self.camera_id,
            "camera_code": self.camera_code,
            "source_name": self.source_name,
            "dept_name": self.dept_name,
            "fps": round(self.fps, 1),
            "target_plate": self.target_plate,
            "last_detected_plate": self.last_detected_plate,
            "is_target_catched": bool(self.catched_event is not None),
            "catched_event": self.catched_event
        }

    def set_target_plate(self, plate_number: str) -> Dict[str, Any]:
        """Sets target search plate and immediately checks existing detection logs."""
        clean = clean_indian_plate(plate_number)
        if not clean:
            return {"status": "ERROR", "message": "Invalid plate number"}

        self.target_plate = clean
        self.catched_event = None

        events = self.load_events()
        for evt in events:
            evt_plate = evt.get("plate", {}).get("raw_number") or evt.get("plate", {}).get("number", "")
            if are_plates_similar(evt_plate, clean):
                self.catched_event = evt
                return {
                    "status": "CATCHED",
                    "target_plate": clean,
                    "event": evt,
                    "message": f"🚨 TARGET CATCHED! Vehicle with plate {format_plate_text(clean)} was intercepted on {evt.get('dept_name', evt.get('camera_name', 'Camera'))}."
                }

        return {
            "status": "NOT_SEEN_YET",
            "target_plate": clean,
            "message": f"Target plate {format_plate_text(clean)} locked. Actively scanning video streams across cameras..."
        }

    def search_by_image(self, image_bytes: bytes) -> Dict[str, Any]:
        """
        Runs YOLOv8 Plate Detector + EasyOCR on uploaded vehicle/plate image,
        extracts plate number, locks target, and checks if catched.
        """
        self._load_models()
        nparr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            return {"status": "ERROR", "message": "Could not decode uploaded image."}

        h, w = img.shape[:2]
        extracted_plate = ""
        best_conf = 0.0

        if self.plate_model:
            results = self.plate_model(img, verbose=False, conf=0.25)[0]
            if results.boxes is not None and len(results.boxes) > 0:
                for box in results.boxes:
                    bx1, by1, bx2, by2 = map(int, box.xyxy[0].tolist())
                    bx1, by1 = max(0, bx1), max(0, by1)
                    bx2, by2 = min(w, bx2), min(h, by2)
                    bw, bh = bx2 - bx1, by2 - by1
                    if bw >= 16 and bh >= 10:
                        # Clean margin padding so characters near edge are preserved
                        pad_x = max(3, int(bw * 0.08))
                        pad_y = max(3, int(bh * 0.12))
                        px1 = max(0, bx1 - pad_x)
                        py1 = max(0, by1 - pad_y)
                        px2 = min(w, bx2 + pad_x)
                        py2 = min(h, by2 + pad_y)
                        crop = img[py1:py2, px1:px2]
                        plate_text, conf = self._run_crop_ocr(crop)
                        if conf > best_conf and len(plate_text) >= 3:
                            best_conf = conf
                            extracted_plate = plate_text

        if not extracted_plate and self.ocr_reader:
            try:
                ocr_res = self.ocr_reader.readtext(img)
                for item in ocr_res:
                    raw = clean_indian_plate(item[1])
                    if len(raw) >= 4 and any(c.isdigit() for c in raw) and any(c.isalpha() for c in raw):
                        extracted_plate = raw
                        best_conf = float(item[2])
                        break
            except Exception as e:
                logger.warning(f"Full image OCR error: {e}")

        if not extracted_plate:
            return {
                "status": "NOT_RECOGNIZED",
                "message": "Number plate could not be recognized in the uploaded photo. Please enter plate text manually."
            }

        res = self.set_target_plate(extracted_plate)
        res["extracted_plate"] = format_plate_text(extracted_plate)
        res["raw_extracted_plate"] = extracted_plate
        res["confidence"] = round(best_conf * 100, 1)
        return res

    def clear_target(self) -> Dict[str, Any]:
        """Clears active search target."""
        self.target_plate = None
        self.catched_event = None
        return {"status": "CLEARED", "message": "Search target cleared."}

    def _run_crop_ocr(self, crop: np.ndarray) -> (str, float):
        """
        Preprocesses cropped plate through a multi-stage pipeline:
        1. Clean margin padding & upscale to clear readable scale (height >= 85px, width >= 180px)
        2. Deskewing to correct small angular rotation (-35 to +35 deg)
        3. Preprocessing variants (CLAHE + Sharpening, Adaptive Thresholding, Bilateral + Otsu, Color fallback)
        4. Multi-variant OCR tournament with Indian plate format scoring and allowlist filtering.
        """
        if crop is None or crop.size == 0 or self.ocr_reader is None:
            return "", 0.0

        ch, cw = crop.shape[:2]
        if ch < 8 or cw < 15:
            return "", 0.0

        # 1. Upscale small crops so character strokes are clear and well-defined
        scale_h = 85.0 / ch
        scale_w = 180.0 / cw
        scale = max(2.0, max(scale_h, scale_w))
        target_w = int(cw * scale)
        target_h = int(ch * scale)
        crop_upscaled = cv2.resize(crop, (target_w, target_h), interpolation=cv2.INTER_CUBIC)

        # 2. Deskew rotation
        crop_deskewed = _deskew_plate(crop_upscaled)

        # 3. Grayscale conversion
        gray = cv2.cvtColor(crop_deskewed, cv2.COLOR_BGR2GRAY)

        # Variant 1: CLAHE contrast enhancement + Unsharp mask sharpening
        clahe_engine = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
        clahe = clahe_engine.apply(gray)
        sharp = cv2.addWeighted(clahe, 1.35, cv2.GaussianBlur(clahe, (0, 0), 3), -0.35, 0)

        # Variant 2: Adaptive Gaussian thresholding (preserves character edges against glare/shadows)
        adapt = cv2.adaptiveThreshold(clahe, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 19, 9)

        # Variant 3: Bilateral noise filtering + Otsu binarization
        bilateral = cv2.bilateralFilter(gray, 7, 50, 50)
        _, otsu = cv2.threshold(bilateral, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

        variants = [
            ("sharp_clahe", sharp),
            ("adapt_thresh", adapt),
            ("bilateral_otsu", otsu),
            ("color_deskewed", crop_deskewed)
        ]

        best_candidate_text = ""
        best_candidate_conf = 0.0
        best_score = -1.0

        for var_name, var_img in variants:
            try:
                # Restrict OCR alphabet to uppercase letters and digits to prevent stray symbols
                res = self.ocr_reader.readtext(var_img, allowlist="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
                if not res:
                    continue

                # Sort detected boxes top-to-bottom then left-to-right (for split or 2-line plates)
                sorted_boxes = sorted(res, key=lambda it: (round(it[0][0][1] / 22.0), it[0][0][0]))

                token_texts = []
                token_confs = []
                for item in sorted_boxes:
                    cleaned_token = clean_indian_plate(item[1])
                    if cleaned_token:
                        token_texts.append(cleaned_token)
                        token_confs.append(float(item[2]))

                if not token_texts:
                    continue

                full_text = clean_indian_plate("".join(token_texts))
                if len(full_text) < 3:
                    continue

                avg_conf = float(np.mean(token_confs))

                # Structural heuristics for Indian number plates
                is_valid = is_valid_indian_plate_format(full_text)
                has_state_prefix = full_text[:2] in INDIAN_STATE_PREFIXES

                # Score calculation
                score = avg_conf
                if is_valid:
                    score += 0.35
                if has_state_prefix:
                    score += 0.15
                if 8 <= len(full_text) <= 10:
                    score += 0.10

                if score > best_score:
                    best_score = score
                    best_candidate_text = full_text
                    best_candidate_conf = avg_conf

                    # Early exit if high confidence and valid format
                    if avg_conf >= 0.70 and is_valid:
                        break

            except Exception as e:
                logger.debug(f"Crop OCR variant {var_name} error: {e}")

        return best_candidate_text, best_candidate_conf

    def _make_status_frame(self, title: str, subtitle: str, color=(0, 200, 255)) -> bytes:
        """Generates an informative status screen frame for the MJPEG stream."""
        frame = np.full((360, 640, 3), (20, 15, 11), dtype=np.uint8)
        cv2.rectangle(frame, (10, 10), (630, 350), (40, 30, 25), 1)
        clean_title = re.sub(r"[^\x00-\x7F]+", "", title).strip() or title
        clean_sub = re.sub(r"[^\x00-\x7F]+", "", subtitle).strip() or subtitle
        cv2.putText(frame, "GUJARAT SENTINEL ANPR GRID", (40, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (56, 189, 248), 1)
        cv2.putText(frame, clean_title, (40, 160), cv2.FONT_HERSHEY_SIMPLEX, 0.65, color, 2)
        cv2.putText(frame, clean_sub, (40, 200), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (160, 175, 190), 1)
        ret, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        return jpeg.tobytes() if ret else b""

    def _open_capture(self) -> Optional[cv2.VideoCapture]:
        """Opens video capture based on source_type."""
        if self.source_type == "DEMO_VIDEO":
            if not DEMO_VIDEO_PATH.exists():
                logger.error(f"Demo video file not found at {DEMO_VIDEO_PATH}")
                return None
            return cv2.VideoCapture(str(DEMO_VIDEO_PATH))

        elif self.source_type == "LOCAL_WEBCAM":
            cap = cv2.VideoCapture(0, cv2.CAP_DSHOW if os.name == "nt" else cv2.CAP_ANY)
            if not cap.isOpened():
                cap = cv2.VideoCapture(0)
            return cap

        elif self.source_type == "CAMERA":
            rtsp = self.rtsp_url
            if not rtsp and CAMERAS_FILE.exists():
                try:
                    with open(CAMERAS_FILE, "r", encoding="utf-8") as f:
                        cams = json.load(f)
                        for c in cams:
                            if str(c.get("id")) == str(self.source_id):
                                rtsp = c.get("rtsp_url", "")
                                self.rtsp_url = rtsp
                                break
                except Exception:
                    pass

            if not rtsp:
                logger.error("No RTSP URL provided for camera source.")
                return None

            if rtsp.startswith("webrtc:") or rtsp == "0" or rtsp == "127.0.0.1":
                cap = cv2.VideoCapture(0, cv2.CAP_DSHOW if os.name == "nt" else cv2.CAP_ANY)
                if not cap.isOpened():
                    cap = cv2.VideoCapture(0)
                return cap

            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"
            return cv2.VideoCapture(rtsp, cv2.CAP_FFMPEG)

        return None

    def _worker_loop(self):
        """
        Main inference worker:
        1. Runs YOLOv8 vehicle detection & classification (Auto-Rickshaw, Motorcycle, Bus, Truck, Car).
        2. Runs YOLOv8 plate detector & EasyOCR on plate crops.
        3. Matches plates with enclosing vehicles.
        4. Logs events and saves high-resolution plate crops.
        5. Renders tactical HUD overlay on stream.
        """
        cap = None
        for attempt in range(1, 4):
            if self._stop_event.is_set():
                return
            with self._frame_lock:
                self.latest_frame_bytes = self._make_status_frame(
                    f"CONNECTING TO {self.source_name[:28]}...",
                    f"Establishing video link (Attempt {attempt}/3)...",
                    (255, 200, 0)
                )
            cap = self._open_capture()
            if cap is not None and cap.isOpened():
                break
            time.sleep(0.5)

        if cap is None or not cap.isOpened():
            logger.error(f"Failed to open capture device/stream: {self.source_name}")
            with self._frame_lock:
                self.latest_frame_bytes = self._make_status_frame(
                    f"CAMERA OFFLINE: {self.source_name[:26]}",
                    "RTSP/Webcam stream unavailable. Check camera IP or network.",
                    (0, 0, 255)
                )
            while not self._stop_event.is_set():
                time.sleep(0.5)
            if cap:
                cap.release()
            return

        frame_count = 0
        consecutive_empty = 0
        cached_vehicles = []  # [(vtype, bbox, conf)]
        cached_plates = []    # [{bbox, plate, raw_plate, conf, is_match, vtype}]

        while not self._stop_event.is_set():
            t_start = time.time()
            ret, frame = cap.read()

            if not ret or frame is None:
                if self.source_type == "DEMO_VIDEO":
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    time.sleep(0.02)
                    continue
                else:
                    consecutive_empty += 1
                    if consecutive_empty > 30:
                        logger.warning(f"RTSP stream empty frames, reconnecting to {self.source_name}...")
                        cap.release()
                        time.sleep(0.5)
                        cap = self._open_capture()
                        consecutive_empty = 0
                    time.sleep(0.1)
                    continue

            consecutive_empty = 0

            frame_count += 1
            h, w = frame.shape[:2]

            # Run full AI detection every 3rd frame
            should_run_ai = (frame_count % 3 == 0)

            if should_run_ai:
                current_v_boxes = []
                current_p_boxes = []

                # 1. RUN VEHICLE DETECTION & CLASSIFICATION
                if self.vehicle_model:
                    v_res = self.vehicle_model(frame, verbose=False, conf=0.3, classes=[2, 3, 5, 7])[0]
                    if v_res.boxes is not None and len(v_res.boxes) > 0:
                        for vb in v_res.boxes:
                            cid = int(vb.cls[0])
                            cname = v_res.names[cid]
                            vconf = float(vb.conf[0])
                            vx1, vy1, vx2, vy2 = map(int, vb.xyxy[0].tolist())
                            vx1, vy1 = max(0, vx1), max(0, vy1)
                            vx2, vy2 = min(w, vx2), min(h, vy2)

                            if (vx2 - vx1) >= 40 and (vy2 - vy1) >= 40:
                                vcrop = frame[vy1:vy2, vx1:vx2]
                                vtype = classify_vehicle(vcrop, cname, vconf)
                                current_v_boxes.append((vtype, [vx1, vy1, vx2, vy2], vconf))

                # 2. RUN PLATE DETECTION & OCR
                if self.plate_model:
                    p_res = self.plate_model(frame, verbose=False, conf=0.22)[0]
                    if p_res.boxes is not None and len(p_res.boxes) > 0:
                        for pb in p_res.boxes:
                            bx1, by1, bx2, by2 = map(int, pb.xyxy[0].tolist())
                            bx1, by1 = max(0, bx1), max(0, by1)
                            bx2, by2 = min(w, bx2), min(h, by2)
                            bw, bh = bx2 - bx1, by2 - by1

                            if bw >= 16 and bh >= 10:
                                # Apply clean margin padding around detected plate box to prevent character clipping
                                pad_x = max(3, int(bw * 0.08))
                                pad_y = max(3, int(bh * 0.12))
                                px1 = max(0, bx1 - pad_x)
                                py1 = max(0, by1 - pad_y)
                                px2 = min(w, bx2 + pad_x)
                                py2 = min(h, by2 + pad_y)
                                crop = frame[py1:py2, px1:px2]
                                plate_text, conf = self._run_crop_ocr(crop)

                                if len(plate_text) >= 3:
                                    clean_text = clean_indian_plate(plate_text)
                                    formatted = format_plate_text(clean_text)

                                    # Associate with enclosing vehicle
                                    matched_vtype = "Car"
                                    matched_vconf = 0.92
                                    for v in current_v_boxes:
                                        vx1, vy1, vx2, vy2 = v[1]
                                        pcx, pcy = (bx1 + bx2) // 2, (by1 + by2) // 2
                                        if (vx1 - 30) <= pcx <= (vx2 + 30) and (vy1 - 40) <= pcy <= (vy2 + 50):
                                            matched_vtype = v[0]
                                            matched_vconf = v[2]
                                            break

                                    is_match = False
                                    if self.target_plate and are_plates_similar(clean_text, self.target_plate):
                                        is_match = True

                                    current_p_boxes.append({
                                        "bbox": [bx1, by1, bx2, by2],
                                        "plate": formatted,
                                        "raw_plate": clean_text,
                                        "conf": conf,
                                        "is_match": is_match,
                                        "vtype": matched_vtype
                                    })

                                    # Debounced event logging
                                    now_ts = time.time()
                                    last_seen = self.recent_plates.get(clean_text, 0)
                                    if (now_ts - last_seen) > 5.0:
                                        self.recent_plates[clean_text] = now_ts
                                        self.last_detected_plate = formatted

                                        # Save plate crop image
                                        evt_id = f"EVT_{int(now_ts * 1000)}"
                                        crop_filename = f"{evt_id}.jpg"
                                        crop_path = CROPS_DIR / crop_filename
                                        try:
                                            cv2.imwrite(str(crop_path), crop)
                                            crop_url = f"/api/anpr/crops/{crop_filename}"
                                        except Exception:
                                            crop_url = ""

                                        event_record = {
                                            "event_id": evt_id,
                                            "camera_id": self.camera_id,
                                            "camera_code": self.camera_code,
                                            "camera_name": self.source_name,
                                            "dept_name": self.dept_name,
                                            "timestamp": datetime.now(timezone.utc).isoformat(),
                                            "vehicle": {
                                                "type": matched_vtype,
                                                "confidence": round(matched_vconf, 2)
                                            },
                                            "plate": {
                                                "number": formatted,
                                                "raw_number": clean_text,
                                                "confidence": round(conf, 2),
                                                "bounding_box": [px1, py1, px2 - px1, py2 - py1]
                                            },
                                            "crop_url": crop_url,
                                            "is_target_catched": is_match,
                                            "status": "TARGET_CATCHED" if is_match else "NORMAL",
                                            "speed": 48
                                        }

                                        self.save_event(event_record)

                                        if is_match:
                                            self.catched_event = event_record
                                            logger.info(f"🚨 TARGET CATCHED ON CAMERA: {formatted} ({matched_vtype})")

                # Also track passing Auto-Rickshaws or Motorcycles even if plate was obscured
                for v in current_v_boxes:
                    vtype, vbox, vconf = v
                    if vtype in ["Auto-Rickshaw", "Motorcycle", "Bus"]:
                        # Center of vehicle
                        vcx = (vbox[0] + vbox[2]) // 2
                        vcy = (vbox[1] + vbox[3]) // 2
                        # Trigger log when passing through road tracking zone
                        if (0.12 * h) <= vcy <= (0.88 * h) and (0.10 * w) <= vcx <= (0.90 * w):
                            sig = f"{vtype}_{vcx // 120}"
                            now_ts = time.time()
                            if (now_ts - self.recent_vehicles.get(sig, 0)) > 8.0:
                                self.recent_vehicles[sig] = now_ts
                                # Check if any plate was logged nearby
                                has_plate_nearby = any(
                                    abs((p["bbox"][0] + p["bbox"][2]) // 2 - vcx) < 100
                                    for p in current_p_boxes
                                )
                                if not has_plate_nearby:
                                    # Log passing vehicle event
                                    evt_id = f"EVT_{int(now_ts * 1000)}"
                                    vcrop = frame[vbox[1]:vbox[3], vbox[0]:vbox[2]]
                                    crop_filename = f"{evt_id}.jpg"
                                    try:
                                        cv2.imwrite(str(CROPS_DIR / crop_filename), vcrop)
                                        crop_url = f"/api/anpr/crops/{crop_filename}"
                                    except Exception:
                                        crop_url = ""

                                    self.save_event({
                                        "event_id": evt_id,
                                        "camera_id": self.camera_id,
                                        "camera_code": self.camera_code,
                                        "camera_name": self.source_name,
                                        "dept_name": self.dept_name,
                                        "timestamp": datetime.now(timezone.utc).isoformat(),
                                        "vehicle": {
                                            "type": vtype,
                                            "confidence": round(vconf, 2)
                                        },
                                        "plate": {
                                            "number": f"IN-TRANSIT ({vtype})",
                                            "raw_number": vtype,
                                            "confidence": round(vconf, 2),
                                            "bounding_box": vbox
                                        },
                                        "crop_url": crop_url,
                                        "is_target_catched": False,
                                        "status": "NORMAL",
                                        "speed": 42
                                    })

                cached_vehicles = current_v_boxes
                cached_plates = current_p_boxes

            # Render tactical HUD overlay on frame
            annotated_frame = self._render_hud(frame, cached_vehicles, cached_plates)

            # Encode as JPEG for streaming
            success, enc_jpg = cv2.imencode(".jpg", annotated_frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
            if success:
                with self._frame_lock:
                    self.latest_frame_bytes = enc_jpg.tobytes()

            # FPS calculation
            elapsed = time.time() - t_start
            if elapsed > 0:
                cur_fps = 1.0 / elapsed
                self.fps = 0.9 * self.fps + 0.1 * cur_fps if self.fps > 0 else cur_fps

            sleep_time = max(0.005, (1.0 / 25.0) - elapsed)
            time.sleep(sleep_time)

        cap.release()
        self.is_running = False

    def _render_hud(self, frame: np.ndarray, vehicles: List[Any], plates: List[Dict[str, Any]]) -> np.ndarray:
        """Renders futuristic tactical HUD overlays, boxes, and target interception alert."""
        vis = frame.copy()
        h, w = vis.shape[:2]

        # 1. DRAW VEHICLE BOUNDING BOXES
        for v in vehicles:
            vtype, vbox, vconf = v
            vx1, vy1, vx2, vy2 = vbox

            # Specific colors for vehicle classes
            if vtype == "Auto-Rickshaw":
                v_color = (0, 180, 255)  # Amber / Yellow
            elif vtype == "Motorcycle":
                v_color = (255, 128, 0)  # Cyan-Blue
            elif vtype == "Bus":
                v_color = (180, 0, 255)  # Purple
            elif vtype == "Truck":
                v_color = (0, 140, 255)  # Orange
            else:
                v_color = (180, 220, 0)  # Lime / Cyan for Car

            cv2.rectangle(vis, (vx1, vy1), (vx2, vy2), v_color, 1)

            # Vehicle Label Tag
            v_tag = f"{vtype} [{int(vconf * 100)}%]"
            (tw, th), _ = cv2.getTextSize(v_tag, cv2.FONT_HERSHEY_SIMPLEX, 0.45, 1)
            cv2.rectangle(vis, (vx1, max(0, vy1 - th - 6)), (vx1 + tw + 8, vy1), v_color, -1)
            cv2.putText(vis, v_tag, (vx1 + 4, max(th + 1, vy1 - 3)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1)

        # 2. DRAW PLATE BOUNDING BOXES
        for item in plates:
            bx1, by1, bx2, by2 = item["bbox"]
            is_match = item["is_match"]
            plate_str = item["plate"]
            v_type = item.get("vtype", "Vehicle")

            box_color = (0, 0, 240) if is_match else (0, 230, 115)
            thickness = 3 if is_match else 2

            cv2.rectangle(vis, (bx1, by1), (bx2, by2), box_color, thickness)

            label_text = f"{'TARGET HIT: ' if is_match else ''}{plate_str} ({v_type})"
            (tw, th), _ = cv2.getTextSize(label_text, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 2)
            cv2.rectangle(vis, (bx1, max(0, by1 - th - 10)), (bx1 + tw + 10, by1), box_color, -1)
            cv2.putText(
                vis,
                label_text,
                (bx1 + 5, max(th + 2, by1 - 5)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                (0, 0, 0) if not is_match else (255, 255, 255),
                2
            )

        # 3. TOP-LEFT TACTICAL HUD
        cv2.rectangle(vis, (10, 10), (340, 75), (15, 23, 42), -1)
        cv2.rectangle(vis, (10, 10), (340, 75), (51, 65, 85), 1)

        clean_src = re.sub(r"[^\x00-\x7F]+", "", self.source_name).strip() or "Camera Feed"
        cv2.putText(vis, f"CAM: {clean_src[:26]}", (18, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)

        status_text = "STATUS: SCANNING ACTIVE"
        status_color = (0, 230, 115)
        if self.catched_event:
            status_text = "STATUS: TARGET CATCHED!"
            status_color = (0, 0, 255)

        cv2.putText(vis, status_text, (18, 48), cv2.FONT_HERSHEY_SIMPLEX, 0.45, status_color, 1)
        cv2.putText(vis, f"FPS: {self.fps:.1f} | VEHICLES: {len(vehicles)} | PLATES: {len(plates)}", (18, 66), cv2.FONT_HERSHEY_SIMPLEX, 0.40, (148, 163, 184), 1)

        # 4. TOP-RIGHT TARGET MONITOR HUD
        if self.target_plate:
            is_catched = (self.catched_event is not None)
            target_box_color = (0, 0, 200) if is_catched else (220, 120, 0)
            cv2.rectangle(vis, (w - 320, 10), (w - 10, 70), (15, 23, 42), -1)
            cv2.rectangle(vis, (w - 320, 10), (w - 10, 70), target_box_color, 2)

            tgt_title = "TARGET LOCK ACTIVE"
            cv2.putText(vis, tgt_title, (w - 310, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (200, 200, 200), 1)
            formatted_tgt = format_plate_text(self.target_plate)
            cv2.putText(vis, formatted_tgt, (w - 310, 52), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 255, 255), 2)

            tgt_status = "TARGET HIT!" if is_catched else "SEARCHING..."
            tgt_color = (0, 0, 255) if is_catched else (255, 200, 0)
            cv2.putText(vis, tgt_status, (w - 140, 52), cv2.FONT_HERSHEY_SIMPLEX, 0.5, tgt_color, 2)

        return vis

    def generate_mjpeg_stream(self) -> Generator[bytes, None, None]:
        """Yields MJPEG stream chunks."""
        while self.is_running:
            with self._frame_lock:
                frame_data = self.latest_frame_bytes

            if frame_data:
                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n\r\n" + frame_data + b"\r\n"
                )
            time.sleep(0.04)


# Global Singleton Instance
anpr_engine = ANPREngine()

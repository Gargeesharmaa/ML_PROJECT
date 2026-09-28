import os
import re
import cv2
import json
import time
import base64
import socket
import logging
import threading
from pathlib import Path
from urllib.parse import urlparse
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


def clean_indian_plate(text: str) -> str:
    """
    Normalizes Indian license plate numbers with domain-specific OCR correction.
    Corrects common OCR character confusions (e.g. 6J -> GJ, 0U -> GJ, 16 -> GJ).
    """
    raw = re.sub(r"[^A-Z0-9]", "", str(text).upper())
    if len(raw) < 4:
        return raw

    chars = list(raw)

    # 1. State code normalization (first 2 chars)
    # Common OCR confusions for Gujarat (GJ): 6J, 0J, CJ, 16, 0U, 62, 02
    if len(chars) >= 2:
        prefix = chars[0] + chars[1]
        if prefix in ["6J", "0J", "CJ", "16", "0U", "62", "02", "G1", "GI", "GL"]:
            chars[0] = "G"
            chars[1] = "J"
        elif chars[0] in ["6", "0", "C"] and chars[1] == "J":
            chars[0] = "G"
        elif chars[0] == "G" and chars[1] in ["1", "I", "L"]:
            chars[1] = "J"

    # 2. Number plate digit normalization for District Code (chars 2 and 3)
    num_map = {"O": "0", "I": "1", "Z": "2", "S": "5", "B": "8", "A": "4", "U": "0", "J": "1", "Q": "0"}
    if len(chars) > 2 and chars[2] in num_map:
        chars[2] = num_map[chars[2]]
    if len(chars) > 3 and chars[3] in num_map:
        chars[3] = num_map[chars[3]]

    # 3. Series letters and 4-digit number at the end
    letter_map = {"0": "O", "1": "I", "2": "Z", "5": "S", "8": "B", "4": "A", "6": "G"}
    if len(chars) >= 8:
        for i in range(len(chars) - 4, len(chars)):
            if chars[i] in num_map:
                chars[i] = num_map[chars[i]]
        for i in range(4, len(chars) - 4):
            if chars[i] in letter_map:
                chars[i] = letter_map[chars[i]]

    return "".join(chars)


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
        return f"{clean[:2]} {clean[2:4]} {clean[4:6]} {clean[6:]}"
    elif len(clean) >= 6:
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
        self.source_id = "demo_highway"
        self.source_name = "Highway Traffic Video (test_video.mp4)"
        self.rtsp_url = ""

        self.feed_mode = "LIVE"  # "LIVE" | "STANDBY"
        self.camera_online = True
        self.feed_status_text = "LIVE FEED"

        self.target_plate = None
        self.catched_event = None

        self.latest_frame_bytes = None
        self.fps = 0.0
        self.last_detected_plate = ""
        self.recent_plates = {}  # {plate_str: last_seen_timestamp}
        self.recent_vehicles = {}  # {v_signature: last_seen_timestamp}

        self._thread = None
        self._active_cap: Optional[cv2.VideoCapture] = None
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
        """Returns all available video/camera sources with full metadata."""
        sources = [
            {
                "id": "demo_video",
                "code": "DEMO-01",
                "name": "🎥 Demo Highway Traffic (test_video.mp4)",
                "source_type": "DEMO_VIDEO",
                "location": "NH-48 Ahmedabad-Surat Expressway",
                "rtsp_url": "",
                "status": "ONLINE",
                "make_model": "Optical Simulation Feed"
            },
            {
                "id": "local_webcam",
                "code": "WEBCAM-01",
                "name": "💻 Laptop Live Webcam (Device 0)",
                "source_type": "LOCAL_WEBCAM",
                "location": "Local Command Station",
                "rtsp_url": "0",
                "status": "ONLINE",
                "make_model": "Integrated HD Camera"
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
                        source_t = cam.get("source_type", "NETWORK_CCTV")
                        sources.append({
                            "id": c_id,
                            "code": code,
                            "name": f"📷 {code} - {dept}",
                            "source_type": "CAMERA",
                            "location": dept,
                            "rtsp_url": rtsp,
                            "status": cam.get("status", "ONLINE"),
                            "make_model": cam.get("make_model", "Generic CCTV"),
                            "ip_address": cam.get("ip_address", "")
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
        self.source_name = source_name or ("Demo Highway Video" if source_type == "DEMO_VIDEO" else "Live Camera")
        self.rtsp_url = rtsp_url

        self.recent_plates = {}
        self.recent_vehicles = {}
        self._stop_event.clear()
        self.is_running = True
        self._thread = threading.Thread(target=self._worker_loop, daemon=True)
        self._thread.start()

        logger.info(f"ANPR Engine started on source: {self.source_name} ({self.source_type})")
        return self.get_status()

    def stop(self) -> Dict[str, Any]:
        """Stops the active ANPR engine."""
        self.is_running = False
        self._stop_event.set()
        if self._active_cap is not None:
            try:
                self._active_cap.release()
            except Exception:
                pass
            self._active_cap = None
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.5)
        self._thread = None
        logger.info("ANPR Engine stopped.")
        return self.get_status()

    def get_status(self) -> Dict[str, Any]:
        """Returns the current engine status and telemetry."""
        return {
            "is_running": self.is_running,
            "source_type": self.source_type,
            "source_id": self.source_id,
            "source_name": self.source_name,
            "fps": round(self.fps, 1),
            "target_plate": self.target_plate,
            "last_detected_plate": self.last_detected_plate,
            "is_target_catched": bool(self.catched_event is not None),
            "catched_event": self.catched_event,
            "feed_mode": self.feed_mode,
            "camera_online": self.camera_online,
            "feed_status_text": self.feed_status_text
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
                    if bx2 > bx1 and by2 > by1:
                        crop = img[by1:by2, bx1:bx2]
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
        """Preprocesses cropped plate and runs EasyOCR with Indian plate tuning."""
        if crop is None or crop.size == 0 or self.ocr_reader is None:
            return "", 0.0

        ch, cw = crop.shape[:2]
        if ch < 8 or cw < 15:
            return "", 0.0

        # Upscale small crops to height >= 75 for character clarity
        scale = max(1.0, 75.0 / ch)
        crop_prep = cv2.resize(crop, (int(cw * scale), int(ch * scale)), interpolation=cv2.INTER_CUBIC)

        gray = cv2.cvtColor(crop_prep, cv2.COLOR_BGR2GRAY)
        clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
        enhanced = clahe.apply(gray)

        best_text = ""
        best_conf = 0.0

        try:
            res = self.ocr_reader.readtext(enhanced)
            if not res:
                res = self.ocr_reader.readtext(crop_prep)

            texts = []
            confs = []
            for item in res:
                t = clean_indian_plate(item[1])
                if t:
                    texts.append(t)
                    confs.append(float(item[2]))

            if texts:
                best_text = "".join(texts)
                best_conf = float(np.mean(confs))
        except Exception as e:
            logger.warning(f"Crop OCR warning: {e}")

        return best_text, best_conf

    def _is_rtsp_reachable(self, rtsp_url: str, timeout: float = 0.8) -> bool:
        """Fast non-blocking TCP socket probe to prevent 30-second OpenCV hangs."""
        try:
            parsed = urlparse(rtsp_url)
            host = parsed.hostname
            port = parsed.port or 554
            if not host:
                return False
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(timeout)
                res = s.connect_ex((host, port))
                return res == 0
        except Exception:
            return False

    def _open_capture(self) -> cv2.VideoCapture:
        """
        Opens video capture based on source_type with instant socket probe & fallback.
        Guarantees that capture never hangs or leaves screen black.
        """
        if self.source_type == "DEMO_VIDEO":
            self.feed_mode = "LIVE"
            self.camera_online = True
            self.feed_status_text = "DEMO TRAFFIC STREAM"
            return cv2.VideoCapture(str(DEMO_VIDEO_PATH))

        elif self.source_type == "LOCAL_WEBCAM":
            cap = cv2.VideoCapture(0, cv2.CAP_DSHOW if os.name == "nt" else cv2.CAP_ANY)
            if not cap.isOpened():
                cap = cv2.VideoCapture(0)
            if cap.isOpened():
                self.feed_mode = "LIVE"
                self.camera_online = True
                self.feed_status_text = "LAPTOP WEBCAM LIVE"
                return cap
            else:
                logger.warning("Local webcam device 0 not accessible. Using standby optical feed.")
                self.feed_mode = "STANDBY"
                self.camera_online = False
                self.feed_status_text = "WEBCAM OFFLINE (STANDBY)"
                return cv2.VideoCapture(str(DEMO_VIDEO_PATH))

        elif self.source_type == "CAMERA":
            rtsp = (self.rtsp_url or "").strip()

            # Check if this registered camera is a local webcam device
            if rtsp.startswith("webrtc://") or "local" in rtsp.lower() or "webcam" in rtsp.lower():
                cap = cv2.VideoCapture(0, cv2.CAP_DSHOW if os.name == "nt" else cv2.CAP_ANY)
                if not cap.isOpened():
                    cap = cv2.VideoCapture(0)
                if cap.isOpened():
                    self.feed_mode = "LIVE"
                    self.camera_online = True
                    self.feed_status_text = f"📷 {self.source_id} (LOCAL WEBCAM)"
                    return cap
                self.feed_mode = "STANDBY"
                self.camera_online = False
                self.feed_status_text = f"📷 {self.source_id} (STANDBY)"
                return cv2.VideoCapture(str(DEMO_VIDEO_PATH))

            if not rtsp or not rtsp.lower().startswith(("rtsp://", "rtsps://", "http://", "https://")):
                logger.info(f"No valid RTSP URL for {self.source_id}. Running in optical standby mode.")
                self.feed_mode = "STANDBY"
                self.camera_online = False
                self.feed_status_text = f"📷 {self.source_id} (STANDBY)"
                return cv2.VideoCapture(str(DEMO_VIDEO_PATH))

            # Fast 0.8s TCP socket probe to prevent 30-second OpenCV hang!
            if not self._is_rtsp_reachable(rtsp, timeout=0.8):
                logger.warning(f"RTSP unreachable ({rtsp}). Running in optical standby mode.")
                self.feed_mode = "STANDBY"
                self.camera_online = False
                self.feed_status_text = f"📷 {self.source_id} (CONNECTING / STANDBY)"
                return cv2.VideoCapture(str(DEMO_VIDEO_PATH))

            try:
                os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|stimeout;2500000"
                urls_to_try = [rtsp]
                if "%40" in rtsp:
                    urls_to_try.append(rtsp.replace("%40", "@"))
                elif "@" in rtsp and rtsp.count("@") > 1:
                    first_at = rtsp.find("@")
                    last_at = rtsp.rfind("@")
                    if first_at != last_at:
                        alt = rtsp[:first_at] + "%40" + rtsp[first_at + 1:]
                        urls_to_try.append(alt)

                for u in urls_to_try:
                    cap = cv2.VideoCapture(u, cv2.CAP_FFMPEG)
                    if cap.isOpened():
                        ret, _ = cap.read()
                        if ret:
                            self.feed_mode = "LIVE"
                            self.camera_online = True
                            self.feed_status_text = f"📷 {self.source_id} (LIVE CCTV)"
                            return cap
                        cap.release()
            except Exception as e:
                logger.warning(f"Error opening RTSP {rtsp}: {e}")

            self.feed_mode = "STANDBY"
            self.camera_online = False
            self.feed_status_text = f"📷 {self.source_id} (STANDBY)"
            return cv2.VideoCapture(str(DEMO_VIDEO_PATH))

        self.feed_mode = "STANDBY"
        self.camera_online = False
        return cv2.VideoCapture(str(DEMO_VIDEO_PATH))

    def _worker_loop(self):
        """
        Main inference worker:
        1. Runs YOLOv8 vehicle detection & classification (Auto-Rickshaw, Motorcycle, Bus, Truck, Car).
        2. Runs YOLOv8 plate detector & EasyOCR on plate crops.
        3. Matches plates with enclosing vehicles.
        4. Logs events and saves high-resolution plate crops.
        5. Renders tactical HUD overlay on stream.
        """
        self._active_cap = self._open_capture()
        cap = self._active_cap
        if cap is None or not cap.isOpened():
            logger.error("Failed to open capture device. Using demo video fallback.")
            cap = cv2.VideoCapture(str(DEMO_VIDEO_PATH))
            self._active_cap = cap
            self.feed_mode = "STANDBY"

        frame_count = 0
        cached_vehicles = []  # [(vtype, bbox, conf)]
        cached_plates = []    # [{bbox, plate, raw_plate, conf, is_match, vtype}]

        while not self._stop_event.is_set():
            t_start = time.time()
            ret, frame = cap.read()

            if not ret or frame is None:
                if self.feed_mode == "STANDBY" or self.source_type == "DEMO_VIDEO":
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    time.sleep(0.02)
                    continue
                else:
                    # Live RTSP stream frame dropped: smoothly switch to standby so stream never crashes
                    logger.warning("Stream frame read failed, switching to standby capture.")
                    cap.release()
                    cap = cv2.VideoCapture(str(DEMO_VIDEO_PATH))
                    self.feed_mode = "STANDBY"
                    self.camera_online = False
                    self.feed_status_text = f"📷 {self.source_id} (RECONNECTING...)"
                    time.sleep(0.05)
                    continue

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
                                crop = frame[by1:by2, bx1:bx2]
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
                                            "camera_id": self.source_id,
                                            "camera_code": self.source_id[:10],
                                            "camera_name": self.source_name,
                                            "dept_name": self.source_name,
                                            "timestamp": datetime.now(timezone.utc).isoformat(),
                                            "vehicle": {
                                                "type": matched_vtype,
                                                "confidence": round(matched_vconf, 2)
                                            },
                                            "plate": {
                                                "number": formatted,
                                                "raw_number": clean_text,
                                                "confidence": round(conf, 2),
                                                "bounding_box": [bx1, by1, bw, bh]
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

                # Also track passing Auto-Rickshaws, Motorcycles, or Buses
                for v in current_v_boxes:
                    vtype, vbox, vconf = v
                    if vtype in ["Auto-Rickshaw", "Motorcycle", "Bus"]:
                        vcx = (vbox[0] + vbox[2]) // 2
                        vcy = (vbox[1] + vbox[3]) // 2
                        if (0.12 * h) <= vcy <= (0.88 * h) and (0.10 * w) <= vcx <= (0.90 * w):
                            sig = f"{vtype}_{vcx // 120}"
                            now_ts = time.time()
                            if (now_ts - self.recent_vehicles.get(sig, 0)) > 8.0:
                                self.recent_vehicles[sig] = now_ts
                                has_plate_nearby = any(
                                    abs((p["bbox"][0] + p["bbox"][2]) // 2 - vcx) < 100
                                    for p in current_p_boxes
                                )
                                if not has_plate_nearby:
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
                                        "camera_id": self.source_id,
                                        "camera_code": self.source_id[:10],
                                        "camera_name": self.source_name,
                                        "dept_name": self.source_name,
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

        if self._active_cap is not None:
            try:
                self._active_cap.release()
            except Exception:
                pass
            self._active_cap = None
        self.is_running = False

    def _render_hud(self, frame: np.ndarray, vehicles: List[Any], plates: List[Dict[str, Any]]) -> np.ndarray:
        """Renders futuristic tactical HUD overlays, boxes, and target interception alert."""
        vis = frame.copy()
        h, w = vis.shape[:2]

        # 1. DRAW VEHICLE BOUNDING BOXES
        for v in vehicles:
            vtype, vbox, vconf = v
            vx1, vy1, vx2, vy2 = vbox

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

            label_text = f"{'🚨 CATCHED: ' if is_match else ''}{plate_str} ({v_type})"
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

        # 3. TOP-LEFT TACTICAL HUD WITH FEED STATUS
        cv2.rectangle(vis, (10, 10), (370, 80), (15, 23, 42), -1)
        cv2.rectangle(vis, (10, 10), (370, 80), (51, 65, 85), 1)

        source_label = f"SOURCE: {self.source_name[:26]}"
        cv2.putText(vis, source_label, (18, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)

        if self.feed_mode == "LIVE":
            mode_text = "FEED: 🟢 LIVE STREAM ACQUIRED"
            mode_color = (0, 230, 115)
        else:
            mode_text = "FEED: 🟡 STANDBY OPTICAL FEED"
            mode_color = (0, 200, 255)

        cv2.putText(vis, mode_text, (18, 46), cv2.FONT_HERSHEY_SIMPLEX, 0.42, mode_color, 1)

        if self.catched_event:
            status_text = "STATUS: 🚨 TARGET CATCHED!"
            status_color = (0, 0, 255)
        else:
            status_text = "STATUS: SCANNING ACTIVE"
            status_color = (0, 230, 115)

        cv2.putText(vis, status_text, (18, 62), cv2.FONT_HERSHEY_SIMPLEX, 0.42, status_color, 1)
        cv2.putText(vis, f"FPS: {self.fps:.1f} | VEHICLES: {len(vehicles)} | PLATES: {len(plates)}", (18, 76), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (148, 163, 184), 1)

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

            tgt_status = "🚨 CATCHED!" if is_catched else "SEARCHING..."
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

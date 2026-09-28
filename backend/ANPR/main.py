"""
ANPR Pipeline - Debugged / PaddleOCR 3.x compatible version

Pipeline:
Camera -> Vehicle Detection/Tracking -> Plate Detection -> OCR -> Aggregator

Safe defaults:
- 1 camera only
- test_video.mp4 as the source
- 1 heavy OCR worker on CPU

For production, configure CAMERA_SOURCES_JSON / NUM_CAMERAS / NUM_WORKERS
through environment variables instead of hard-coding credentials.
"""

import json
import os
import sys
import re
import time
import warnings
from datetime import datetime, timezone
from multiprocessing import Event, Process, Queue
from queue import Empty, Full

import cv2
import numpy as np

try:
    import torch
except ImportError:
    pass

from paddleocr import PaddleOCR
from ultralytics import YOLO


os.environ["FLAGS_use_mkldnn"] = "0"
os.environ["PADDLE_PDX_ENABLE_MKLDNN_BYDEFAULT"] = "0"
os.environ["OPENCV_FFMPEG_LOGLEVEL"] = "-8"  # Sets FFmpeg log to QUIET/PANIC only
os.environ["AV_LOG_FORCE_NOCOLOR"] = "1"

warnings.filterwarnings("ignore", category=UserWarning, module="pydantic")
cv2.setLogLevel(0)  

# ============================================================
# CONFIGURATION
# ============================================================

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "data"))
EVENTS_FILE = os.path.join(DATA_DIR, "anpr.json")
CAMERAS_FILE = os.path.join(DATA_DIR, "cameras.json")




VEHICLE_MODEL = os.getenv(
    "VEHICLE_MODEL",
    os.path.join(BASE_DIR, "yolov8n.pt"),
)

PLATE_MODEL = os.getenv(
    "PLATE_MODEL",
    os.path.join(BASE_DIR, "yolov8n-plate.pt"),
)

# CPU-safe defaults. Increase only after the single-camera test works.
NUM_WORKERS = max(1, int(os.getenv("NUM_WORKERS", "2")))
NUM_CAMERAS = max(1, int(os.getenv("NUM_CAMERAS", "1")))

SAMPLE_RATE = max(1, int(os.getenv("SAMPLE_RATE", "15")))
QUEUE_SIZE = max(10, int(os.getenv("QUEUE_SIZE", "200")))

# Default is local test video. For RTSP, set CAMERA_SOURCES_JSON.
DEFAULT_CAMERA_SOURCE = os.getenv(
    "DEFAULT_CAMERA_SOURCE",
    os.path.join(BASE_DIR, "test_video.mp4"),
)

# Optional JSON:
# {"Cam_01":"rtsp://user:password@host:8554/stream/cam01",
#  "Cam_02":"rtsp://user:password@host:8554/stream/cam02"}
CAMERA_SOURCES_JSON = os.getenv("CAMERA_SOURCES_JSON", "").strip()


# ============================================================
# UTILITIES
# ============================================================

def model_path_check(path, label):
    if not os.path.isfile(path):
        raise FileNotFoundError(
            f"{label} not found:\n{path}\n"
            f"Put the model file at this location or set the corresponding "
            f"environment variable."
        )

def load_camera_sources(use_test_video=False, max_cams=None):
    if use_test_video:
        print("[CAMERA LOADER] Using local test_video.mp4", flush=True)
        return {"Cam_01": os.path.join(BASE_DIR, "test_video.mp4")}

    if os.path.exists(CAMERAS_FILE):
        try:
            with open(CAMERAS_FILE, "r", encoding="utf-8") as f:
                cams = json.load(f)
            rtsp_sources = {}
            for c in cams:
                url = c.get("rtsp_url", "")
                if url.startswith("rtsp://"):
                    code = c.get("camera_code") or f"CAM_{len(rtsp_sources) + 1}"
                    rtsp_sources[code] = url
                    if max_cams and len(rtsp_sources) >= max_cams:
                        break  # Stop when max_cams limit is reached
            
            if rtsp_sources:
                print(f"[CAMERA LOADER] Loaded {len(rtsp_sources)} RTSP camera(s) from cameras.json", flush=True)
                return rtsp_sources
        except Exception as exc:
            print(f"[CAMERA LOADER ERROR] Could not read cameras.json: {exc}", flush=True)

    return {"Cam_01": DEFAULT_CAMERA_SOURCE}




def open_capture(source):
    """Open local file, webcam index or RTSP source with reasonable retry behavior."""
    if str(source).isdigit():
        return cv2.VideoCapture(int(source))

    is_rtsp = str(source).lower().startswith(("rtsp://", "rtsps://"))

    if is_rtsp:
        # Must be set before VideoCapture is created.
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|buffer_size;1024000|max_delay;500000"
        cap = cv2.VideoCapture(source, cv2.CAP_FFMPEG)
    else:
        cap = cv2.VideoCapture(source)

    if cap.isOpened():
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)

    return cap


# ============================================================
# STAGE 3: IMAGE RECTIFICATION & PREPROCESSING
# ============================================================

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
        gray = cv2.resize(
            gray,
            (new_w, 64),
            interpolation=cv2.INTER_CUBIC,
        )

    clahe = cv2.createCLAHE(
        clipLimit=2.0,
        tileGridSize=(8, 8),
    )
    enhanced = clahe.apply(gray)
    # PaddleOCR 3-channel (H, W, 3) image expect karta hai:
    return cv2.cvtColor(enhanced, cv2.COLOR_GRAY2BGR)


# ============================================================
# STAGE 4: PADDLEOCR 3.x + OCR RESULT NORMALIZATION
# ============================================================

def _get_result_field(result, name):
    """Read PaddleOCR result fields from dict/object/legacy containers."""
    if isinstance(result, dict):
        return result.get(name)

    value = getattr(result, name, None)
    if value is not None:
        return value

    try:
        return result[name]
    except Exception:
        return None


def _normalize_ocr_result(results):
    """
    Normalize PaddleOCR 3.x predict() output.

    PaddleOCR 3.x exposes recognized text and scores through result fields
    such as rec_texts and rec_scores. A small legacy fallback is included
    so the pipeline fails gracefully if an older result structure appears.
    """
    texts = []
    scores = []

    if results is None:
        return texts, scores

    # PaddleOCR 3.x: predict() returns an iterable of result objects.
    try:
        result_items = list(results)
    except TypeError:
        result_items = [results]

    for result in result_items:
        rec_texts = _get_result_field(result, "rec_texts")
        rec_scores = _get_result_field(result, "rec_scores")

        if rec_texts is not None:
            if isinstance(rec_texts, str):
                rec_texts = [rec_texts]

            if rec_scores is None:
                rec_scores = [1.0] * len(rec_texts)

            for text, score in zip(rec_texts, rec_scores):
                if text is None:
                    continue

                text = str(text).strip()

                try:
                    score = float(score)
                except (TypeError, ValueError):
                    score = 0.0

                if text:
                    texts.append(text)
                    scores.append(score)

            continue

        # Legacy PaddleOCR-style fallback.
        if isinstance(result, list):
            for line in result:
                if (
                    isinstance(line, (list, tuple))
                    and len(line) >= 2
                    and isinstance(line[1], (list, tuple))
                    and len(line[1]) >= 2
                ):
                    text = str(line[1][0]).strip()
                    try:
                        score = float(line[1][1])
                    except (TypeError, ValueError):
                        score = 0.0

                    if text:
                        texts.append(text)
                        scores.append(score)

    return texts, scores


def run_ocr(ocr_engine, plate_img):
    processed = preprocess_plate(plate_img)

    if processed is None:
        return "", 0.0

    try:
        # PaddleOCR 3.x API.
        results = ocr_engine.predict(processed)
        raw_texts, confidences = _normalize_ocr_result(results)
    except Exception as exc:
        print(f"[OCR ERROR] {type(exc).__name__}: {exc}")
        return "", 0.0

    if not raw_texts:
        return "", 0.0

    full_text = "".join(raw_texts)

    avg_conf = (
        float(np.mean(confidences))
        if confidences
        else 0.0
    )

    clean_text = re.sub(
        r"[^A-Z0-9]",
        "",
        full_text.upper(),
    )

    return clean_text, avg_conf


# ============================================================
# WORKER: PLATE DETECTION + OCR
# ============================================================

def heavy_inference_worker(input_queue, output_queue, stop_event):
    print(f"[OCR WORKER {os.getpid()}] Starting...", flush=True)

    try:
        model_path_check(PLATE_MODEL, "Plate model")
        plate_detector = YOLO(PLATE_MODEL)

        # PaddleOCR 3.x constructor with MKLDNN disabled for CPU stability.
        ocr_engine = PaddleOCR(
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            lang="en",
            enable_mkldnn=False,
        )


        print(
            f"[OCR WORKER {os.getpid()}] Models ready.",
            flush=True,
        )

    except Exception as exc:
        print(
            f"[OCR WORKER {os.getpid()}] STARTUP ERROR: "
            f"{type(exc).__name__}: {exc}",
            flush=True,
        )
        stop_event.set()
        return

    while not stop_event.is_set():
        try:
            item = input_queue.get(timeout=0.2)
        except Empty:
            continue

        if item is None:
            continue

        try:
            camera_id = item["camera_id"]
            track_id = item["track_id"]
            vehicle_crop = item["vehicle_crop"]
            timestamp = item["timestamp"]

            plate_results = plate_detector(
                vehicle_crop,
                verbose=False,
            )[0]

            best_plate_str = ""
            best_ocr_conf = 0.0
            plate_bbox = [0, 0, 0, 0]

            if plate_results.boxes is not None:
                for box in plate_results.boxes:
                    px1, py1, px2, py2 = map(
                        int,
                        box.xyxy[0].tolist(),
                    )

                    # Clamp coordinates to vehicle crop.
                    h, w = vehicle_crop.shape[:2]
                    px1 = max(0, min(px1, w))
                    px2 = max(0, min(px2, w))
                    py1 = max(0, min(py1, h))
                    py2 = max(0, min(py2, h))

                    if px2 <= px1 or py2 <= py1:
                        continue

                    plate_crop = vehicle_crop[
                        py1:py2,
                        px1:px2,
                    ]

                    plate_str, ocr_conf = run_ocr(
                        ocr_engine,
                        plate_crop,
                    )

                    if (
                        ocr_conf > best_ocr_conf
                        and len(plate_str) >= 4
                    ):
                        best_ocr_conf = ocr_conf
                        best_plate_str = plate_str
                        plate_bbox = [
                            px1,
                            py1,
                            px2 - px1,
                            py2 - py1,
                        ]

            if best_ocr_conf > 0.4:
                payload = {
                    "event_id": f"EVT_{int(time.time() * 1000)}",
                    "camera_id": camera_id,
                    "timestamp": timestamp,
                    "track_id": track_id,
                    "vehicle": {
                        "type": item["vehicle_type"],
                        "confidence": item["det_confidence"],
                    },
                    "plate": {
                        "number": best_plate_str,
                        "confidence": round(best_ocr_conf, 2),
                        "bounding_box": plate_bbox,
                    },
                }

                try:
                    output_queue.put(
                        payload,
                        timeout=0.2,
                    )
                except Full:
                    print(
                        "[OCR WORKER] Output queue full; "
                        "dropping result.",
                        flush=True,
                    )

        except Exception as exc:
            print(
                f"[OCR WORKER ERROR] {type(exc).__name__}: {exc}",
                flush=True,
            )


# ============================================================
# STAGE 1: CAMERA STREAM + VEHICLE DETECTION/TRACKING
# ============================================================

def camera_stream_processor(
    camera_id,
    stream_source,
    input_queue,
    stop_event,
):
    print(
        f"[{camera_id}] Starting source: {stream_source}",
        flush=True,
    )

    try:
        model_path_check(VEHICLE_MODEL, "Vehicle model")
        model = YOLO(VEHICLE_MODEL)
    except Exception as exc:
        print(
            f"[{camera_id}] MODEL ERROR: "
            f"{type(exc).__name__}: {exc}",
            flush=True,
        )
        return

    is_file = not str(stream_source).lower().startswith(
        ("rtsp://", "rtsps://")
    )

    cap = None
    frame_count = 0
    tracked_cache = {}

    vehicle_types = {
        2: "Car",
        3: "Motorcycle",
        5: "Bus",
        7: "Truck",
    }

    while not stop_event.is_set():
        if cap is None or not cap.isOpened():
            if cap is not None:
                cap.release()

            cap = open_capture(stream_source)

            if not cap.isOpened():
                print(
                    f"[{camera_id}] Unable to open source. "
                    f"Retrying in 2 seconds...",
                    flush=True,
                )
                time.sleep(2)
                continue

            print(
                f"[{camera_id}] Stream opened.",
                flush=True,
            )

        # Grab the frame header without decompressing the full image (saves 85% CPU)
        if not cap.grab():
            if is_file:
                print(f"[{camera_id}] Video finished. Stopping stream.", flush=True)
                break

            print(f"[{camera_id}] RTSP read failed; reconnecting in 2s...", flush=True)
            cap.release()
            cap = None
            time.sleep(2)
            continue

        frame_count += 1

        # Skip decoding if it's not the sample frame
        if frame_count % SAMPLE_RATE != 0:
            continue

        # Only decode the actual frame we want to process
        ret, frame = cap.retrieve()
        if not ret or frame is None:
            continue


        try:
            results = model.track(
                frame,
                persist=True,
                classes=[2, 3, 5, 7],
                tracker="bytetrack.yaml",
                verbose=False,
            )[0]
        except Exception as exc:
            print(
                f"[{camera_id}] DETECTION ERROR: "
                f"{type(exc).__name__}: {exc}",
                flush=True,
            )
            continue

        if (
            results.boxes is None
            or results.boxes.id is None
        ):
            continue

        boxes = results.boxes.xyxy.cpu().numpy()
        track_ids = (
            results.boxes.id.cpu().numpy().astype(int)
        )
        class_ids = (
            results.boxes.cls.cpu().numpy().astype(int)
        )
        confidences = results.boxes.conf.cpu().numpy()

        for box, track_id, cls_id, conf in zip(
            boxes,
            track_ids,
            class_ids,
            confidences,
        ):
            global_track_id = f"{camera_id}_{track_id}"

            # OCR at most 3 times per tracked vehicle.
            if tracked_cache.get(global_track_id, 0) >= 3:
                continue

            x1, y1, x2, y2 = map(int, box)

            h, w = frame.shape[:2]

            x1 = max(0, min(x1, w))
            x2 = max(0, min(x2, w))
            y1 = max(0, min(y1, h))
            y2 = max(0, min(y2, h))

            if x2 <= x1 or y2 <= y1:
                continue

            vehicle_crop = frame[y1:y2, x1:x2]

            if vehicle_crop.size == 0:
                continue

            task = {
                "camera_id": camera_id,
                "track_id": global_track_id,
                "timestamp": datetime.now(
                    timezone.utc
                ).isoformat(),
                "vehicle_crop": vehicle_crop,
                "vehicle_type": vehicle_types.get(
                    int(cls_id),
                    "Vehicle",
                ),
                "det_confidence": float(conf),
            }

            try:
                input_queue.put(
                    task,
                    timeout=0.05,
                )
                tracked_cache[global_track_id] = (
                    tracked_cache.get(global_track_id, 0) + 1
                )
            except Full:
                # Back-pressure: skip this frame instead of blocking
                # every camera process.
                continue

    if cap is not None:
        cap.release()

    print(
        f"[{camera_id}] Stopped.",
        flush=True,
    )


# ============================================================
# STAGE 5: MULTI-FRAME AGGREGATOR
# ============================================================
def save_event_to_json(event_record):
    """Appends detected events to data/anpr.json so the frontend can read them."""
    try:
        events = []
        if os.path.exists(EVENTS_FILE):
            try:
                with open(EVENTS_FILE, "r", encoding="utf-8") as f:
                    content = f.read().strip()
                    if content:
                        events = json.loads(content)
            except Exception:
                events = []

        # Prepend the new detection (newest first)
        events.insert(0, event_record)

        # Keep latest 200 events
        events = events[:200]

        with open(EVENTS_FILE, "w", encoding="utf-8") as f:
            json.dump(events, f, indent=2)

    except Exception as exc:
        print(f"[SAVE ERROR] Failed to write event to file: {exc}", flush=True)

def multi_frame_aggregator(output_queue, stop_event):
    track_history = {}

    print(
        f"[AGGREGATOR {os.getpid()}] Started.",
        flush=True,
    )

    while not stop_event.is_set():
        try:
            record = output_queue.get(timeout=0.2)
        except Empty:
            continue

        if not record:
            continue

        track_id = record.get("track_id")

        if not track_id:
            continue

        track_history.setdefault(track_id, []).append(record)

        if len(track_history[track_id]) >= 1:
            candidates = track_history[track_id]

            final_record = max(
                candidates,
                key=lambda x: x["plate"]["confidence"],
            )

            final_record = dict(final_record)
            final_record.pop("track_id", None)

            print(
                "\n[ANPR LOG GENERATED]",
                flush=True,
            )
            print(
                json.dumps(
                    final_record,
                    indent=2,
                ),
                flush=True,
            )

            # --- WRITE TO JSON FILE ---
            save_event_to_json(final_record)

            # Sync event with FastAPI backend (Port 8000)
            try:
                import urllib.request
                req = urllib.request.Request(
                    "http://127.0.0.1:8000/api/anpr/events",
                    data=json.dumps(final_record).encode("utf-8"),
                    headers={"Content-Type": "application/json"}
                )
                urllib.request.urlopen(req, timeout=1.5)
            except Exception as e:
                pass

            del track_history[track_id]



# ============================================================
# MAIN ORCHESTRATOR
# ============================================================

def main():
    print("=" * 60)
    print("ANPR PIPELINE - DEBUGGED VERSION")
    print("=" * 60)

    model_path_check(VEHICLE_MODEL, "Vehicle model")
    model_path_check(PLATE_MODEL, "Plate model")

    camera_sources = load_camera_sources(use_test_video=False, max_cams=5)

    print(f"Vehicle model : {VEHICLE_MODEL}")
    print(f"Plate model   : {PLATE_MODEL}")
    print(f"OCR workers   : {NUM_WORKERS}")
    print(f"Camera streams: {len(camera_sources)}")
    print()

    # IMPORTANT:
    # multiprocessing.Queue/Event work cleanly with Windows spawn.
    input_queue = Queue(maxsize=QUEUE_SIZE)
    output_queue = Queue(maxsize=QUEUE_SIZE)
    stop_event = Event()

    processes = []

    try:
        # 1. Heavy OCR/plate workers.
        for worker_index in range(NUM_WORKERS):
            p = Process(
                target=heavy_inference_worker,
                args=(
                    input_queue,
                    output_queue,
                    stop_event,
                ),
                name=f"OCRWorker-{worker_index + 1}",
            )
            p.start()
            processes.append(p)

        # 2. Aggregator.
        agg_proc = Process(
            target=multi_frame_aggregator,
            args=(
                output_queue,
                stop_event,
            ),
            name="Aggregator",
        )
        agg_proc.start()
        processes.append(agg_proc)

        # 3. Camera readers.
        print(
            f"Starting ANPR Pipeline across "
            f"{len(camera_sources)} camera stream(s)...",
            flush=True,
        )

        for cam_id, source in camera_sources.items():
            p = Process(
                target=camera_stream_processor,
                args=(
                    cam_id,
                    source,
                    input_queue,
                    stop_event,
                ),
                name=f"Camera-{cam_id}",
            )
            p.start()
            processes.append(p)
            time.sleep(0.5)
        # Keep parent alive.
        while True:
            time.sleep(1)

            # If a worker dies immediately, show it instead of silently
            # running a broken pipeline.
            for p in processes:
                if not p.is_alive() and p.exitcode not in (0, None):
                    print(
                        f"[PROCESS ERROR] {p.name} exited "
                        f"with code {p.exitcode}.",
                        flush=True,
                    )

    except KeyboardInterrupt:
        print(
            "\nStopping ANPR pipeline...",
            flush=True,
        )

    finally:
        stop_event.set()

        # Unblock queue consumers.
        for _ in range(NUM_WORKERS):
            try:
                input_queue.put_nowait(None)
            except Exception:
                break

        for p in processes:
            p.join(timeout=5)

        for p in processes:
            if p.is_alive():
                p.terminate()

        print(
            "ANPR pipeline stopped.",
            flush=True,
        )


if __name__ == "__main__":
    main()

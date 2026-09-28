import os
import re
import cv2
import json
import time
import base64
import logging
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

import numpy as np
from fastapi import APIRouter, HTTPException, UploadFile, File, Body, status
from fastapi.responses import StreamingResponse, FileResponse
from pydantic import BaseModel, Field

from app.services.anpr_engine import anpr_engine, CROPS_DIR, format_plate_text

router = APIRouter(prefix="/api/anpr", tags=["ANPR Intelligence & Surveillance"])
logger = logging.getLogger("uvicorn.error")


class StartEngineRequest(BaseModel):
    source_type: str = Field("DEMO_VIDEO", description="DEMO_VIDEO | LOCAL_WEBCAM | CAMERA")
    source_id: Optional[str] = "demo_video"
    source_name: Optional[str] = "Demo Highway Traffic"
    rtsp_url: Optional[str] = ""


class SearchPlateRequest(BaseModel):
    plate_number: str


class WatchlistEntryRequest(BaseModel):
    plate_number: str
    reason: str = Field("Suspect", description="Stolen | Wanted | Suspect | Other")
    notes: Optional[str] = ""


class FrameDetectionRequest(BaseModel):
    image_base64: str
    camera_id: Optional[str] = "CAM-LOCAL-WEBCAM"
    camera_code: Optional[str] = "003"
    dept_name: Optional[str] = "Surat Traffic Police - Laptop Webcam"
    target_plate: Optional[str] = None


@router.get("/sources")
async def get_sources():
    """List all available sources: Demo Video, Laptop Webcam, and Registered CCTV Cameras."""
    return anpr_engine.get_sources()


@router.post("/start")
async def start_stream(req: StartEngineRequest):
    """Start ANPR processing on the selected camera/video source."""
    status_info = anpr_engine.start(
        source_type=req.source_type,
        source_id=req.source_id or "source",
        source_name=req.source_name or "Active Source",
        rtsp_url=req.rtsp_url or ""
    )
    return status_info


@router.post("/stop")
async def stop_stream():
    """Stop active ANPR processing."""
    return anpr_engine.stop()


@router.get("/status")
async def get_engine_status():
    """Get active engine telemetry (FPS, running state, active target, detections)."""
    return anpr_engine.get_status()


@router.get("/stream")
async def get_stream():
    """Live MJPEG stream of annotated AI video with bounding boxes and HUD overlays."""
    if not anpr_engine.is_running:
        # If user has already chosen a camera or webcam, resume that source
        if anpr_engine.source_id and anpr_engine.source_type and anpr_engine.source_id != "demo_video":
            anpr_engine.start(
                anpr_engine.source_type,
                anpr_engine.source_id,
                anpr_engine.source_name,
                anpr_engine.rtsp_url
            )
        else:
            anpr_engine.start("DEMO_VIDEO", "demo_video", "Demo Highway Video (test_video.mp4)")

    return StreamingResponse(
        anpr_engine.generate_mjpeg_stream(),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )


@router.get("/events")
async def get_events(camera_id: Optional[str] = None, camera_code: Optional[str] = None, limit: int = 100):
    """
    Returns real vehicle passing logs.
    If camera_id or camera_code is provided, strictly filters detections for that camera.
    """
    events = anpr_engine.load_events()
    if camera_id:
        def match_cam(e):
            e_cam = str(e.get("camera_id", ""))
            if e_cam == str(camera_id):
                return True
            if camera_id in ["demo_video", "demo_highway"] and e_cam in ["demo_video", "demo_highway"]:
                return True
            return False
        events = [e for e in events if match_cam(e)]
    elif camera_code:
        events = [
            e for e in events
            if str(e.get("camera_code", "")).lower() == str(camera_code).lower()
        ]
    return events[:limit]


@router.delete("/events")
async def clear_events(camera_id: Optional[str] = None):
    """Clears all stored events or only those for the specified camera."""
    try:
        from app.services.anpr_engine import EVENTS_FILE
        if not camera_id:
            with open(EVENTS_FILE, "w", encoding="utf-8") as f:
                json.dump([], f)
        else:
            all_events = anpr_engine.load_events()
            remaining = [
                e for e in all_events
                if str(e.get("camera_id")) != str(camera_id)
                and not (camera_id in ["demo_video", "demo_highway"] and str(e.get("camera_id")) in ["demo_video", "demo_highway"])
            ]
            with open(EVENTS_FILE, "w", encoding="utf-8") as f:
                json.dump(remaining, f, indent=2)
        return {"status": "cleared", "message": "ANPR detection logs cleared."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/search")
async def search_plate(req: SearchPlateRequest):
    """
    Search for a number plate by text.
    If matching vehicle is found in detection records, returns 'CATCHED'.
    Otherwise locks target plate and returns 'NOT_SEEN_YET'.
    """
    res = anpr_engine.set_target_plate(req.plate_number)
    return res


@router.post("/search-image")
async def search_by_image(file: UploadFile = File(...)):
    """
    Upload vehicle or license plate photo.
    AI extracts the number plate automatically, locks it as target,
    and returns 'CATCHED' or 'NOT_SEEN_YET'.
    """
    try:
        contents = await file.read()
        res = anpr_engine.search_by_image(contents)
        return res
    except Exception as e:
        logger.error(f"Error in search-image: {e}")
        raise HTTPException(status_code=500, detail=f"Image processing error: {str(e)}")


@router.post("/clear-target")
async def clear_target():
    """Reset the current target search."""
    return anpr_engine.clear_target()


@router.get("/crops/{filename}")
async def get_plate_crop(filename: str):
    """Serves the actual cropped plate snapshot image."""
    crop_path = CROPS_DIR / filename
    if crop_path.exists():
        return FileResponse(str(crop_path), media_type="image/jpeg")
    raise HTTPException(status_code=404, detail="Crop image not found")


@router.get("/watchlist")
async def get_watchlist():
    """Returns registered hotlist/suspect vehicles watchlist."""
    return anpr_engine.load_watchlist()


@router.post("/watchlist")
async def add_watchlist_entry(req: WatchlistEntryRequest):
    """Add a suspect vehicle plate to the watchlist."""
    try:
        entry = anpr_engine.add_watchlist_entry(req.plate_number, req.reason, req.notes or "")
        return {"status": "SUCCESS", "entry": entry, "message": f"Plate {entry['formatted_plate']} added to watchlist."}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/watchlist/{entry_id}")
async def delete_watchlist_entry(entry_id: str):
    """Remove a vehicle plate from the watchlist."""
    success = anpr_engine.delete_watchlist_entry(entry_id)
    if success:
        return {"status": "SUCCESS", "message": "Vehicle removed from suspect watchlist."}
    raise HTTPException(status_code=404, detail="Vehicle entry not found in watchlist.")


@router.post("/alert/acknowledge")
async def acknowledge_alert():
    """Acknowledge / dismiss active suspect vehicle alert."""
    return anpr_engine.acknowledge_alert()


@router.post("/detect-frame")
async def detect_frame(req: FrameDetectionRequest):
    """Auxiliary frame detector for browser webcam frames."""
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
    anpr_engine._load_models()

    best_plate_str = ""
    best_conf = 0.0
    plate_bbox = [0, 0, 0, 0]

    if anpr_engine.plate_model:
        results = anpr_engine.plate_model(frame, verbose=False, conf=0.25)[0]
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
                text, conf = anpr_engine._run_crop_ocr(crop)
                if conf > best_conf and len(text) >= 3:
                    best_conf = conf
                    best_plate_str = text
                    plate_bbox = [px1, py1, px2 - px1, py2 - py1]

    if not best_plate_str:
        return {
            "detected": False,
            "message": "No license plate recognized in this frame.",
            "frame_dimensions": [w, h]
        }

    formatted_plate = format_plate_text(best_plate_str)
    from app.services.anpr_engine import are_plates_similar
    target_match = False
    if req.target_plate:
        target_match = are_plates_similar(best_plate_str, req.target_plate)

    event = {
        "event_id": f"EVT_{int(time.time() * 1000)}",
        "camera_id": req.camera_id,
        "camera_code": req.camera_code,
        "dept_name": req.dept_name,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "vehicle": {"type": "Car", "confidence": 0.95},
        "plate": {
            "number": formatted_plate,
            "raw_number": best_plate_str,
            "confidence": round(best_conf, 2),
            "bounding_box": plate_bbox
        },
        "is_target_catched": bool(target_match),
        "status": "TARGET_CATCHED" if target_match else "NORMAL",
        "speed": 50
    }

    anpr_engine.save_event(event)

    return {
        "detected": True,
        "plate": formatted_plate,
        "raw_plate": best_plate_str,
        "confidence": round(best_conf * 100, 1),
        "bounding_box": plate_bbox,
        "frame_dimensions": [w, h],
        "is_target_catched": bool(target_match),
        "event": event
    }

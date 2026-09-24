import os
import json
import uuid
from typing import List, Dict, Any, Optional

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
CAMERAS_FILE = os.path.join(DATA_DIR, "cameras.json")
DEPARTMENTS_FILE = os.path.join(DATA_DIR, "departments.json")

DEFAULT_DEPARTMENTS = [
    {"id": str(uuid.UUID("11111111-1111-1111-1111-111111111101")), "dept_name": "Gujarat Police", "zone_code": "POL-GJ"},
    {"id": str(uuid.UUID("11111111-1111-1111-1111-111111111102")), "dept_name": "Ahmedabad Municipal Corporation", "zone_code": "AMC-AHD"},
    {"id": str(uuid.UUID("11111111-1111-1111-1111-111111111103")), "dept_name": "Surat Municipal Corporation", "zone_code": "SMC-SRT"},
    {"id": str(uuid.UUID("11111111-1111-1111-1111-111111111104")), "dept_name": "Vadodara Municipal Corporation", "zone_code": "VMC-VAD"},
    {"id": str(uuid.UUID("11111111-1111-1111-1111-111111111105")), "dept_name": "Rajkot Municipal Corporation", "zone_code": "RMC-RJK"},
    {"id": str(uuid.UUID("11111111-1111-1111-1111-111111111106")), "dept_name": "Gujarat State Road Transport", "zone_code": "GSRTC-GJ"},
    {"id": str(uuid.UUID("11111111-1111-1111-1111-111111111107")), "dept_name": "Gujarat Traffic Police", "zone_code": "TRAF-GJ"},
    {"id": str(uuid.UUID("11111111-1111-1111-1111-111111111108")), "dept_name": "Gujarat Metro Rail", "zone_code": "METRO-GJ"},
    {"id": str(uuid.UUID("11111111-1111-1111-1111-111111111109")), "dept_name": "Gandhinagar Municipal Corporation", "zone_code": "GMC-GND"},
    {"id": str(uuid.UUID("11111111-1111-1111-1111-111111111110")), "dept_name": "Surat Traffic Police", "zone_code": "TRAF-SRT"},
]

class MemoryRegistry:
    def __init__(self):
        os.makedirs(DATA_DIR, exist_ok=True)
        self.departments: List[Dict[str, Any]] = self._load_departments()
        self.cameras: List[Dict[str, Any]] = self._load_cameras()

    def _load_departments(self) -> List[Dict[str, Any]]:
        if os.path.exists(DEPARTMENTS_FILE):
            try:
                with open(DEPARTMENTS_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, list) and len(data) > 0:
                        return data
            except Exception:
                pass
        # Default seed departments
        self._save_departments(DEFAULT_DEPARTMENTS)
        return list(DEFAULT_DEPARTMENTS)

    def _save_departments(self, depts: List[Dict[str, Any]]):
        try:
            with open(DEPARTMENTS_FILE, "w", encoding="utf-8") as f:
                json.dump(depts, f, indent=2)
        except Exception:
            pass

    def _load_cameras(self) -> List[Dict[str, Any]]:
        # Strictly load user-fed cameras from persistent storage
        if os.path.exists(CAMERAS_FILE):
            try:
                with open(CAMERAS_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, list):
                        return data
            except Exception:
                pass
        return []

    def _save_cameras(self):
        try:
            with open(CAMERAS_FILE, "w", encoding="utf-8") as f:
                json.dump(self.cameras, f, indent=2)
        except Exception:
            pass

    def get_departments(self) -> List[Dict[str, Any]]:
        return sorted(self.departments, key=lambda d: d["dept_name"])

    def add_department(self, dept_name: str, zone_code: str) -> Dict[str, Any]:
        for d in self.departments:
            if d["dept_name"].lower() == dept_name.lower():
                from fastapi import HTTPException, status
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Department '{dept_name}' already exists.")
        new_dept = {
            "id": str(uuid.uuid4()),
            "dept_name": dept_name,
            "zone_code": zone_code,
        }
        self.departments.append(new_dept)
        self._save_departments(self.departments)
        return new_dept

    def get_department_by_id(self, dept_id: str) -> Optional[Dict[str, Any]]:
        for d in self.departments:
            if str(d["id"]) == str(dept_id):
                return d
        return None

    def get_department_by_name(self, dept_name: str) -> Optional[Dict[str, Any]]:
        for d in self.departments:
            if d["dept_name"].lower() == dept_name.lower():
                return d
        return None

    def add_camera(self, camera) -> Dict[str, Any]:
        # Check camera code uniqueness
        for c in self.cameras:
            if c["camera_code"].lower() == camera.camera_code.lower():
                from fastapi import HTTPException, status
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Camera code '{camera.camera_code}' already exists.")

        # Resolve department
        dept = None
        if camera.dept_id:
            dept = self.get_department_by_id(str(camera.dept_id))
        elif camera.department_name:
            dept = self.get_department_by_name(camera.department_name)
            if not dept:
                dept = self.add_department(camera.department_name, f"ZONE-{camera.department_name[:3].upper()}")

        dept_id = dept["id"] if dept else str(uuid.uuid4())
        dept_name = dept["dept_name"] if dept else (camera.department_name or "General")

        cam_id = str(uuid.uuid4())
        cam_record = {
            "id": cam_id,
            "dept_id": dept_id,
            "dept_name": dept_name,
            "camera_code": camera.camera_code.strip(),
            "make_model": camera.make_model or ("Local Testing Webcam" if camera.source_type == "LOCAL_WEBCAM" else "Generic CCTV"),
            "source_type": camera.source_type or "NETWORK_CCTV",
            "ip_address": camera.ip_address,
            "rtsp_url": camera.rtsp_url,
            "latitude": camera.latitude,
            "longitude": camera.longitude,
            "camera_type": camera.camera_type or "FIXED",
            "status": camera.status or "ONLINE",
            "ageing": camera.ageing or 0.0,
        }
        self.cameras.append(cam_record)
        self._save_cameras()
        return {
            "message": "Camera registered successfully",
            "id": cam_id,
            "camera_code": cam_record["camera_code"],
            "status": cam_record["status"]
        }

    def get_cameras_geojson(self) -> Dict[str, Any]:
        features = []
        for c in self.cameras:
            if c.get("latitude") is not None and c.get("longitude") is not None:
                features.append({
                    "type": "Feature",
                    "geometry": {
                        "type": "Point",
                        "coordinates": [c["longitude"], c["latitude"]]
                    },
                    "properties": c
                })
        return {
            "type": "FeatureCollection",
            "features": features
        }

    def get_stats(self) -> List[Dict[str, Any]]:
        stats_map = {}
        for d in self.departments:
            stats_map[d["dept_name"]] = {
                "dept_name": d["dept_name"],
                "total_cameras": 0,
                "online_count": 0,
                "offline_count": 0,
                "maintenance_count": 0
            }
        for c in self.cameras:
            name = c.get("dept_name")
            if name in stats_map:
                stats_map[name]["total_cameras"] += 1
                status = c.get("status", "OFFLINE").upper()
                if status == "ONLINE":
                    stats_map[name]["online_count"] += 1
                elif status == "OFFLINE":
                    stats_map[name]["offline_count"] += 1
                elif status == "MAINTENANCE":
                    stats_map[name]["maintenance_count"] += 1
        return list(stats_map.values())

    def get_camera_by_id(self, cam_id: str) -> Optional[Dict[str, Any]]:
        for c in self.cameras:
            if str(c.get("id")) == str(cam_id) or str(c.get("camera_code")) == str(cam_id):
                return dict(c)
        return None

    def get_all_cameras(self) -> List[Dict[str, Any]]:
        return list(self.cameras)

memory_registry = MemoryRegistry()


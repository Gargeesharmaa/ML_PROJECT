from fastapi import APIRouter, HTTPException, UploadFile, File, Depends, status
import os
import csv
import io
from uuid import UUID
from typing import Optional
from app.db import get_optional_pool
from app.schemas.cameras import CameraCreate
from app.store import memory_registry
import asyncpg

router = APIRouter(prefix="/api/cameras", tags=["1. Camera Onboarding"])

@router.post("/manual", status_code=status.HTTP_201_CREATED)
async def create_camera_manual(camera: CameraCreate, db: Optional[asyncpg.Pool] = Depends(get_optional_pool)):
    """Manual Entry & Programmatic API Onboarding"""
    if db is None:
        # Fallback to in-memory store if PostGIS is not yet running
        return memory_registry.add_camera(camera)

    # 1. Resolve Department ID
    dept_id = camera.dept_id
    if not dept_id and camera.department_name:
        dept_row = await db.fetchrow(
            "SELECT id FROM departments WHERE LOWER(dept_name) = LOWER($1)",
            camera.department_name.strip()
        )
        if dept_row:
            dept_id = dept_row["id"]
        else:
            # Auto-create department if it doesn't exist
            new_zone = f"ZONE-{camera.department_name[:3].upper()}"
            dept_row = await db.fetchrow(
                "INSERT INTO departments (dept_name, zone_code) VALUES ($1, $2) RETURNING id",
                camera.department_name.strip(), new_zone
            )
            dept_id = dept_row["id"]

    if not dept_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A valid department_id or department_name must be provided."
        )

    # 2. Insert Camera Record
    query = """
        INSERT INTO cameras (
            dept_id,
            camera_code,
            make_model,
            source_type,
            ip_address,
            rtsp_url,
            location,
            camera_type,
            status,
            ageing
        )
        VALUES (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            CASE 
                WHEN $7::float IS NOT NULL AND $8::float IS NOT NULL 
                THEN ST_SetSRID(ST_MakePoint($7, $8), 4326)
                ELSE NULL 
            END,
            $9,
            $10,
            $11
        )
        RETURNING id, camera_code, status;
    """
    try:
        row = await db.fetchrow(
            query,
            dept_id,
            camera.camera_code.strip(),
            camera.make_model,
            camera.source_type,
            camera.ip_address,
            camera.rtsp_url,
            camera.longitude,
            camera.latitude,
            camera.camera_type,
            camera.status,
            camera.ageing
        )
        return {
            "message": "Camera registered successfully",
            "id": str(row["id"]),
            "camera_code": row["camera_code"],
            "status": row["status"]
        }
    except asyncpg.UniqueViolationError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Camera code '{camera.camera_code}' already exists."
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to onboard camera: {str(exc)}"
        )

@router.delete("/{camera_id}", status_code=status.HTTP_200_OK)
async def delete_camera(camera_id: str, db: Optional[asyncpg.Pool] = Depends(get_optional_pool)):
    """Delete a camera from the registry by ID or camera_code"""
    deleted_from_memory = memory_registry.delete_camera(camera_id)

    if db is not None:
        try:
            async with db.acquire() as conn:
                await conn.execute(
                    "DELETE FROM cameras WHERE id::text = $1 OR camera_code = $1",
                    str(camera_id)
                )
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Failed to delete camera from database: {str(exc)}"
            )

    return {
        "message": f"Camera '{camera_id}' removed successfully.",
        "id": camera_id
    }

@router.get("/template-csv")
async def download_template_csv():
    """Download standard sample CSV template for bulk onboarding"""
    from fastapi.responses import FileResponse
    from app.store import DATA_DIR
    template_path = os.path.join(DATA_DIR, "cameras_sample.csv")
    if os.path.exists(template_path):
        return FileResponse(
            template_path,
            media_type="text/csv",
            filename="cameras_template.csv"
        )
    raise HTTPException(status_code=404, detail="Template CSV file not found.")

@router.post("/bulk-import", status_code=status.HTTP_201_CREATED)
async def bulk_import_csv(file: UploadFile = File(...), db: Optional[asyncpg.Pool] = Depends(get_optional_pool)):
    """Bulk Import Cameras via CSV Upload (supports dept_name and NETWORK / LOCAL_WEBCAM source types)"""
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only CSV files are allowed.")
    
    raw_content = await file.read()
    try:
        decoded = raw_content.decode("utf-8-sig")
    except UnicodeDecodeError:
        decoded = raw_content.decode("latin-1")

    reader = csv.DictReader(io.StringIO(decoded))
    
    imported = []
    skipped = []

    for row_idx, row in enumerate(reader, start=2):
        clean_row = {str(k).strip(): str(v).strip() for k, v in row.items() if k is not None}
        code = clean_row.get("camera_code")
        if not code:
            continue

        dept = clean_row.get("dept_name") or clean_row.get("department_name") or clean_row.get("dept_id") or "General"
        
        # Source type normalization
        raw_source = clean_row.get("source_type", "NETWORK_CCTV").upper()
        if "WEBCAM" in raw_source or "LOCAL" in raw_source:
            source_type = "LOCAL_WEBCAM"
        else:
            source_type = "NETWORK_CCTV"

        camera_type = clean_row.get("camera_type", "FIXED").upper()
        if camera_type not in ["PTZ", "BULLET", "DOME", "THERMAL", "FIXED"]:
            camera_type = "FIXED"

        status_val = clean_row.get("status", "ONLINE").upper()
        if status_val not in ["ONLINE", "OFFLINE", "MAINTENANCE"]:
            status_val = "ONLINE"

        make_model = clean_row.get("make_model") or "Generic CCTV"
        ip_addr = clean_row.get("ip_address") or "103.250.160.189"
        rtsp = clean_row.get("rtsp_url") or ""

        try:
            lat = float(clean_row["latitude"]) if clean_row.get("latitude") else 23.0225
            lon = float(clean_row["longitude"]) if clean_row.get("longitude") else 72.5714
        except ValueError:
            lat, lon = 23.0225, 72.5714

        try:
            ageing_val = float(clean_row.get("ageing", 0.0))
        except ValueError:
            ageing_val = 0.0

        from types import SimpleNamespace
        cam_obj = SimpleNamespace(
            dept_id=None,
            department_name=dept,
            camera_code=code,
            make_model=make_model,
            source_type=source_type,
            ip_address=ip_addr,
            rtsp_url=rtsp,
            latitude=lat,
            longitude=lon,
            camera_type=camera_type,
            status=status_val,
            ageing=ageing_val
        )

        try:
            # Upsert: delete existing before adding to avoid duplicate key errors
            memory_registry.delete_camera(code)
            res = memory_registry.add_camera(cam_obj)
            imported.append(code)
        except Exception as e:
            skipped.append(f"{code}: {str(e)}")

        if db is not None:
            try:
                # Resolve or auto-create department in DB
                dept_row = await db.fetchrow(
                    "SELECT id FROM departments WHERE LOWER(dept_name) = LOWER($1)",
                    dept
                )
                if dept_row:
                    db_dept_id = dept_row["id"]
                else:
                    new_zone = f"ZONE-{dept[:3].upper()}"
                    dept_row = await db.fetchrow(
                        "INSERT INTO departments (dept_name, zone_code) VALUES ($1, $2) RETURNING id",
                        dept, new_zone
                    )
                    db_dept_id = dept_row["id"]

                query = """
                    INSERT INTO cameras (
                        dept_id, camera_code, make_model, source_type, ip_address, rtsp_url, 
                        location, camera_type, status, ageing
                    )
                    VALUES (
                        $1, $2, $3, $4, $5, $6,
                        ST_SetSRID(ST_MakePoint($7, $8), 4326),
                        $9, $10, $11
                    )
                    ON CONFLICT (camera_code) DO UPDATE SET
                        dept_id = EXCLUDED.dept_id,
                        make_model = EXCLUDED.make_model,
                        source_type = EXCLUDED.source_type,
                        ip_address = EXCLUDED.ip_address,
                        rtsp_url = EXCLUDED.rtsp_url,
                        location = EXCLUDED.location,
                        camera_type = EXCLUDED.camera_type,
                        status = EXCLUDED.status,
                        ageing = EXCLUDED.ageing;
                """
                await db.execute(
                    query,
                    db_dept_id, code, make_model, source_type, ip_addr, rtsp,
                    lon, lat, camera_type, status_val, ageing_val
                )
            except Exception:
                pass

    return {
        "message": f"Successfully imported {len(imported)} cameras.",
        "imported_count": len(imported),
        "imported_codes": imported,
        "skipped": skipped
    }

@router.get("/csv-template")
async def download_csv_template_alias():
    return await download_template_csv()

@router.post("/validate-csv")
async def validate_csv(file: UploadFile = File(...)):
    """Pre-validate CSV file and return parsed rows with validation flags"""
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only CSV files are allowed.")
    raw_content = await file.read()
    try:
        decoded = raw_content.decode("utf-8-sig")
    except UnicodeDecodeError:
        decoded = raw_content.decode("latin-1")
    reader = csv.DictReader(io.StringIO(decoded))
    parsed_rows = []
    total = 0
    valid_count = 0
    error_count = 0
    for idx, row in enumerate(reader, start=1):
        clean_row = {str(k).strip(): str(v).strip() for k, v in row.items() if k is not None}
        code = clean_row.get("camera_code", "")
        errors = []
        if not code:
            errors.append("Missing camera_code")
        raw_source = clean_row.get("source_type", "NETWORK_CCTV").upper()
        source_type = "LOCAL_WEBCAM" if ("WEBCAM" in raw_source or "LOCAL" in raw_source) else "NETWORK_CCTV"
        try:
            lat = float(clean_row["latitude"]) if clean_row.get("latitude") else 23.0225
            lon = float(clean_row["longitude"]) if clean_row.get("longitude") else 72.5714
        except (ValueError, KeyError):
            lat, lon = 23.0225, 72.5714
            errors.append("Invalid coordinates")
        try:
            ageing = float(clean_row.get("ageing", 0.0))
        except (ValueError, KeyError):
            ageing = 0.0
        is_valid = len(errors) == 0
        if is_valid:
            valid_count += 1
        else:
            error_count += 1
        total += 1
        parsed_rows.append({
            "row_number": idx,
            "camera_code": code,
            "dept_name": clean_row.get("dept_name") or clean_row.get("department_name") or "General",
            "camera_type": (clean_row.get("camera_type") or "FIXED").upper(),
            "make_model": clean_row.get("make_model") or "Generic CCTV",
            "source_type": source_type,
            "ip_address": clean_row.get("ip_address") or "103.250.160.189",
            "rtsp_url": clean_row.get("rtsp_url") or "",
            "latitude": lat,
            "longitude": lon,
            "status": (clean_row.get("status") or "ONLINE").upper(),
            "ageing": ageing,
            "is_valid": is_valid,
            "errors": errors
        })
    return {
        "valid": error_count == 0,
        "total_records": total,
        "valid_records": valid_count,
        "error_records": error_count,
        "rows": parsed_rows
    }

@router.post("/validate-records")
async def validate_records(payload: dict):
    records = payload.get("records", [])
    valid_count = 0
    error_count = 0
    validated_rows = []
    for idx, r in enumerate(records, start=1):
        errors = []
        code = str(r.get("camera_code", "")).strip()
        if not code:
            errors.append("Missing camera_code")
        try:
            lat = float(r.get("latitude", 23.0225))
            lon = float(r.get("longitude", 72.5714))
        except (ValueError, TypeError):
            lat, lon = 23.0225, 72.5714
            errors.append("Invalid coordinates")
        is_valid = len(errors) == 0
        if is_valid:
            valid_count += 1
        else:
            error_count += 1
        validated_rows.append({
            **r,
            "row_number": idx,
            "camera_code": code,
            "latitude": lat,
            "longitude": lon,
            "is_valid": is_valid,
            "errors": errors
        })
    return {
        "valid": error_count == 0,
        "total_records": len(records),
        "valid_records": valid_count,
        "error_records": error_count,
        "rows": validated_rows
    }

@router.post("/bulk-import-json", status_code=status.HTTP_201_CREATED)
async def bulk_import_json(payload: dict, db: Optional[asyncpg.Pool] = Depends(get_optional_pool)):
    cameras = payload.get("cameras", [])
    imported = []
    from types import SimpleNamespace
    for r in cameras:
        code = str(r.get("camera_code", "")).strip()
        if not code:
            continue
        dept = str(r.get("dept_name") or r.get("department_name") or "General").strip()
        raw_source = str(r.get("source_type", "NETWORK_CCTV")).upper()
        source_type = "LOCAL_WEBCAM" if ("WEBCAM" in raw_source or "LOCAL" in raw_source) else "NETWORK_CCTV"
        try:
            lat = float(r.get("latitude", 23.0225))
            lon = float(r.get("longitude", 72.5714))
        except (ValueError, TypeError):
            lat, lon = 23.0225, 72.5714
        try:
            ageing = float(r.get("ageing", 0.0))
        except (ValueError, TypeError):
            ageing = 0.0
        cam_obj = SimpleNamespace(
            dept_id=None,
            department_name=dept,
            camera_code=code,
            make_model=r.get("make_model") or "Generic CCTV",
            source_type=source_type,
            ip_address=r.get("ip_address") or "103.250.160.189",
            rtsp_url=r.get("rtsp_url") or "",
            latitude=lat,
            longitude=lon,
            camera_type=(r.get("camera_type") or "FIXED").upper(),
            status=(r.get("status") or "ONLINE").upper(),
            ageing=ageing
        )
        try:
            memory_registry.delete_camera(code)
            memory_registry.add_camera(cam_obj)
            imported.append(code)
        except Exception:
            pass
    return {
        "message": f"Successfully imported {len(imported)} cameras into registry.",
        "imported_count": len(imported),
        "imported_codes": imported
    }
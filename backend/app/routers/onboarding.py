from fastapi import APIRouter, HTTPException, UploadFile, File, Depends, status
from fastapi.responses import Response
import csv
import io
import ipaddress
from uuid import UUID
from typing import Optional, List, Dict, Any
from app.db import get_optional_pool
from app.schemas.cameras import CameraCreate, BulkImportJsonPayload, ValidateRecordsPayload
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
    """Delete a camera from the registry by id or camera_code."""
    if db is None:
        deleted = memory_registry.delete_camera(camera_id)
        if not deleted:
            raise HTTPException(status_code=404, detail=f"Camera '{camera_id}' not found.")
        return {"message": "Camera deleted successfully", "id": camera_id}

    # Delete from PostGIS DB
    try:
        try:
            cid_uuid = UUID(camera_id)
            query = "DELETE FROM cameras WHERE id = $1 OR camera_code = $2 RETURNING camera_code;"
            row = await db.fetchrow(query, cid_uuid, camera_id)
        except ValueError:
            query = "DELETE FROM cameras WHERE camera_code = $1 RETURNING camera_code;"
            row = await db.fetchrow(query, camera_id)

        if not row:
            raise HTTPException(status_code=404, detail=f"Camera '{camera_id}' not found.")
        return {"message": "Camera deleted successfully", "camera_code": row["camera_code"]}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to delete camera: {str(exc)}")

@router.delete("", status_code=status.HTTP_200_OK)
async def clear_all_cameras(db: Optional[asyncpg.Pool] = Depends(get_optional_pool)):
    """Clear all cameras from registry."""
    if db is None:
        memory_registry.clear_all_cameras()
        return {"message": "All cameras cleared from registry."}

    await db.execute("DELETE FROM cameras;")
    return {"message": "All cameras deleted from database."}

CSV_SAMPLE_TEMPLATE = """camera_code,dept_name,camera_type,make_model,source_type,ip_address,rtsp_url,latitude,longitude,status,ageing
CAM-AHM-SG01,Ahmedabad Municipal Corporation,PTZ,Hikvision DS-2DE4225IW-DE,NETWORK_CCTV,103.250.160.189,rtsp://yashrathore2574@gmail.com:EXTL-F2F7-S7KT@103.250.160.189:8554/stream/cam01,23.0305,72.5076,ONLINE,0.5
CAM-SRT-RING02,Surat Traffic Police,ANPR,Dahua ITC437-PW6M-IZ-VF,NETWORK_CCTV,192.168.1.120,rtsp://admin:pass123@192.168.1.120:554/live,21.1702,72.8311,ONLINE,1.0
CAM-VAD-STN03,Vadodara Municipal Corporation,DOME,CP Plus CP-UNC-DA41L3-MD,NETWORK_CCTV,192.168.2.55,rtsp://admin:pass123@192.168.2.55:554/ch1,22.3072,73.1812,OFFLINE,2.0
"""

def normalize_csv_dict(row: Dict[str, Any]) -> Dict[str, Any]:
    """Normalizes various CSV header formats into standard schema keys."""
    norm = {}
    key_aliases = {
        "camera_code": ["camera_code", "cameracode", "code", "cam_id", "cam_code"],
        "dept_name": ["dept_name", "department_name", "department", "dept"],
        "dept_id": ["dept_id", "department_id"],
        "camera_type": ["camera_type", "type"],
        "make_model": ["make_model", "model", "make", "camera_model"],
        "source_type": ["source_type", "source"],
        "ip_address": ["ip_address", "ip", "host", "ipaddress"],
        "rtsp_url": ["rtsp_url", "rtsp", "stream_url", "url"],
        "latitude": ["latitude", "lat"],
        "longitude": ["longitude", "long", "lng", "lon"],
        "status": ["status", "state"],
        "ageing": ["ageing", "age", "years"],
    }

    clean_row = {}
    for k, v in row.items():
        if k is None:
            continue
        clean_key = str(k).strip().lower().replace(" ", "_")
        if isinstance(v, (int, float)):
            clean_val = str(v)
        elif isinstance(v, str):
            clean_val = v.strip()
        elif v is None:
            clean_val = ""
        else:
            clean_val = str(v).strip()
        clean_row[clean_key] = clean_val

    for target_key, aliases in key_aliases.items():
        for alias in aliases:
            if alias in clean_row and clean_row[alias]:
                norm[target_key] = clean_row[alias]
                break

    return norm

def validate_csv_records(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Validates rows parsed from CSV, flagging any formatting or missing value errors."""
    validated_rows = []
    seen_codes = set()
    valid_count = 0
    invalid_count = 0

    valid_types = {"PTZ", "BULLET", "DOME", "THERMAL", "FIXED", "ANPR"}
    valid_statuses = {"ONLINE", "OFFLINE", "MAINTENANCE"}

    for idx, raw in enumerate(records, start=1):
        row = normalize_csv_dict(raw)
        errors = []

        code = row.get("camera_code", "").strip()
        if not code:
            errors.append("Camera Code is required.")
        elif code.lower() in seen_codes:
            errors.append(f"Duplicate Camera Code '{code}' in CSV file.")
        else:
            seen_codes.add(code.lower())

        dept = row.get("dept_name") or row.get("dept_id")
        if not dept:
            errors.append("Department name or Department ID is required.")

        c_type = (row.get("camera_type") or "FIXED").upper()
        if c_type not in valid_types:
            errors.append(f"Invalid camera_type '{c_type}'. Allowed: {', '.join(valid_types)}")

        c_status = (row.get("status") or "ONLINE").upper()
        if c_status not in valid_statuses:
            errors.append(f"Invalid status '{c_status}'. Allowed: {', '.join(valid_statuses)}")

        # Validate IP address if network CCTV
        ip = row.get("ip_address")
        if ip:
            try:
                ipaddress.ip_address(ip)
            except ValueError:
                # Allow hostname/FQDN, but check for illegal IP formats
                if "." not in ip:
                    errors.append(f"Invalid IP address or hostname format: '{ip}'")

        # Validate Coordinates
        lat_val = row.get("latitude")
        if lat_val:
            try:
                lat_f = float(lat_val)
                if not (-90 <= lat_f <= 90):
                    errors.append("Latitude must be between -90 and 90.")
            except ValueError:
                errors.append(f"Invalid latitude value '{lat_val}'.")

        lon_val = row.get("longitude")
        if lon_val:
            try:
                lon_f = float(lon_val)
                if not (-180 <= lon_f <= 180):
                    errors.append("Longitude must be between -180 and 180.")
            except ValueError:
                errors.append(f"Invalid longitude value '{lon_val}'.")

        is_valid = len(errors) == 0
        if is_valid:
            valid_count += 1
        else:
            invalid_count += 1

        validated_rows.append({
            "row_number": idx,
            "camera_code": code or f"ROW-{idx}",
            "dept_name": row.get("dept_name") or "General",
            "camera_type": c_type,
            "make_model": row.get("make_model") or "Generic CCTV",
            "source_type": (row.get("source_type") or "NETWORK_CCTV").upper(),
            "ip_address": ip or "",
            "rtsp_url": row.get("rtsp_url") or "",
            "latitude": float(lat_val) if lat_val and not errors else 23.0225,
            "longitude": float(lon_val) if lon_val and not errors else 72.5714,
            "status": c_status,
            "ageing": float(row.get("ageing", 0.0)) if row.get("ageing") else 0.0,
            "is_valid": is_valid,
            "errors": errors
        })

    return {
        "total_rows": len(records),
        "valid_count": valid_count,
        "invalid_count": invalid_count,
        "rows": validated_rows
    }

@router.get("/csv-template")
async def download_csv_template():
    """Download a standardized CSV template pre-filled with sample camera records."""
    return Response(
        content=CSV_SAMPLE_TEMPLATE.strip() + "\n",
        media_type="text/csv",
        headers={
            "Content-Disposition": "attachment; filename=gujarat_cctv_registry_template.csv"
        }
    )

@router.post("/validate-csv")
async def validate_csv_file(file: UploadFile = File(...)):
    """Pre-flight check for CSV upload: validates all rows and returns instant feedback table."""
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only CSV files (.csv) are accepted.")

    try:
        content = await file.read()
        text = content.decode("utf-8-sig", errors="replace")
        reader = csv.DictReader(io.StringIO(text))
        raw_rows = [row for row in reader if any(v.strip() for v in row.values() if v)]
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to parse CSV file: {str(exc)}")

    if not raw_rows:
        raise HTTPException(status_code=400, detail="The uploaded CSV file is empty or missing headers.")

    return validate_csv_records(raw_rows)

@router.post("/bulk-import", status_code=status.HTTP_201_CREATED)
async def bulk_import_csv(file: UploadFile = File(...), db: Optional[asyncpg.Pool] = Depends(get_optional_pool)):
    """Bulk Import Cameras via CSV Upload into registry with detailed import diagnostics."""
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only CSV files (.csv) are accepted.")

    try:
        content = await file.read()
        text = content.decode("utf-8-sig", errors="replace")
        reader = csv.DictReader(io.StringIO(text))
        raw_rows = [row for row in reader if any(v.strip() for v in row.values() if v)]
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Failed to read CSV file: {str(exc)}")

    if not raw_rows:
        raise HTTPException(status_code=400, detail="The uploaded CSV file contains no data rows.")

    validation_result = validate_csv_records(raw_rows)
    return await execute_bulk_import_records(
        valid_rows=[r for r in validation_result["rows"] if r["is_valid"]],
        invalid_rows=[r for r in validation_result["rows"] if not r["is_valid"]],
        total_rows=validation_result["total_rows"],
        db=db
    )

@router.post("/validate-records")
async def validate_records_endpoint(payload: ValidateRecordsPayload):
    """Validate a batch of edited camera records on the fly."""
    if not payload.records:
        raise HTTPException(status_code=400, detail="No records provided.")
    return validate_csv_records(payload.records)

@router.post("/bulk-import-json", status_code=status.HTTP_201_CREATED)
async def bulk_import_json(payload: BulkImportJsonPayload, db: Optional[asyncpg.Pool] = Depends(get_optional_pool)):
    """Bulk Import edited cameras from JSON payload into registry."""
    if not payload.cameras:
        raise HTTPException(status_code=400, detail="No cameras provided in payload.")

    validation_result = validate_csv_records(payload.cameras)
    valid_rows = [r for r in validation_result["rows"] if r["is_valid"]]
    invalid_rows = [r for r in validation_result["rows"] if not r["is_valid"]]

    return await execute_bulk_import_records(
        valid_rows=valid_rows,
        invalid_rows=invalid_rows,
        total_rows=validation_result["total_rows"],
        db=db
    )

async def execute_bulk_import_records(
    valid_rows: List[Dict[str, Any]],
    invalid_rows: List[Dict[str, Any]],
    total_rows: int,
    db: Optional[asyncpg.Pool]
) -> Dict[str, Any]:
    """Helper to commit validated camera records to either PostGIS DB or persistent disk store."""
    if not valid_rows:
        return {
            "message": "No valid camera records found to import.",
            "total_rows": total_rows,
            "imported_count": 0,
            "skipped_count": len(invalid_rows),
            "errors": [{"row": r.get("row_number", idx), "camera_code": r.get("camera_code", "N/A"), "errors": r.get("errors", [])} for idx, r in enumerate(invalid_rows, 1)]
        }

    # If DB pool is offline, use persistent disk storage via memory_registry
    if db is None:
        import_res = memory_registry.add_bulk_cameras(valid_rows)
        all_skipped = [{"row": r.get("row_number", idx), "camera_code": r.get("camera_code", "N/A"), "reason": ", ".join(r.get("errors", []))} for idx, r in enumerate(invalid_rows, 1)] + import_res["skipped"]

        return {
            "message": f"Successfully imported {import_res['imported_count']} cameras into registry.",
            "total_rows": total_rows,
            "imported_count": import_res["imported_count"],
            "skipped_count": len(all_skipped),
            "imported_cameras": [c["camera_code"] for c in import_res["imported"]],
            "skipped": all_skipped
        }

    # If PostGIS database is connected, insert batch into cameras table
    db_records = []
    skipped_db = []
    
    for r in valid_rows:
        # Resolve department ID in database
        dept_row = await db.fetchrow(
            "SELECT id FROM departments WHERE LOWER(dept_name) = LOWER($1)",
            r["dept_name"].strip()
        )
        if dept_row:
            dept_id = dept_row["id"]
        else:
            new_zone = f"ZONE-{r['dept_name'][:3].upper()}"
            dept_row = await db.fetchrow(
                "INSERT INTO departments (dept_name, zone_code) VALUES ($1, $2) RETURNING id",
                r["dept_name"].strip(), new_zone
            )
            dept_id = dept_row["id"]

        db_records.append((
            dept_id,
            r["camera_code"],
            r.get("make_model", "Generic CCTV"),
            r.get("source_type", "NETWORK_CCTV"),
            r.get("ip_address"),
            r.get("rtsp_url"),
            float(r["longitude"]) if r.get("longitude") else None,
            float(r.get("latitude")) if r.get("latitude") else None,
            r.get("camera_type", "FIXED"),
            r.get("status", "ONLINE"),
            float(r.get("ageing", 0.0))
        ))

    insert_query = """
        INSERT INTO cameras (
            dept_id, camera_code, make_model, source_type, ip_address, rtsp_url, 
            location, camera_type, status, ageing
        )
        VALUES (
            $1, $2, $3, $4, $5, $6,
            CASE WHEN $7::float IS NOT NULL AND $8::float IS NOT NULL THEN ST_SetSRID(ST_MakePoint($7, $8), 4326) ELSE NULL END,
            $9, $10, $11
        )
        ON CONFLICT (camera_code) DO NOTHING
        RETURNING camera_code;
    """
    
    inserted_codes = []
    async with db.acquire() as conn:
        for rec in db_records:
            res = await conn.fetchrow(insert_query, *rec)
            if res:
                inserted_codes.append(res["camera_code"])
            else:
                skipped_db.append({"camera_code": rec[1], "reason": "Already exists in database"})

    all_skipped = [{"row": r.get("row_number", idx), "camera_code": r.get("camera_code", "N/A"), "reason": ", ".join(r.get("errors", []))} for idx, r in enumerate(invalid_rows, 1)] + skipped_db

    return {
        "message": f"Successfully imported {len(inserted_codes)} cameras into database.",
        "total_rows": total_rows,
        "imported_count": len(inserted_codes),
        "skipped_count": len(all_skipped),
        "imported_cameras": inserted_codes,
        "skipped": all_skipped
    }
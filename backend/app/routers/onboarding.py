from fastapi import APIRouter, HTTPException, UploadFile, File, Depends, status
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

@router.post("/bulk-import", status_code=status.HTTP_201_CREATED)
async def bulk_import_csv(file: UploadFile = File(...), db: Optional[asyncpg.Pool] = Depends(get_optional_pool)):
    """Bulk Import Cameras via CSV Upload"""
    if not file.filename.endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only CSV files are allowed.")
    
    content = await file.read()
    reader = csv.DictReader(io.StringIO(content.decode("utf-8")))
    
    records = []
    for row in reader:
        records.append((
            UUID(row["dept_id"]),
            row["camera_code"],
            row.get("make_model"),
            row.get("source_type", "NETWORK_CCTV"),
            row.get("ip_address"),
            row.get("rtsp_url"),
            float(row["longitude"]) if row.get("longitude") else None,
            float(row.get("latitude")) if row.get("latitude") else None,
            row.get("camera_type", "FIXED"),
            row.get("status", "OFFLINE"),
            float(row.get("ageing", 0.0))
        ))

    if db is None:
        for r in records:
            from types import SimpleNamespace
            c = SimpleNamespace(
                dept_id=r[0],
                department_name=None,
                camera_code=r[1],
                make_model=r[2],
                source_type=r[3],
                ip_address=r[4],
                rtsp_url=r[5],
                longitude=r[6],
                latitude=r[7],
                camera_type=r[8],
                status=r[9],
                ageing=r[10]
            )
            try:
                memory_registry.add_camera(c)
            except Exception:
                pass
        return {"message": f"Processed {len(records)} cameras successfully into memory store."}

    query = """
        INSERT INTO cameras (
            dept_id, camera_code, make_model, source_type, ip_address, rtsp_url, 
            location, camera_type, status, ageing
        )
        VALUES (
            $1, $2, $3, $4, $5, $6,
            CASE WHEN $7::float IS NOT NULL AND $8::float IS NOT NULL THEN ST_SetSRID(ST_MakePoint($7, $8), 4326) ELSE NULL END,
            $9, $10, $11
        )
        ON CONFLICT (camera_code) DO NOTHING;
    """
    async with db.acquire() as conn:
        await conn.executemany(query, records)

    return {"message": f"Processed {len(records)} cameras successfully."}
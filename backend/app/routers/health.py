from fastapi import APIRouter, Depends, HTTPException
from typing import Optional
from uuid import UUID
from app.db import get_optional_pool
from app.schemas.cameras import HealthPing
from app.store import memory_registry
import asyncpg

router = APIRouter(prefix="/api/cameras", tags=["3. Health & Maintenance"])

@router.get("/stats")
async def get_camera_stats(db: Optional[asyncpg.Pool] = Depends(get_optional_pool)):
    """Summary of camera counts broken down by status and department"""
    if db is not None:
        query = """
            SELECT 
                d.dept_name,
                COUNT(c.id) AS total_cameras,
                COUNT(c.id) FILTER (WHERE c.status = 'ONLINE') AS online_count,
                COUNT(c.id) FILTER (WHERE c.status = 'OFFLINE') AS offline_count,
                COUNT(c.id) FILTER (WHERE c.status = 'MAINTENANCE') AS maintenance_count
            FROM departments d
            LEFT JOIN cameras c ON d.id = c.dept_id
            GROUP BY d.dept_name;
        """
        rows = await db.fetch(query)
        return [dict(row) for row in rows]
    return memory_registry.get_stats()

@router.post("/{camera_id}/ping")
async def record_health_ping(
    camera_id: UUID,
    ping: HealthPing,
    db: Optional[asyncpg.Pool] = Depends(get_optional_pool)
):
    """Record health check pings and keep camera status up-to-date"""
    if db is not None:
        async with db.acquire() as conn:
            async with conn.transaction():
                # Update camera status
                await conn.execute(
                    "UPDATE cameras SET status = $1, last_ping_at = NOW() WHERE id = $2",
                    ping.status, camera_id
                )
                # Log health audit
                await conn.execute(
                    "INSERT INTO camera_health_logs (camera_id, status, response_time_ms) VALUES ($1, $2, $3)",
                    camera_id, ping.status, ping.response_time_ms
                )
        return {"status": "success", "camera_id": str(camera_id), "current_status": ping.status}
    
    # In-memory fallback
    found = False
    for c in memory_registry.cameras:
        if str(c["id"]) == str(camera_id):
            c["status"] = ping.status
            found = True
            break
    if not found:
        raise HTTPException(status_code=404, detail="Camera not found.")
    return {"status": "success", "camera_id": str(camera_id), "current_status": ping.status}
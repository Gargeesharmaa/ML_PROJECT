from fastapi import APIRouter, Depends, Query
from typing import Optional
from app.db import get_optional_pool
from app.store import memory_registry
import asyncpg

router = APIRouter(prefix="/api/reports", tags=["4. Gap-Analysis & Ageing Infrastructure"])

@router.get("/ageing-infrastructure")
async def get_ageing_report(
    min_age_years: float = Query(3.0, description="Minimum age threshold in years"),
    db: Optional[asyncpg.Pool] = Depends(get_optional_pool)
):
    """Identify outdated cameras that need hardware upgrades"""
    if db is not None:
        query = """
            SELECT 
                c.id, c.camera_code, c.make_model, c.camera_type, c.ageing, c.status, d.dept_name,
                ST_Y(c.location::geometry) as latitude,
                ST_X(c.location::geometry) as longitude
            FROM cameras c
            JOIN departments d ON c.dept_id = d.id
            WHERE c.ageing >= $1
            ORDER BY c.ageing DESC;
        """
        rows = await db.fetch(query, min_age_years)
        return [dict(row) for row in rows]
    
    return memory_registry.get_ageing_report(min_age_years)

@router.get("/gap-analysis")
async def get_uncovered_zones(
    buffer_radius_meters: float = Query(1000.0, description="Coverage radius around existing cameras"),
    db: Optional[asyncpg.Pool] = Depends(get_optional_pool)
):
    """Generates coverage gaps by returning aggregated coverage polygon bounds"""
    if db is not None:
        query = """
            SELECT 
                d.dept_name,
                COUNT(c.id) as camera_count,
                ST_AsGeoJSON(ST_Union(ST_Buffer(c.location::geography, $1)::geometry))::json AS coverage_union_geojson
            FROM departments d
            JOIN cameras c ON d.id = c.dept_id
            GROUP BY d.dept_name;
        """
        rows = await db.fetch(query, buffer_radius_meters)
        return [dict(row) for row in rows]
    
    return memory_registry.get_gap_analysis(buffer_radius_meters)
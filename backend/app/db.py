import asyncpg
import logging
from typing import Optional
from fastapi import HTTPException, status
from app.config import settings

logger = logging.getLogger("cctv_api.db")

pool: Optional[asyncpg.Pool] = None

async def init_db():
    global pool
    try:
        pool = await asyncpg.create_pool(
            dsn=settings.DATABASE_URL,
            min_size=2,
            max_size=10,
            timeout=3.0
        )
        logger.info("Successfully connected to PostGIS database pool.")
    except Exception as exc:
        logger.warning(f"PostGIS database offline ({exc}). Using in-memory fallback store.")
        pool = None

async def close_db():
    global pool
    if pool:
        await pool.close()
        pool = None

async def get_optional_pool() -> Optional[asyncpg.Pool]:
    """Returns asyncpg Pool if connected, otherwise None (allowing fallback store)."""
    global pool
    if pool is None:
        try:
            pool = await asyncpg.create_pool(
                dsn=settings.DATABASE_URL,
                min_size=2,
                max_size=10,
                timeout=2.0
            )
        except Exception:
            pool = None
    return pool

async def get_pool() -> asyncpg.Pool:
    global pool
    if pool is None:
        try:
            pool = await asyncpg.create_pool(
                dsn=settings.DATABASE_URL,
                min_size=2,
                max_size=10,
                timeout=3.0
            )
        except Exception:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="PostGIS Database is currently offline. Please ensure Docker container 'cctv_registry_db' is running ('docker-compose up -d')."
            )
    return pool
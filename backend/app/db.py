import asyncpg
import logging
import urllib.parse
import ssl
from typing import Optional, Dict, Any
from fastapi import HTTPException, status
from app.config import settings

logger = logging.getLogger("cctv_api.db")

pool: Optional[asyncpg.Pool] = None

def get_asyncpg_connect_args(raw_url: str) -> Dict[str, Any]:
    """Prepares connection kwargs for asyncpg, safely handling SSL for Supabase / Cloud DBs."""
    parsed = urllib.parse.urlsplit(raw_url)
    query_params = urllib.parse.parse_qs(parsed.query)

    needs_ssl = False
    if "sslmode" in query_params:
        mode = query_params["sslmode"][0].lower()
        if mode in ("require", "verify-ca", "verify-full"):
            needs_ssl = True
    elif any(host in parsed.netloc.lower() for host in ["supabase.co", "supabase.com", "neon.tech", "render.com", "railway.app"]):
        needs_ssl = True

    ssl_context = None
    if needs_ssl:
        ssl_context = ssl.create_default_context()
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE

    # Strip query parameters that asyncpg doesn't accept in DSN string
    filtered_params = {k: v for k, v in query_params.items() if k.lower() not in ("sslmode", "channel_binding")}
    new_query = urllib.parse.urlencode(filtered_params, doseq=True)
    clean_dsn = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, new_query, parsed.fragment))

    kwargs: Dict[str, Any] = {"dsn": clean_dsn}
    if ssl_context:
        kwargs["ssl"] = ssl_context
    return kwargs

async def init_db():
    global pool
    try:
        connect_args = get_asyncpg_connect_args(settings.DATABASE_URL)
        pool = await asyncpg.create_pool(
            min_size=2,
            max_size=10,
            timeout=5.0,
            **connect_args
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
            connect_args = get_asyncpg_connect_args(settings.DATABASE_URL)
            pool = await asyncpg.create_pool(
                min_size=2,
                max_size=10,
                timeout=3.0,
                **connect_args
            )
        except Exception:
            pool = None
    return pool

async def get_pool() -> asyncpg.Pool:
    global pool
    if pool is None:
        try:
            connect_args = get_asyncpg_connect_args(settings.DATABASE_URL)
            pool = await asyncpg.create_pool(
                min_size=2,
                max_size=10,
                timeout=5.0,
                **connect_args
            )
        except Exception:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="PostGIS Database is currently offline. Please ensure database is running and DATABASE_URL is configured correctly."
            )
    return pool
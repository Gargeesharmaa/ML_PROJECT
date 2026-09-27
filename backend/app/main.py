from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from app.db import init_db, close_db
from app.routers import departments, onboarding, map, health, reports, metadata, validation, stream

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: Connect to PostGIS DB Pool
    await init_db()
    yield
    # Shutdown: Close Pool
    await close_db()

app = FastAPI(
    title="Camera Surveillance & GIS Management API",
    description="Statewide CCTV registry and GIS Foundation for Gujarat Departments",
    version="1.0.0",
    lifespan=lifespan
)

# Enable CORS for React GIS Map Frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Attach Routers
app.include_router(departments.router)
app.include_router(onboarding.router)
app.include_router(map.router)
app.include_router(health.router)
app.include_router(reports.router)
app.include_router(metadata.router)
app.include_router(validation.router)
app.include_router(stream.router)

@app.get("/")
async def root():
    return {
        "system": "Gujarat Sentinel - Camera Surveillance & GIS Management API",
        "status": "online",
        "docs": "/docs"
    }
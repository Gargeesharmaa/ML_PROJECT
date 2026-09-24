from pydantic import BaseModel, Field, model_validator
from typing import Optional
from uuid import UUID
from datetime import datetime

class CameraBase(BaseModel):
    dept_id: Optional[UUID] = None
    department_name: Optional[str] = None
    dept_name: Optional[str] = None
    camera_code: str
    make_model: Optional[str] = None
    source_type: Optional[str] = Field(default="NETWORK_CCTV", pattern="^(NETWORK_CCTV|LOCAL_WEBCAM)$")
    ip_address: Optional[str] = None
    rtsp_url: Optional[str] = None
    latitude: Optional[float] = Field(default=None, ge=-90, le=90)
    longitude: Optional[float] = Field(default=None, ge=-180, le=180)
    camera_type: Optional[str] = Field(default="FIXED", pattern="^(PTZ|BULLET|DOME|THERMAL|FIXED)$")
    status: Optional[str] = Field(default="OFFLINE", pattern="^(ONLINE|OFFLINE|MAINTENANCE)$")
    ageing: Optional[float] = 0.0

class CameraCreate(CameraBase):
    @model_validator(mode="after")
    def validate_source_requirements(self):
        if not self.department_name and self.dept_name:
            self.department_name = self.dept_name
        if not self.dept_id and not self.department_name:
            raise ValueError("Either dept_id or department_name must be provided.")
        if self.source_type == "NETWORK_CCTV":
            if self.latitude is None or self.longitude is None:
                raise ValueError("Latitude and Longitude are required for NETWORK_CCTV.")
            if not self.ip_address:
                raise ValueError("IP Address is required for NETWORK_CCTV.")
            if not self.rtsp_url:
                raise ValueError("RTSP URL is required for NETWORK_CCTV.")
        return self

class CameraResponse(BaseModel):
    id: UUID
    dept_id: UUID
    camera_code: str
    source_type: str
    make_model: Optional[str] = None
    ip_address: Optional[str] = None
    rtsp_url: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    camera_type: Optional[str] = None
    status: str
    ageing: Optional[float] = 0.0
    last_ping_at: Optional[datetime] = None
    created_at: datetime

    class Config:
        from_attributes = True

class HealthPing(BaseModel):
    status: str = Field(..., pattern="^(ONLINE|OFFLINE|MAINTENANCE)$")
    response_time_ms: Optional[int] = None

class IPValidationRequest(BaseModel):
    ip_address: str = Field(..., description="IPv4 or host address of the camera")
    port: Optional[int] = Field(default=554, ge=1, le=65535, description="Port to probe (default: 554 for RTSP, 80 for HTTP)")
    timeout_seconds: Optional[float] = Field(default=2.0, ge=0.5, le=10.0, description="Probe timeout in seconds")

class IPValidationResponse(BaseModel):
    ip_address: str
    is_valid_format: bool
    is_private: bool
    is_reachable: bool
    port_tested: int
    latency_ms: Optional[float] = None
    detail: str
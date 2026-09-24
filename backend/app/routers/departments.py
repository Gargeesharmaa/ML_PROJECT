from fastapi import APIRouter, HTTPException, Depends, status
from pydantic import BaseModel, Field
from typing import List, Optional
from uuid import UUID
from app.db import get_optional_pool
from app.store import memory_registry
import asyncpg

router = APIRouter(prefix="/api/departments", tags=["0. Departments"])

class DepartmentCreate(BaseModel):
    dept_name: str = Field(..., min_length=2, max_length=100)
    zone_code: str = Field(..., min_length=2, max_length=50)

class DepartmentResponse(BaseModel):
    id: UUID
    dept_name: str
    zone_code: str

@router.get("", response_model=List[DepartmentResponse])
async def list_departments(db: Optional[asyncpg.Pool] = Depends(get_optional_pool)):
    """Fetch all registered departments in the state"""
    if db is not None:
        query = """
            SELECT id, dept_name, zone_code
            FROM departments
            ORDER BY dept_name ASC;
        """
        rows = await db.fetch(query)
        return [dict(row) for row in rows]
    return memory_registry.get_departments()

@router.post("", response_model=DepartmentResponse, status_code=status.HTTP_201_CREATED)
async def create_department(dept: DepartmentCreate, db: Optional[asyncpg.Pool] = Depends(get_optional_pool)):
    """Create a new department in the central registry"""
    if db is not None:
        query = """
            INSERT INTO departments (dept_name, zone_code)
            VALUES ($1, $2)
            RETURNING id, dept_name, zone_code;
        """
        try:
            row = await db.fetchrow(query, dept.dept_name.strip(), dept.zone_code.strip())
            return dict(row)
        except asyncpg.UniqueViolationError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Department '{dept.dept_name}' already exists."
            )
    return memory_registry.add_department(dept.dept_name.strip(), dept.zone_code.strip())

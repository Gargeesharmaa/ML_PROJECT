from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import Field

class Settings(BaseSettings):
    database_url: str = Field(
        default="postgresql://cctv_admin:cctv_password123@127.0.0.1:5432/cctv_registry_db",
        validation_alias="DATABASE_URL"
    )
    cors_origins: str = Field(
        default="*",
        validation_alias="CORS_ORIGINS"
    )
    environment: str = Field(
        default="development",
        validation_alias="ENVIRONMENT"
    )
    port: int = Field(
        default=8000,
        validation_alias="PORT"
    )
    host: str = Field(
        default="0.0.0.0",
        validation_alias="HOST"
    )

    @property
    def DATABASE_URL(self) -> str:
        """Returns a standard PostgreSQL DSN compatible with asyncpg."""
        return self.database_url.replace("postgresql+asyncpg://", "postgresql://")

    @property
    def allowed_cors_origins(self) -> list[str]:
        """Parses comma-separated CORS origins or returns wildcard."""
        if not self.cors_origins or self.cors_origins.strip() == "*":
            return ["*"]
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False
    )

settings = Settings()
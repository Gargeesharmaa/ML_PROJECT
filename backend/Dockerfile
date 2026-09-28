FROM python:3.11-slim

# Prevent Python from writing .pyc files and enable unbuffered standard out
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8000 \
    HOST=0.0.0.0

WORKDIR /app

# Install system libraries needed by OpenCV, FFmpeg, and healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Upgrade pip and install CPU-only PyTorch to minimize image size and memory overhead
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cpu

# Copy and install python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy all application files (code, ANPR weights, demo video, scripts)
COPY . .

# Ensure storage directories exist for detection crops
RUN mkdir -p /app/data/anpr_crops

# Expose default port
EXPOSE 8000

# Container healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

# Start FastAPI application binding dynamically to Render's assigned $PORT
CMD ["sh", "-c", "uvicorn app.main:app --host ${HOST} --port ${PORT}"]

import asyncio
import logging
from typing import AsyncGenerator
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse, Response
from app.store import memory_registry

router = APIRouter(prefix="/api/cameras", tags=["Live Camera Streaming"])
logger = logging.getLogger("uvicorn.error")

async def generate_mjpeg_stream(rtsp_url: str) -> AsyncGenerator[bytes, None]:
    """Spawns FFmpeg to read RTSP and yield MJPEG frames directly to the client."""
    cmd = [
        "ffmpeg",
        "-nostdin",
        "-loglevel", "error",
        "-rtsp_transport", "tcp",
        "-reconnect", "1",
        "-reconnect_at_eof", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
        "-analyzeduration", "2000000",
        "-probesize", "2000000",
        "-i", rtsp_url,
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "-q:v", "4",
        "-r", "20",
        "-vf", "scale=960:-1",
        "-"
    ]

    process = None
    try:
        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        buffer = bytearray()
        while True:
            chunk = await process.stdout.read(8192)
            if not chunk:
                break
            buffer.extend(chunk)

            while True:
                soi = buffer.find(b"\xff\xd8")
                if soi == -1:
                    buffer.clear()
                    break
                eoi = buffer.find(b"\xff\xd9", soi + 2)
                if eoi == -1:
                    # Need more data for complete frame
                    if soi > 0:
                        buffer = buffer[soi:]
                    break

                frame = bytes(buffer[soi:eoi + 2])
                buffer = buffer[eoi + 2:]

                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(len(frame)).encode() + b"\r\n\r\n" +
                    frame + b"\r\n"
                )
    except (asyncio.CancelledError, GeneratorExit):
        pass
    except Exception as exc:
        logger.warning(f"Error in MJPEG stream: {exc}")
    finally:
        if process:
            try:
                process.terminate()
                await process.wait()
            except Exception:
                pass

@router.get("/{camera_id}/stream")
async def stream_camera(camera_id: str):
    """Live MJPEG video stream of the specified camera."""
    camera = memory_registry.get_camera_by_id(camera_id)
    if not camera:
        # Search by camera_code as fallback
        for c in memory_registry.get_all_cameras():
            if c.camera_code == camera_id:
                camera = c
                break

    if not camera:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Camera with ID '{camera_id}' not found."
        )

    rtsp_url = camera.get("rtsp_url") if isinstance(camera, dict) else getattr(camera, "rtsp_url", None)
    http_stream_url = camera.get("http_stream_url") if isinstance(camera, dict) else getattr(camera, "http_stream_url", None)
    source_type = camera.get("source_type") if isinstance(camera, dict) else getattr(camera, "source_type", None)

    stream_input = rtsp_url or http_stream_url
    if not stream_input or source_type == "LOCAL_WEBCAM":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This camera does not have an active RTSP or HTTP stream URL."
        )

    return StreamingResponse(
        generate_mjpeg_stream(stream_input),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )

@router.get("/{camera_id}/snapshot")
async def snapshot_camera(camera_id: str):
    """Capture a single frame snapshot from the camera RTSP/HTTP stream."""
    camera = memory_registry.get_camera_by_id(camera_id)
    if not camera:
        for c in memory_registry.get_all_cameras():
            code = c.get("camera_code") if isinstance(c, dict) else getattr(c, "camera_code", None)
            if code == camera_id:
                camera = c
                break

    rtsp_url = camera.get("rtsp_url") if isinstance(camera, dict) else getattr(camera, "rtsp_url", None)
    http_stream_url = camera.get("http_stream_url") if isinstance(camera, dict) else getattr(camera, "http_stream_url", None)
    stream_input = rtsp_url or http_stream_url

    if not camera or not stream_input:
        raise HTTPException(status_code=404, detail="Camera or RTSP stream not found.")

    cmd = [
        "ffmpeg",
        "-nostdin",
        "-loglevel", "error",
        "-rtsp_transport", "tcp",
        "-analyzeduration", "2000000",
        "-probesize", "2000000",
        "-i", stream_input,
        "-vframes", "1",
        "-q:v", "2",
        "-f", "image2",
        "-update", "1",
        "pipe:1"
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=15.0)
        if stdout and len(stdout) > 100:
            return Response(content=stdout, media_type="image/jpeg")
        raise HTTPException(status_code=502, detail="Failed to capture frame from stream.")
    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"SNAPSHOT EXCEPTION: {type(exc)} {repr(exc)}")
        raise HTTPException(status_code=502, detail=f"Snapshot error: {repr(exc)}")

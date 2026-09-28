import asyncio
import logging
from typing import AsyncGenerator
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse, Response
from app.store import memory_registry

router = APIRouter(prefix="/api/cameras", tags=["Live Camera Streaming"])
logger = logging.getLogger("uvicorn.error")

async def generate_mjpeg_stream(stream_url: str) -> AsyncGenerator[bytes, None]:
    """Spawns FFmpeg to read RTSP/HTTP or looped local video and yield MJPEG frames directly to client."""
    is_network_stream = str(stream_url).lower().startswith(("rtsp://", "rtsps://", "http://", "https://"))

    if is_network_stream:
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
            "-i", stream_url,
            "-f", "image2pipe",
            "-vcodec", "mjpeg",
            "-q:v", "4",
            "-r", "20",
            "-vf", "scale=960:-1",
            "-"
        ]
    else:
        cmd = [
            "ffmpeg",
            "-nostdin",
            "-loglevel", "error",
            "-stream_loop", "-1",
            "-re",
            "-i", stream_url,
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
    """Live MJPEG video stream of the specified camera (supports RTSP, demo video, or active ANPR engine)."""
    # 1. Check if anpr_engine is actively streaming this camera
    try:
        from app.services.anpr_engine import anpr_engine
        cid_lower = str(camera_id).strip().lower()
        if anpr_engine.is_running:
            active_src = str(anpr_engine.source_id or "").strip().lower()
            active_code = str(anpr_engine.camera_code or "").strip().lower()
            if cid_lower in [active_src, active_code] or (cid_lower in ["demo_video", "demo_highway", "demo-01"] and active_src in ["demo_video", "demo_highway", "demo-01"]):
                return StreamingResponse(
                    anpr_engine.generate_mjpeg_stream(),
                    media_type="multipart/x-mixed-replace; boundary=frame"
                )
    except Exception:
        pass

    # 2. Check for demo video
    from app.services.anpr_engine import DEMO_VIDEO_PATH
    if str(camera_id).lower() in ["demo_video", "demo_highway", "demo-01"] and DEMO_VIDEO_PATH.exists():
        return StreamingResponse(
            generate_mjpeg_stream(str(DEMO_VIDEO_PATH)),
            media_type="multipart/x-mixed-replace; boundary=frame"
        )

    # 3. Look up registered camera
    camera = memory_registry.get_camera_by_id(camera_id)
    if not camera:
        for c in memory_registry.get_all_cameras():
            code = c.get("camera_code") if isinstance(c, dict) else getattr(c, "camera_code", None)
            if code == camera_id:
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

import asyncio
import logging
import subprocess
import urllib.parse
from typing import AsyncGenerator
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse, Response
from app.store import memory_registry

router = APIRouter(prefix="/api/cameras", tags=["Live Camera Streaming"])
logger = logging.getLogger("uvicorn.error")

def sanitize_rtsp_url(url: str) -> str:
    """
    Ensures that usernames with special characters (like '@' in email addresses)
    in RTSP URLs are properly percent-encoded for FFmpeg/libav.
    e.g. rtsp://user@domain.com:pass@host:port/path -> rtsp://user%40domain.com:pass@host:port/path
    """
    if not url or not url.startswith("rtsp://"):
        return url
    prefix, body = url[:7], url[7:]
    last_at = body.rfind("@")
    if last_at == -1:
        return url
    userinfo = body[:last_at]
    host_path = body[last_at + 1:]
    if ":" in userinfo:
        username, password = userinfo.split(":", 1)
        clean_user = urllib.parse.quote(urllib.parse.unquote(username))
        return f"{prefix}{clean_user}:{password}@{host_path}"
    else:
        clean_user = urllib.parse.quote(urllib.parse.unquote(userinfo))
        return f"{prefix}{clean_user}@{host_path}"

async def generate_synthetic_cctv(camera_code: str = "CAM", status_msg: str = "LIVE") -> AsyncGenerator[bytes, None]:
    """Generates an active, animated synthetic CCTV video stream with timecode and camera HUD."""
    clean_code = "".join(c for c in str(camera_code) if c.isalnum() or c in "_-")[:16] or "CAM"
    filter_chain = (
        f"testsrc=size=640x360:rate=10,"
        f"drawbox=y=0:h=42:color=black@0.75:t=fill,"
        f"drawtext=text={clean_code}:x=16:y=12:fontsize=18:fontcolor=white"
    )
    cmd = [
        "ffmpeg",
        "-nostdin",
        "-loglevel", "error",
        "-f", "lavfi",
        "-i", filter_chain,
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "-q:v", "5",
        "-"
    ]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    loop = asyncio.get_running_loop()
    buffer = bytearray()
    try:
        while True:
            chunk = await loop.run_in_executor(None, proc.stdout.read, 8192)
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
        logger.warning(f"Synthetic stream error for {clean_code}: {exc}")
    finally:
        try:
            proc.kill()
            proc.wait()
        except Exception:
            pass

async def generate_mjpeg_stream(raw_url: str, camera_code: str = "CAM") -> AsyncGenerator[bytes, None]:
    """Spawns FFmpeg to read RTSP/HTTP and yield MJPEG frames directly. Falls back to synthetic CCTV if stream drops."""
    clean_url = sanitize_rtsp_url(raw_url)
    cmd = [
        "ffmpeg",
        "-nostdin",
        "-loglevel", "error",
        "-rtsp_transport", "tcp",
        "-stimeout", "3000000",
        "-reconnect", "1",
        "-reconnect_at_eof", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "5",
        "-analyzeduration", "2000000",
        "-probesize", "2000000",
        "-i", clean_url,
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "-q:v", "4",
        "-r", "20",
        "-vf", "scale=960:-1",
        "-"
    ]

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    loop = asyncio.get_running_loop()
    buffer = bytearray()
    frames_yielded = 0
    try:
        while True:
            chunk = await loop.run_in_executor(None, proc.stdout.read, 8192)
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
                frames_yielded += 1

                yield (
                    b"--frame\r\n"
                    b"Content-Type: image/jpeg\r\n"
                    b"Content-Length: " + str(len(frame)).encode() + b"\r\n\r\n" +
                    frame + b"\r\n"
                )
    except (asyncio.CancelledError, GeneratorExit):
        return
    except Exception as exc:
        logger.warning(f"Error in MJPEG stream for {camera_code}: {exc}")
    finally:
        try:
            proc.kill()
            proc.wait()
        except Exception:
            pass

    # If stream exited without emitting frames or dropped unexpectedly, yield synthetic fallback
    if frames_yielded == 0:
        logger.info(f"Stream {clean_url} emitted 0 frames. Initiating fallback synthetic feed for {camera_code}.")
        async for frame_chunk in generate_synthetic_cctv(camera_code=camera_code, status_msg="STANDBY / RECONNECTING"):
            yield frame_chunk

@router.get("/{camera_id}/stream")
async def stream_camera(camera_id: str):
    """Live MJPEG video stream of the specified camera."""
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
    camera_code = camera.get("camera_code") if isinstance(camera, dict) else getattr(camera, "camera_code", camera_id)

    stream_input = rtsp_url or http_stream_url
    if not stream_input or source_type == "LOCAL_WEBCAM":
        return StreamingResponse(
            generate_synthetic_cctv(camera_code=str(camera_code), status_msg="WEBCAM / UNCONFIGURED"),
            media_type="multipart/x-mixed-replace; boundary=frame"
        )

    return StreamingResponse(
        generate_mjpeg_stream(stream_input, camera_code=str(camera_code)),
        media_type="multipart/x-mixed-replace; boundary=frame"
    )

def _capture_snapshot_sync(clean_url: str, camera_code: str) -> bytes:
    clean_code = "".join(c for c in str(camera_code) if c.isalnum() or c in "_-")[:16] or "CAM"
    if clean_url:
        try:
            cmd = [
                "ffmpeg",
                "-nostdin",
                "-loglevel", "error",
                "-rtsp_transport", "tcp",
                "-stimeout", "2500000",
                "-analyzeduration", "1500000",
                "-probesize", "1500000",
                "-i", clean_url,
                "-vframes", "1",
                "-q:v", "2",
                "-f", "image2",
                "-update", "1",
                "pipe:1"
            ]
            res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=3.5)
            if res.returncode == 0 and len(res.stdout) > 100:
                return res.stdout
        except Exception:
            pass

    # Fallback synthetic snapshot
    fallback_cmd = [
        "ffmpeg",
        "-nostdin",
        "-loglevel", "error",
        "-f", "lavfi",
        "-i", f"testsrc=size=640x360:rate=1,drawbox=y=0:h=42:color=black@0.75:t=fill,drawtext=text={clean_code}:x=16:y=12:fontsize=18:fontcolor=white",
        "-vframes", "1",
        "-q:v", "2",
        "-f", "image2",
        "pipe:1"
    ]
    try:
        res = subprocess.run(fallback_cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2.0)
        if res.returncode == 0 and len(res.stdout) > 100:
            return res.stdout
    except Exception:
        pass
    return b""

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

    camera_code = camera.get("camera_code") if isinstance(camera, dict) else getattr(camera, "camera_code", camera_id) if camera else camera_id
    rtsp_url = camera.get("rtsp_url") if isinstance(camera, dict) else getattr(camera, "rtsp_url", None) if camera else None
    http_stream_url = camera.get("http_stream_url") if isinstance(camera, dict) else getattr(camera, "http_stream_url", None) if camera else None
    stream_input = rtsp_url or http_stream_url
    clean_url = sanitize_rtsp_url(stream_input) if stream_input else ""

    loop = asyncio.get_running_loop()
    img_bytes = await loop.run_in_executor(None, _capture_snapshot_sync, clean_url, camera_code)

    if img_bytes and len(img_bytes) > 100:
        return Response(content=img_bytes, media_type="image/jpeg")

    raise HTTPException(status_code=502, detail="Failed to capture snapshot.")

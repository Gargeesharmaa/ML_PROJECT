import asyncio
import ipaddress
import time
from fastapi import APIRouter, status
from app.schemas.cameras import IPValidationRequest, IPValidationResponse

router = APIRouter(prefix="/api/cameras", tags=["6. Network Validation & Diagnostics"])

@router.post("/validate-ip", response_model=IPValidationResponse)
async def validate_camera_ip(req: IPValidationRequest):
    """
    Validates IP address format and executes a real-time TCP socket connectivity probe
    against the target device port (e.g., port 554 for RTSP, port 80 for HTTP).
    """
    raw_ip = req.ip_address.strip()

    # 1. Format Validation using Python standard ipaddress module
    try:
        ip_obj = ipaddress.ip_address(raw_ip)
    except ValueError:
        return IPValidationResponse(
            ip_address=raw_ip,
            is_valid_format=False,
            is_private=False,
            is_reachable=False,
            port_tested=req.port,
            latency_ms=None,
            detail=f"'{raw_ip}' is not a valid IP address. Enter a valid IPv4 address (e.g. 192.168.1.100 or 10.10.1.11)."
        )

    is_private = ip_obj.is_private or ip_obj.is_loopback

    # 2. Live Network Socket Connectivity Probe
    start_time = time.perf_counter()
    target_host = str(ip_obj)
    ports_to_try = [req.port]
    # If standard 554 RTSP was requested, also try HTTP port 80 if 554 times out
    if req.port == 554:
        ports_to_try.append(80)

    for port in ports_to_try:
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(target_host, port),
                timeout=req.timeout_seconds
            )
            elapsed_ms = round((time.perf_counter() - start_time) * 1000, 2)
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass

            port_label = "RTSP" if port == 554 else ("HTTP" if port == 80 else f"Port {port}")
            return IPValidationResponse(
                ip_address=target_host,
                is_valid_format=True,
                is_private=is_private,
                is_reachable=True,
                port_tested=port,
                latency_ms=elapsed_ms,
                detail=f"Camera is ONLINE and reachable via {port_label} (response time: {elapsed_ms}ms)."
            )
        except asyncio.TimeoutError:
            continue
        except ConnectionRefusedError:
            # Host exists and sent TCP RST (host is alive on network but specific port is closed)
            elapsed_ms = round((time.perf_counter() - start_time) * 1000, 2)
            return IPValidationResponse(
                ip_address=target_host,
                is_valid_format=True,
                is_private=is_private,
                is_reachable=False,
                port_tested=port,
                latency_ms=elapsed_ms,
                detail=f"Host is active on network, but port {port} refused connection. Verify RTSP service is enabled on the camera."
            )
        except OSError as exc:
            continue

    total_elapsed = round((time.perf_counter() - start_time) * 1000, 2)
    return IPValidationResponse(
        ip_address=target_host,
        is_valid_format=True,
        is_private=is_private,
        is_reachable=False,
        port_tested=req.port,
        latency_ms=None,
        detail=f"Host unreachable. No response on {target_host}:{req.port} within {req.timeout_seconds}s timeout (probed for {total_elapsed}ms)."
    )

import { useState, useEffect, useRef } from "react";
import {
  Grid,
  Maximize2,
  Minimize2,
  Camera,
  Play,
  Volume2,
  VolumeX,
  RefreshCw,
  AlertTriangle,
  Sliders,
  Radio,
  Layers,
  Sparkles,
  Shield,
  Eye
} from "lucide-react";

export default function SurveillanceMatrix({ onNavigateToOnboarding }) {
  const [cameras, setCameras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [layout, setLayout] = useState("2x2"); // "2x2" | "3x3" | "1+3"
  const [selectedSlots, setSelectedSlots] = useState({}); // slotIndex -> camera object
  const [currentTime, setCurrentTime] = useState(new Date().toUTCString());
  const [fullscreenTile, setFullscreenTile] = useState(null); // slotIndex | null
  const localVideoRefs = useRef({});

  // 1. Fetch Registered Cameras
  useEffect(() => {
    async function fetchCameras() {
      setLoading(true);
      try {
        const res = await fetch("/api/cameras");
        if (res.ok) {
          const data = await res.json();
          const camList = Array.isArray(data) ? data : (data.cameras || []);
          setCameras(camList);

          // Auto-fill initial slots with available cameras
          const initialSlots = {};
          camList.slice(0, 4).forEach((cam, idx) => {
            initialSlots[idx] = cam;
          });
          setSelectedSlots(initialSlots);
        }
      } catch (err) {
        console.error("Error fetching cameras for matrix:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchCameras();
  }, []);

  // 2. Real-time UTC surveillance clock
  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      setCurrentTime(
        `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
          now.getDate()
        ).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}:${String(
          now.getMinutes()
        ).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")} IST`
      );
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // 3. Setup Local Webcam Streams when a slot has LOCAL_WEBCAM
  useEffect(() => {
    const activeStreams = [];
    Object.entries(selectedSlots).forEach(([slotIdx, cam]) => {
      if (cam?.source_type === "LOCAL_WEBCAM") {
        const videoEl = localVideoRefs.current[slotIdx];
        if (videoEl && navigator.mediaDevices?.getUserMedia) {
          navigator.mediaDevices
            .getUserMedia({ video: true, audio: false })
            .then((stream) => {
              videoEl.srcObject = stream;
              videoEl.play().catch(() => {});
              activeStreams.push(stream);
            })
            .catch((err) => {
              console.warn("Could not start local webcam stream:", err);
            });
        }
      }
    });

    return () => {
      activeStreams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    };
  }, [selectedSlots]);

  // Determine slot count based on layout
  const getSlotCount = () => {
    if (layout === "3x3") return 9;
    if (layout === "1+3") return 4;
    return 4; // 2x2
  };

  const slotCount = getSlotCount();
  const slotsArray = Array.from({ length: slotCount }, (_, i) => i);

  // Quick Action: Tile all ANPR Cameras
  const handleTileAnpr = () => {
    const anprCams = cameras.filter((c) => (c.camera_type || "").toUpperCase() === "ANPR");
    const newSlots = {};
    slotsArray.forEach((slotIdx) => {
      if (anprCams[slotIdx]) {
        newSlots[slotIdx] = anprCams[slotIdx];
      }
    });
    setSelectedSlots(newSlots);
  };

  // Quick Action: Tile Online Cameras
  const handleTileOnline = () => {
    const onlineCams = cameras.filter((c) => (c.status || "ONLINE").toUpperCase() === "ONLINE");
    const newSlots = {};
    slotsArray.forEach((slotIdx) => {
      if (onlineCams[slotIdx]) {
        newSlots[slotIdx] = onlineCams[slotIdx];
      }
    });
    setSelectedSlots(newSlots);
  };

  // Clear Matrix
  const handleClearMatrix = () => {
    setSelectedSlots({});
  };

  // Assign Camera to Slot
  const handleAssignCamera = (slotIdx, camId) => {
    if (!camId) {
      const next = { ...selectedSlots };
      delete next[slotIdx];
      setSelectedSlots(next);
      return;
    }
    const found = cameras.find((c) => String(c.id || c.camera_code) === String(camId));
    if (found) {
      setSelectedSlots({
        ...selectedSlots,
        [slotIdx]: found,
      });
    }
  };

  return (
    <div className="surveillance-matrix-container">
      {/* MATRIX CONTROL HEADER */}
      <div className="matrix-control-bar">
        <div className="matrix-title-group">
          <div className="live-pulsing-badge">
            <Radio size={14} className="pulse-icon" />
            <span>COMMAND MATRIX LIVE</span>
          </div>
          <h3>Surveillance Video Wall</h3>
          <span className="live-clock">{currentTime}</span>
        </div>

        {/* CONTROLS */}
        <div className="matrix-actions-group">
          {/* Quick Presets */}
          <button
            type="button"
            className="matrix-preset-btn"
            onClick={handleTileAnpr}
            title="Auto-fill video wall with all registered ANPR cameras"
          >
            <Shield size={14} />
            <span>Tile ANPR Cameras</span>
          </button>

          <button
            type="button"
            className="matrix-preset-btn"
            onClick={handleTileOnline}
            title="Fill tiles with active online cameras"
          >
            <Sparkles size={14} />
            <span>Tile Online</span>
          </button>

          <button
            type="button"
            className="matrix-preset-btn text-muted"
            onClick={handleClearMatrix}
          >
            Clear Wall
          </button>

          {/* Layout Selector */}
          <div className="layout-switcher">
            <button
              type="button"
              className={`layout-btn ${layout === "2x2" ? "active" : ""}`}
              onClick={() => setLayout("2x2")}
              title="2x2 Grid (4 Feeds)"
            >
              2x2
            </button>
            <button
              type="button"
              className={`layout-btn ${layout === "3x3" ? "active" : ""}`}
              onClick={() => setLayout("3x3")}
              title="3x3 Grid (9 Feeds)"
            >
              3x3
            </button>
            <button
              type="button"
              className={`layout-btn ${layout === "1+3" ? "active" : ""}`}
              onClick={() => setLayout("1+3")}
              title="1 Large + 3 Side Feeds"
            >
              1+3
            </button>
          </div>
        </div>
      </div>

      {/* MATRIX EMPTY STATE IF NO CAMERAS REGISTERED */}
      {cameras.length === 0 && !loading && (
        <div className="matrix-no-cams-card">
          <Camera size={44} />
          <h4>No Registered Cameras in Registry</h4>
          <p>
            You haven't registered any CCTV or ANPR cameras yet. Onboard your first camera or import sample cameras via CSV to monitor them simultaneously on this video wall.
          </p>
          <button
            type="button"
            className="primary-button"
            onClick={onNavigateToOnboarding}
          >
            Onboard Cameras Now
          </button>
        </div>
      )}

      {/* VIDEO WALL GRID */}
      {cameras.length > 0 && (
        <div className={`matrix-grid layout-${layout} ${fullscreenTile !== null ? "has-fullscreen" : ""}`}>
          {slotsArray.map((slotIdx) => {
            const cam = selectedSlots[slotIdx];
            const isFullscreen = fullscreenTile === slotIdx;
            const isAnpr = (cam?.camera_type || "").toUpperCase() === "ANPR";
            const isLocal = cam?.source_type === "LOCAL_WEBCAM";

            if (fullscreenTile !== null && !isFullscreen) return null;

            return (
              <div
                key={slotIdx}
                className={`matrix-tile ${isFullscreen ? "fullscreen-tile" : ""} ${
                  layout === "1+3" && slotIdx === 0 ? "focus-tile" : ""
                }`}
              >
                {/* TILE HEADER / CAMERA SELECTOR */}
                <div className="tile-top-bar">
                  <div className="tile-cam-info">
                    {cam ? (
                      <>
                        <span className="live-rec-dot">● REC</span>
                        <strong className="tile-code">{cam.camera_code}</strong>
                        {isAnpr && <span className="anpr-tile-pill">ANPR</span>}
                        <span className="tile-dept">{cam.dept_name}</span>
                      </>
                    ) : (
                      <span className="empty-slot-label">Slot #{slotIdx + 1} — Idle</span>
                    )}
                  </div>

                  <div className="tile-actions">
                    <select
                      className="tile-cam-select"
                      value={cam ? (cam.id || cam.camera_code) : ""}
                      onChange={(e) => handleAssignCamera(slotIdx, e.target.value)}
                    >
                      <option value="">-- Choose Camera --</option>
                      {cameras.map((c) => (
                        <option key={c.id || c.camera_code} value={c.id || c.camera_code}>
                          {c.camera_code} ({c.camera_type || "CCTV"}) - {c.dept_name}
                        </option>
                      ))}
                    </select>

                    {cam && (
                      <button
                        type="button"
                        className="tile-tool-btn"
                        onClick={() => setFullscreenTile(isFullscreen ? null : slotIdx)}
                        title={isFullscreen ? "Exit Fullscreen" : "Fullscreen this feed"}
                      >
                        {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                      </button>
                    )}
                  </div>
                </div>

                {/* TILE VIDEO DISPLAY AREA */}
                <div className="tile-video-viewport">
                  {cam ? (
                    <>
                      {/* Video Stream Element */}
                      {isLocal ? (
                        <video
                          ref={(el) => (localVideoRefs.current[slotIdx] = el)}
                          className="tile-video-element"
                          autoPlay
                          playsInline
                          muted
                        />
                      ) : (
                        <img
                          src={`/api/cameras/${cam.id || cam.camera_code}/stream?t=${Date.now()}`}
                          alt={cam.camera_code}
                          className="tile-stream-img"
                          onError={(e) => {
                            // Fallback simulation background if stream server is offline
                            e.currentTarget.style.display = "none";
                            const fallback = e.currentTarget.parentElement.querySelector(".tile-fallback-sim");
                            if (fallback) fallback.style.display = "flex";
                          }}
                        />
                      )}

                      {/* Stream Fallback Simulation */}
                      <div className="tile-fallback-sim" style={{ display: isLocal ? "none" : "none" }}>
                        <div className="sim-scanline"></div>
                        <div className="sim-crosshair"></div>
                        <p>CONNECTING RTSP GATEWAY</p>
                        <span>{cam.rtsp_url || "1080p @ 25 FPS"}</span>
                      </div>

                      {/* TILE OSD OVERLAYS */}
                      <div className="tile-osd-top-left">
                        <span>{currentTime}</span>
                      </div>
                      <div className="tile-osd-top-right">
                        <span>CH-0{slotIdx + 1} | 1080P @ 25FPS</span>
                      </div>
                      <div className="tile-osd-bottom-left">
                        <span>{cam.ip_address || "NETWORK STREAM"}</span>
                      </div>
                      <div className="tile-osd-bottom-right">
                        <span>{cam.status || "ONLINE"}</span>
                      </div>
                    </>
                  ) : (
                    <div className="empty-tile-prompt">
                      <Camera size={32} />
                      <p>Slot #{slotIdx + 1} Available</p>
                      <span>Select a camera from the dropdown above</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

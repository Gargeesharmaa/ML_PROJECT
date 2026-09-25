import { useState, useEffect, useRef, useMemo } from "react";
import {
  Grid,
  Maximize2,
  Minimize2,
  Camera,
  Play,
  RefreshCw,
  AlertTriangle,
  Radio,
  Layers,
  Sparkles,
  Shield,
  Eye,
  Filter,
  Trash2,
  Video,
  Download,
  Clock
} from "lucide-react";

export default function SurveillanceMatrix({ onNavigateToOnboarding, onOpenStreamModal }) {
  const [cameras, setCameras] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [layout, setLayout] = useState("2x2"); // "2x2" | "3x3" | "4x4" | "1+5"
  const [selectedSlots, setSelectedSlots] = useState({}); // slotIndex -> camera object
  const [currentTime, setCurrentTime] = useState("");
  const [fullscreenTile, setFullscreenTile] = useState(null); // slotIndex | null
  const [deptFilter, setDeptFilter] = useState("ALL");
  const localVideoRefs = useRef({});

  // 1. Fetch Registered Cameras & Departments
  useEffect(() => {
    async function fetchCameras() {
      setLoading(true);
      try {
        const [camsRes, deptsRes] = await Promise.all([
          fetch("/api/cameras"),
          fetch("/api/departments")
        ]);

        let camList = [];
        if (camsRes.ok) {
          const data = await camsRes.json();
          if (Array.isArray(data)) {
            camList = data;
          } else if (data.features && Array.isArray(data.features)) {
            camList = data.features.map((f) => ({
              ...(f.properties || {}),
              latitude: f.geometry?.coordinates?.[1],
              longitude: f.geometry?.coordinates?.[0],
            }));
          } else if (data.cameras) {
            camList = data.cameras;
          }
          setCameras(camList);

          // Auto-fill initial 4 slots with the first available cameras
          const initialSlots = {};
          camList.slice(0, 4).forEach((cam, idx) => {
            initialSlots[idx] = cam;
          });
          setSelectedSlots(initialSlots);
        }

        if (deptsRes.ok) {
          const deptsData = await deptsRes.json();
          setDepartments(deptsData);
        }
      } catch (err) {
        console.error("Error fetching cameras for matrix:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchCameras();
  }, []);

  // 2. Real-time Indian Standard Time (IST) surveillance clock
  useEffect(() => {
    const updateClock = () => {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
      setCurrentTime(`${dateStr} ${timeStr} IST`);
    };

    updateClock();
    const timer = setInterval(updateClock, 1000);
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
    if (layout === "4x4") return 16;
    if (layout === "3x3") return 9;
    if (layout === "1+5") return 6;
    return 4; // 2x2
  };

  const slotCount = getSlotCount();
  const slotsArray = Array.from({ length: slotCount }, (_, i) => i);

  // Filtered cameras based on department selector
  const availableCameras = useMemo(() => {
    if (deptFilter === "ALL") return cameras;
    return cameras.filter((c) => (c.dept_name || "") === deptFilter);
  }, [cameras, deptFilter]);

  // Quick Action: Tile Online Cameras
  const handleTileOnline = () => {
    const onlineCams = availableCameras.filter((c) => (c.status || "ONLINE").toUpperCase() === "ONLINE");
    const newSlots = {};
    slotsArray.forEach((slotIdx) => {
      if (onlineCams[slotIdx]) {
        newSlots[slotIdx] = onlineCams[slotIdx];
      }
    });
    setSelectedSlots(newSlots);
  };

  // Quick Action: Tile Sentinel H.265 Cameras
  const handleTileH265 = () => {
    const h265Cams = availableCameras.filter((c) => (c.codec || "").toUpperCase() === "H.265");
    const newSlots = {};
    slotsArray.forEach((slotIdx) => {
      if (h265Cams[slotIdx]) {
        newSlots[slotIdx] = h265Cams[slotIdx];
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

  // Take Snapshot for a specific slot
  const handleTakeSnapshot = (cam) => {
    if (!cam) return;
    const a = document.createElement("a");
    a.href = `/api/cameras/${cam.camera_code || cam.id}/snapshot?t=${Date.now()}`;
    a.download = `snapshot_${cam.camera_code || "CAM"}_${Date.now()}.jpg`;
    a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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
          <div>
            <h3>Gujarat Police Surveillance Video Wall</h3>
            <p className="matrix-subtitle">Simultaneous multi-stream spatial monitoring grid</p>
          </div>
          <span className="live-clock">
            <Clock size={13} />
            {currentTime}
          </span>
        </div>

        {/* CONTROLS */}
        <div className="matrix-actions-group">
          {/* Department Filter */}
          <div className="matrix-dept-filter">
            <Filter size={13} />
            <select
              value={deptFilter}
              onChange={(e) => setDeptFilter(e.target.value)}
              className="dept-select"
            >
              <option value="ALL">All Departments ({cameras.length})</option>
              {departments.map((d) => (
                <option key={d.id || d.dept_name} value={d.dept_name}>
                  {d.dept_name}
                </option>
              ))}
            </select>
          </div>

          {/* Quick Presets */}
          <button
            type="button"
            className="matrix-preset-btn"
            onClick={handleTileOnline}
            title="Auto-fill video wall with all active online cameras"
          >
            <Sparkles size={14} />
            <span>Tile Online ({availableCameras.length})</span>
          </button>

          <button
            type="button"
            className="matrix-preset-btn"
            onClick={handleTileH265}
            title="Auto-fill with Sentinel H.265 (HEVC) cameras"
          >
            <Shield size={14} />
            <span>Tile H.265</span>
          </button>

          <button
            type="button"
            className="matrix-preset-btn text-muted"
            onClick={handleClearMatrix}
            title="Clear all assigned camera feeds from video wall"
          >
            <Trash2 size={13} />
            <span>Clear Wall</span>
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
              className={`layout-btn ${layout === "4x4" ? "active" : ""}`}
              onClick={() => setLayout("4x4")}
              title="4x4 Grid (16 Feeds)"
            >
              4x4
            </button>
            <button
              type="button"
              className={`layout-btn ${layout === "1+5" ? "active" : ""}`}
              onClick={() => setLayout("1+5")}
              title="1 Large Focus Feed + 5 Satellite Feeds"
            >
              1+5 Focus
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
            You haven't registered any CCTV cameras yet. Onboard your first camera or sync with the Sentinel Gateway to monitor them simultaneously on this video wall.
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
            const isLocal = cam?.source_type === "LOCAL_WEBCAM";
            const isOnline = (cam?.status || "ONLINE").toUpperCase() === "ONLINE";
            const codec = (cam?.codec || "H.264").toUpperCase();

            if (fullscreenTile !== null && !isFullscreen) return null;

            return (
              <div
                key={slotIdx}
                className={`matrix-tile ${isFullscreen ? "fullscreen-tile" : ""} ${
                  layout === "1+5" && slotIdx === 0 ? "focus-tile" : ""
                }`}
              >
                {/* TILE HEADER / CAMERA SELECTOR */}
                <div className="tile-top-bar">
                  <div className="tile-cam-info">
                    {cam ? (
                      <>
                        <span className={`live-rec-dot ${isOnline ? "online" : "offline"}`}>
                          ● {isOnline ? "REC" : "OFF"}
                        </span>
                        <strong className="tile-code">{cam.camera_code}</strong>
                        <span
                          className="tile-codec-pill"
                          style={{
                            background: codec === "H.265" ? "#7c3aed" : "#2563eb",
                            color: "#fff",
                            fontSize: "9px",
                            fontWeight: 700,
                            padding: "1px 5px",
                            borderRadius: "3px"
                          }}
                        >
                          {codec}
                        </span>
                        <span className="tile-dept" title={cam.dept_name}>
                          {cam.dept_name}
                        </span>
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
                      {availableCameras.map((c) => (
                        <option key={c.id || c.camera_code} value={c.id || c.camera_code}>
                          {c.camera_code} ({c.codec || "H.264"}) - {c.dept_name}
                        </option>
                      ))}
                    </select>

                    {cam && (
                      <>
                        {onOpenStreamModal && (
                          <button
                            type="button"
                            className="tile-tool-btn"
                            onClick={() => onOpenStreamModal(cam)}
                            title="Inspect in Single Camera Modal (PTZ & Multi-protocol)"
                          >
                            <Eye size={13} />
                          </button>
                        )}

                        <button
                          type="button"
                          className="tile-tool-btn"
                          onClick={() => handleTakeSnapshot(cam)}
                          title="Capture Snapshot"
                        >
                          <Camera size={13} />
                        </button>

                        <button
                          type="button"
                          className="tile-tool-btn"
                          onClick={() => setFullscreenTile(isFullscreen ? null : slotIdx)}
                          title={isFullscreen ? "Exit Fullscreen" : "Fullscreen this feed"}
                        >
                          {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                        </button>
                      </>
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
                          src={`/api/cameras/${cam.camera_code || cam.id}/stream`}
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
                      <div className="tile-fallback-sim" style={{ display: "none" }}>
                        <div className="sim-scanline"></div>
                        <div className="sim-crosshair"></div>
                        <p>RTSP TCP GATEWAY CONNECTING</p>
                        <span>{cam.rtsp_url || "1080p @ 25 FPS"}</span>
                      </div>

                      {/* TILE OSD OVERLAYS */}
                      <div className="tile-osd-top-left">
                        <span>{currentTime}</span>
                      </div>
                      <div className="tile-osd-top-right">
                        <span>CH-0{slotIdx + 1} | {codec} @ 25FPS</span>
                      </div>
                      <div className="tile-osd-bottom-left">
                        <span>{cam.ip_address || "103.250.160.189"}</span>
                      </div>
                      <div className="tile-osd-bottom-right">
                        <span>{isOnline ? "ONLINE" : "OFFLINE"}</span>
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

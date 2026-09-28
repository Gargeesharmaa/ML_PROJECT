import { useState, useEffect, useRef } from "react";
import {
  Shield,
  Search,
  AlertTriangle,
  CheckCircle2,
  Camera,
  Play,
  Square,
  RotateCw,
  Sliders,
  Car,
  Truck,
  Bike,
  Activity,
  Zap,
  Radio,
  FileSpreadsheet,
  Upload,
  Crosshair,
  X,
  Eye,
  Trash2,
  Maximize2,
  Minimize2,
  Filter,
  Layers,
  MapPin,
  ExternalLink
} from "lucide-react";
import "./AnprRadar.css";

function AutoRickshawIcon({ size = 15 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "inline-block", verticalAlign: "middle" }}
    >
      <circle cx="5" cy="18" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M5 15l2-8h8l3 5v6" />
      <path d="M7 7l4-4h4" />
      <line x1="12" y1="7" x2="12" y2="15" />
      <line x1="8" y1="18" x2="15" y2="18" />
    </svg>
  );
}

function renderVehicleBadge(vtype) {
  const typeStr = (vtype || "Car").toLowerCase();
  if (typeStr.includes("auto") || typeStr.includes("rickshaw")) {
    return (
      <span className="vbadge vbadge-auto" title="Auto-Rickshaw (Three-Wheeler)">
        <AutoRickshawIcon size={14} />
        <span>Auto-Rickshaw</span>
      </span>
    );
  }
  if (typeStr.includes("motorcycle") || typeStr.includes("bike")) {
    return (
      <span className="vbadge vbadge-bike" title="Motorcycle / Two-Wheeler">
        <Bike size={14} />
        <span>Motorcycle</span>
      </span>
    );
  }
  if (typeStr.includes("bus")) {
    return (
      <span className="vbadge vbadge-bus" title="Bus / Public Transit">
        <Truck size={14} />
        <span>Bus</span>
      </span>
    );
  }
  if (typeStr.includes("truck")) {
    return (
      <span className="vbadge vbadge-truck" title="Commercial Heavy Truck">
        <Truck size={14} />
        <span>Truck</span>
      </span>
    );
  }
  if (typeStr.includes("van") || typeStr.includes("suv")) {
    return (
      <span className="vbadge vbadge-van" title="Van / SUV">
        <Car size={14} />
        <span>Van / SUV</span>
      </span>
    );
  }
  return (
    <span className="vbadge vbadge-car" title="Passenger Car">
      <Car size={14} />
      <span>Car</span>
    </span>
  );
}

export default function AnprRadar({ onNavigateToOnboarding }) {
  // 1. Sources & Stream State
  const [sources, setSources] = useState([]);
  const [selectedSourceId, setSelectedSourceId] = useState("demo_video");
  const [isRunning, setIsRunning] = useState(false);
  const [streamUrl, setStreamUrl] = useState("/api/anpr/stream");
  const [fps, setFps] = useState(0);
  const [feedMode, setFeedMode] = useState("LIVE"); // LIVE vs STANDBY
  const [feedStatusText, setFeedStatusText] = useState("");
  const [isCctvModalOpen, setIsCctvModalOpen] = useState(false);
  const [cctvSearchQuery, setCctvSearchQuery] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);

  // 2. Search & Target Interception State
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [activeTarget, setActiveTarget] = useState(null); // { plate, status: "CATCHED"|"NOT_SEEN_YET", event?: ... }
  const [searchNotice, setSearchNotice] = useState(null); // { type: "info"|"warning"|"error"|"success", message: string }
  const [uploadedPreview, setUploadedPreview] = useState(null);

  // 3. Real Detection Logs State
  const [events, setEvents] = useState([]);
  const [logFilter, setLogFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("ALL"); // "ALL" | "CATCHED" | "AUTO" | "BIKE" | "CAR" | "COMMERCIAL"
  const [previewCrop, setPreviewCrop] = useState(null); // High-res crop modal preview

  const fileInputRef = useRef(null);
  const videoWrapperRef = useRef(null);

  // Load available sources on mount
  useEffect(() => {
    async function loadSources() {
      try {
        const res = await fetch("/api/anpr/sources");
        if (res.ok) {
          const data = await res.json();
          setSources(data);
          if (data.length > 0 && !selectedSourceId) {
            setSelectedSourceId(data[0].id);
          }
        }
      } catch (err) {
        console.error("Failed to fetch ANPR sources:", err);
      }
    }

    async function checkStatus() {
      try {
        const res = await fetch("/api/anpr/status");
        if (res.ok) {
          const data = await res.json();
          setIsRunning(data.is_running);
          setFps(data.fps || 0);
          setFeedMode(data.feed_mode || "LIVE");
          setFeedStatusText(data.feed_status_text || "");
          if (data.target_plate) {
            setActiveTarget({
              plate: data.target_plate,
              status: data.is_target_catched ? "CATCHED" : "NOT_SEEN_YET",
              event: data.catched_event
            });
          }
        }
      } catch (err) {
        console.error("Failed to check ANPR status:", err);
      }
    }

    loadSources();
    checkStatus();
    loadEvents();
  }, []);

  // Fetch Detection Events
  const loadEvents = async () => {
    try {
      const res = await fetch("/api/anpr/events?limit=80");
      if (res.ok) {
        const data = await res.json();
        setEvents(data);
      }
    } catch (err) {
      console.error("Failed to fetch ANPR events:", err);
    }
  };

  // Periodic Polling for Telemetry & Events when running
  useEffect(() => {
    let interval = null;
    if (isRunning) {
      interval = setInterval(async () => {
        try {
          const res = await fetch("/api/anpr/status");
          if (res.ok) {
            const data = await res.json();
            setFps(data.fps || 0);
            setIsRunning(data.is_running);
            setFeedMode(data.feed_mode || "LIVE");
            setFeedStatusText(data.feed_status_text || "");

            if (data.target_plate) {
              if (data.is_target_catched && data.catched_event) {
                setActiveTarget((prev) => ({
                  ...prev,
                  plate: data.target_plate,
                  status: "CATCHED",
                  event: data.catched_event
                }));
              }
            }
          }
          loadEvents();
        } catch (err) {
          console.warn("Telemetry polling error:", err);
        }
      }, 2500);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isRunning]);

  // Toggle Stream On / Off
  const handleToggleStream = async () => {
    if (isRunning) {
      try {
        await fetch("/api/anpr/stop", { method: "POST" });
        setIsRunning(false);
      } catch (err) {
        console.error("Failed to stop stream:", err);
      }
    } else {
      const curSource = sources.find((s) => s.id === selectedSourceId) || sources[0];
      try {
        const res = await fetch("/api/anpr/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source_type: curSource?.source_type || "DEMO_VIDEO",
            source_id: curSource?.id || "demo_video",
            source_name: curSource?.name || "Demo Highway Video",
            rtsp_url: curSource?.rtsp_url || ""
          })
        });
        if (res.ok) {
          setIsRunning(true);
          setStreamUrl(`/api/anpr/stream?t=${Date.now()}`);
        }
      } catch (err) {
        console.error("Failed to start stream:", err);
      }
    }
  };

  // Change Selected Source
  const handleSelectSource = async (sourceId) => {
    setSelectedSourceId(sourceId);
    const targetSource = sources.find((s) => s.id === sourceId);
    if (!targetSource) return;

    try {
      const res = await fetch("/api/anpr/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_type: targetSource.source_type,
          source_id: targetSource.id,
          source_name: targetSource.name,
          rtsp_url: targetSource.rtsp_url || ""
        })
      });
      if (res.ok) {
        const st = await res.json();
        setIsRunning(true);
        setFeedMode(st.feed_mode || "LIVE");
        setFeedStatusText(st.feed_status_text || "");
        setStreamUrl(`/api/anpr/stream?t=${Date.now()}`);
      }
    } catch (err) {
      console.error("Failed to switch source:", err);
    }
  };

  // Text Plate Search
  const handleSearchText = async (e) => {
    e.preventDefault();
    const clean = searchQuery.trim().toUpperCase();
    if (!clean) return;

    setIsSearching(true);
    setSearchNotice(null);

    try {
      const res = await fetch("/api/anpr/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plate_number: clean })
      });
      const data = await res.json();

      if (data.status === "CATCHED") {
        setActiveTarget({
          plate: clean,
          status: "CATCHED",
          event: data.event
        });
        setSearchNotice({
          type: "success",
          message: data.message || `🚨 TARGET CATCHED! Vehicle intercepted in camera logs.`
        });
      } else {
        setActiveTarget({
          plate: clean,
          status: "NOT_SEEN_YET"
        });
        setSearchNotice({
          type: "info",
          message: `ℹ️ Not seen yet. Target ${clean} locked. Actively scanning video streams across cameras...`
        });
      }
      loadEvents();
    } catch (err) {
      console.error("Search error:", err);
      setSearchNotice({ type: "error", message: "Error contacting ANPR search service." });
    } finally {
      setIsSearching(false);
    }
  };

  // Search by Image Upload (Vehicle / Plate Photo)
  const handleImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsSearching(true);
    setSearchNotice(null);

    // Show thumbnail preview chip
    const previewReader = new FileReader();
    previewReader.onload = () => setUploadedPreview(previewReader.result);
    previewReader.readAsDataURL(file);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/anpr/search-image", {
        method: "POST",
        body: formData
      });
      const data = await res.json();

      if (data.status === "NOT_RECOGNIZED") {
        setSearchNotice({
          type: "warning",
          message: "⚠️ Could not recognize a number plate in the uploaded image. Please try a clearer photo or enter plate number manually."
        });
      } else if (data.status === "CATCHED") {
        setActiveTarget({
          plate: data.extracted_plate || data.target_plate,
          status: "CATCHED",
          event: data.event
        });
        setSearchNotice({
          type: "success",
          message: `🚨 TARGET CATCHED! Plate recognized: ${data.extracted_plate}. Vehicle was intercepted on ${data.event?.dept_name || "Camera"}!`
        });
      } else if (data.status === "NOT_SEEN_YET") {
        setActiveTarget({
          plate: data.extracted_plate || data.target_plate,
          status: "NOT_SEEN_YET"
        });
        setSearchNotice({
          type: "info",
          message: `ℹ️ Plate recognized: ${data.extracted_plate}. Status: Not seen yet. Target locked and scanning video streams...`
        });
      }
      loadEvents();
    } catch (err) {
      console.error("Image upload error:", err);
      setSearchNotice({ type: "error", message: "Failed to process vehicle image." });
    } finally {
      setIsSearching(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  // Clear Active Target
  const handleClearTarget = async () => {
    try {
      await fetch("/api/anpr/clear-target", { method: "POST" });
    } catch (err) {
      console.warn("Clear target error:", err);
    }
    setActiveTarget(null);
    setSearchNotice(null);
    setSearchQuery("");
    setUploadedPreview(null);
  };

  // Clear All Detection Logs
  const handleClearLogs = async () => {
    if (!window.confirm("Are you sure you want to clear all ANPR detection logs?")) return;
    try {
      await fetch("/api/anpr/events", { method: "DELETE" });
      setEvents([]);
    } catch (err) {
      console.error("Failed to clear logs:", err);
    }
  };

  // Export Logs to CSV
  const handleExportCsv = () => {
    if (events.length === 0) return;
    const headers = "event_id,timestamp,camera,vehicle_type,plate_number,confidence,status\n";
    const rows = events
      .map(
        (e) =>
          `"${e.event_id}","${e.timestamp}","${e.dept_name || e.camera_name || e.camera_id}","${e.vehicle?.type || "Car"}","${e.plate?.number || ""}","${e.plate?.confidence || 0.9}","${e.status || "NORMAL"}"`
      )
      .join("\n");
    const blob = new Blob([headers + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `anpr_detections_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Filtered Detection Events
  const filteredEvents = events.filter((ev) => {
    const plateText = (ev.plate?.number || ev.plate?.raw_number || "").toLowerCase();
    if (logFilter && !plateText.includes(logFilter.toLowerCase())) {
      return false;
    }
    const isCatched = ev.is_target_catched || ev.status === "TARGET_CATCHED";
    const vtype = (ev.vehicle?.type || "Car").toLowerCase();

    if (categoryFilter === "CATCHED" && !isCatched) return false;
    if (categoryFilter === "AUTO" && !vtype.includes("auto") && !vtype.includes("rickshaw")) return false;
    if (categoryFilter === "BIKE" && !vtype.includes("motorcycle") && !vtype.includes("bike")) return false;
    if (categoryFilter === "CAR" && !vtype.includes("car") && !vtype.includes("suv") && !vtype.includes("van")) return false;
    if (categoryFilter === "COMMERCIAL" && !vtype.includes("truck") && !vtype.includes("bus")) return false;

    return true;
  });

  const activeSource = sources.find((s) => s.id === selectedSourceId) || sources[0];
  const registeredCctvCount = sources.filter((s) => s.source_type === "CAMERA").length;

  // Toggle Video Monitor Fullscreen
  const toggleFullscreen = () => {
    if (!videoWrapperRef.current) return;
    if (!isFullscreen) {
      if (videoWrapperRef.current.requestFullscreen) {
        videoWrapperRef.current.requestFullscreen();
      }
      setIsFullscreen(true);
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
      setIsFullscreen(false);
    }
  };

  // Filtered CCTV cameras for the selector modal
  const filteredCctvCameras = sources
    .filter((s) => s.source_type === "CAMERA")
    .filter((s) => {
      if (!cctvSearchQuery) return true;
      const q = cctvSearchQuery.toLowerCase();
      return (
        (s.code && s.code.toLowerCase().includes(q)) ||
        (s.name && s.name.toLowerCase().includes(q)) ||
        (s.location && s.location.toLowerCase().includes(q)) ||
        (s.ip_address && s.ip_address.includes(q))
      );
    });

  return (
    <div className="anpr-radar-container">
      {/* 1. TOP HEADER & TELEMETRY BAR */}
      <div className="anpr-header">
        <div className="anpr-title-group">
          <div className="anpr-badge">
            <Radio size={14} className="radar-pulse-icon" />
            <span>GUJARAT SENTINEL · ANPR INTELLIGENCE & INTERCEPTION MATRIX</span>
          </div>
          <h2>Automated Number Plate Recognition (ANPR) & Suspect Interception</h2>
          <p>
            Real-time multi-class vehicle detection (Auto-Rickshaw, Motorcycle, Bus, Truck, Car),
            optical character recognition (HSRP), and instant suspect vehicle interception across Gujarat state surveillance.
          </p>
        </div>

        {/* STREAM TELEMETRY PILLS */}
        <div className="anpr-telemetry-cluster">
          <div className="telemetry-pill">
            <Activity size={13} style={{ color: isRunning ? "#10b981" : "#94a3b8" }} />
            <span>{isRunning ? "ENGINE ACTIVE" : "ENGINE IDLE"}</span>
          </div>
          {isRunning && (
            <div className="telemetry-pill fps-pill">
              <Zap size={13} style={{ color: "#38bdf8" }} />
              <span>{fps} FPS</span>
            </div>
          )}
          <div className="telemetry-pill count-pill">
            <Car size={13} style={{ color: "#f59e0b" }} />
            <span>{events.length} Detections</span>
          </div>
        </div>
      </div>

      {/* 2. MODERN SOURCE NAVIGATION & QUICK SWITCHER BAR */}
      <div className="anpr-source-nav-bar">
        <div className="source-nav-tabs">
          {/* Tab 1: Demo Video */}
          <button
            type="button"
            className={`source-nav-tab ${selectedSourceId === "demo_video" ? "active" : ""}`}
            onClick={() => handleSelectSource("demo_video")}
          >
            <span className="tab-icon">🎥</span>
            <div className="tab-text">
              <strong>Demo Traffic Feed</strong>
              <small>NH-48 Expressway (test_video.mp4)</small>
            </div>
            {selectedSourceId === "demo_video" && <span className="tab-active-dot"></span>}
          </button>

          {/* Tab 2: Laptop Webcam */}
          <button
            type="button"
            className={`source-nav-tab ${selectedSourceId === "laptop_webcam" ? "active" : ""}`}
            onClick={() => handleSelectSource("laptop_webcam")}
          >
            <span className="tab-icon">💻</span>
            <div className="tab-text">
              <strong>Laptop Live Webcam</strong>
              <small>Device 0 (Integrated Camera)</small>
            </div>
            {selectedSourceId === "laptop_webcam" && <span className="tab-active-dot"></span>}
          </button>

          {/* Tab 3: Statewide CCTV Grid */}
          <button
            type="button"
            className={`source-nav-tab cctv-tab ${selectedSourceId !== "demo_video" && selectedSourceId !== "laptop_webcam" ? "active" : ""}`}
            onClick={() => setIsCctvModalOpen(true)}
          >
            <span className="tab-icon">📹</span>
            <div className="tab-text">
              <strong>Statewide CCTV Grid</strong>
              <small>
                {selectedSourceId !== "demo_video" && selectedSourceId !== "laptop_webcam"
                  ? `${activeSource?.code || "Active"} · ${activeSource?.location || "CCTV"}`
                  : `${registeredCctvCount} Registered Cameras`}
              </small>
            </div>
            <span className="cctv-picker-badge">Select Camera ▾</span>
          </button>
        </div>

        {/* STREAM ACTION BUTTON */}
        <div className="stream-action-group">
          <button
            type="button"
            className={`anpr-stream-toggle-btn ${isRunning ? "btn-stop" : "btn-start"}`}
            onClick={handleToggleStream}
          >
            {isRunning ? (
              <>
                <Square size={15} fill="currentColor" />
                <span>Stop Stream</span>
              </>
            ) : (
              <>
                <Play size={15} fill="currentColor" />
                <span>Start Stream</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* 3. COHESIVE TARGET SEARCH COMMAND HUB (TEXT + IMAGE UPLOAD) */}
      <div className="anpr-search-command-card">
        <div className="search-card-header">
          <div className="search-header-title">
            <Crosshair size={18} className="search-icon-pulse" />
            <div>
              <strong>TARGET VEHICLE SEARCH & INTERCEPTION MATRIX</strong>
              <p>Enter suspect license plate or upload vehicle photo. Immediate alert triggers when spotted.</p>
            </div>
          </div>
          {activeTarget && (
            <button
              type="button"
              className="clear-search-link"
              onClick={handleClearTarget}
            >
              <X size={13} />
              <span>Clear Target</span>
            </button>
          )}
        </div>

        <div className="search-inputs-cluster">
          {/* TEXT SEARCH INPUT */}
          <form onSubmit={handleSearchText} className="search-text-form">
            <div className="plate-input-wrapper">
              <span className="hsrp-input-badge">IND</span>
              <input
                type="text"
                placeholder="Enter plate number (e.g. 16J921, GJ01AB1234)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value.toUpperCase())}
                className="plate-text-input"
              />
            </div>
            <button
              type="submit"
              disabled={isSearching || !searchQuery.trim()}
              className="btn-search-trigger"
            >
              <Search size={14} />
              <span>{isSearching ? "Searching..." : "Search & Track"}</span>
            </button>
          </form>

          <span className="search-or-divider">OR</span>

          {/* IMAGE UPLOAD BUTTON */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={handleImageUpload}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isSearching}
            className="btn-upload-photo"
          >
            <Upload size={14} />
            <span>Upload Vehicle / Plate Photo</span>
          </button>

          {/* UPLOADED THUMBNAIL CHIP */}
          {uploadedPreview && (
            <div className="uploaded-chip">
              <img src={uploadedPreview} alt="Uploaded" className="uploaded-chip-img" />
              <span>Uploaded Photo</span>
              <button
                type="button"
                onClick={() => setUploadedPreview(null)}
                className="uploaded-chip-close"
              >
                <X size={12} />
              </button>
            </div>
          )}
        </div>

        {/* SEARCH NOTIFICATION BANNER */}
        {searchNotice && (
          <div className={`search-notice-banner notice-${searchNotice.type}`}>
            {searchNotice.type === "success" ? (
              <CheckCircle2 size={16} />
            ) : searchNotice.type === "warning" ? (
              <AlertTriangle size={16} />
            ) : (
              <Activity size={16} />
            )}
            <span>{searchNotice.message}</span>
          </div>
        )}
      </div>

      {/* 4. TARGET STATUS BANNERS: "CATCHED" vs "NOT SEEN YET" */}
      {activeTarget && (
        activeTarget.status === "CATCHED" ? (
          /* CATCHED BANNER */
          <div className="anpr-catched-alert-banner">
            <div className="catched-badge-icon">
              <AlertTriangle size={24} />
            </div>
            <div className="catched-banner-content">
              <div className="catched-headline-row">
                <h4>🚨 SUSPECT TARGET VEHICLE INTERCEPTED!</h4>
                <span className="catched-tag">MATCH CONFIRMED</span>
              </div>
              <p>
                Suspect vehicle matching target plate was intercepted on Gujarat surveillance grid.
              </p>

              <div className="catched-details-grid">
                <div className="catched-detail-item">
                  <span className="cd-label">Target Plate:</span>
                  <div className="hsrp-plate-wrap hsrp-mini">
                    <div className="hsrp-blue-band"><span className="hsrp-ind">IND</span></div>
                    <span className="hsrp-number">{activeTarget.plate}</span>
                  </div>
                </div>

                <div className="catched-detail-item">
                  <span className="cd-label">Intercepted Camera:</span>
                  <strong className="cd-value">
                    📍 {activeTarget.event?.dept_name || activeTarget.event?.camera_name || "Surveillance Grid"}
                  </strong>
                </div>

                <div className="catched-detail-item">
                  <span className="cd-label">Vehicle Class:</span>
                  <div className="cd-value">
                    {renderVehicleBadge(activeTarget.event?.vehicle?.type)}
                  </div>
                </div>

                <div className="catched-detail-item">
                  <span className="cd-label">Timestamp:</span>
                  <strong className="cd-value">
                    🕒 {new Date(activeTarget.event?.timestamp || Date.now()).toLocaleTimeString()}
                  </strong>
                </div>

                {activeTarget.event?.crop_url && (
                  <div className="catched-detail-item crop-item">
                    <span className="cd-label">Camera Snapshot:</span>
                    <img
                      src={activeTarget.event.crop_url}
                      alt="Crop"
                      className="catched-crop-thumb"
                      onClick={() => setPreviewCrop(activeTarget.event.crop_url)}
                      title="Click to view full-resolution crop"
                    />
                  </div>
                )}
              </div>
            </div>
            <button
              type="button"
              className="catched-dismiss-btn"
              onClick={handleClearTarget}
            >
              Acknowledge & Dismiss
            </button>
          </div>
        ) : (
          /* NOT SEEN YET BANNER */
          <div className="anpr-hunting-radar-banner">
            <div className="hunting-left">
              <div className="hunting-radar-icon-box">
                <Crosshair size={18} className="radar-sweep-spin" />
              </div>
              <div className="hunting-text">
                <div className="hunting-title-row">
                  <strong>TARGET SEARCH ACTIVE:</strong>
                  <div className="hsrp-plate-wrap hsrp-mini">
                    <div className="hsrp-blue-band"><span className="hsrp-ind">IND</span></div>
                    <span className="hsrp-number">{activeTarget.plate}</span>
                  </div>
                </div>
                <p>
                  Status: <strong>Not seen yet</strong> &bull; Actively scanning video streams and checking passing vehicle plates across Gujarat...
                </p>
              </div>
            </div>
            <button
              type="button"
              className="hunting-cancel-btn"
              onClick={handleClearTarget}
            >
              <X size={13} />
              <span>Cancel Search</span>
            </button>
          </div>
        )
      )}

      {/* 5. MAIN WORKSPACE: LIVE VIDEO MONITOR + DETECTION LOGS */}
      <div className="anpr-main-grid">
        {/* LEFT: 16:9 CINEMATIC VIDEO MONITOR */}
        <div className="anpr-video-card" ref={videoWrapperRef}>
          <div className="video-card-header">
            <div className="cam-title-info">
              <Camera size={16} className="cam-icon" />
              <div>
                <strong>{activeSource?.name || "Active Video Source"}</strong>
                <span className="cam-loc-tag">{activeSource?.location || "Gujarat Surveillance"}</span>
              </div>
            </div>

            <div className="stream-badge-group">
              {/* FEED MODE: LIVE vs STANDBY */}
              {isRunning && (
                <span className={`feed-mode-badge mode-${feedMode.toLowerCase()}`}>
                  <span className="pulse-dot"></span>
                  {feedMode === "LIVE" ? "🟢 LIVE FEED" : "🟡 OPTICAL STANDBY"}
                </span>
              )}

              <span className={`live-feed-pill ${isRunning ? "status-online" : "status-offline"}`}>
                <span className="live-dot"></span>
                {isRunning ? "AI INFERENCE RUNNING" : "STREAM PAUSED"}
              </span>

              {isRunning && <span className="fps-counter">{fps} FPS</span>}

              <button
                type="button"
                className="fullscreen-btn"
                onClick={toggleFullscreen}
                title={isFullscreen ? "Exit Fullscreen" : "Fullscreen View"}
              >
                {isFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            </div>
          </div>

          <div className="video-screen-wrapper">
            {isRunning ? (
              <img
                src={streamUrl}
                alt="Live ANPR Stream"
                className="anpr-video-element"
                onError={() => {
                  console.warn("MJPEG stream reconnecting...");
                }}
              />
            ) : (
              <div className="stream-offline-overlay">
                <Camera size={48} className="offline-cam-icon" />
                <h4>SURVEILLANCE STREAM PAUSED</h4>
                <p>Select any source above and click &quot;Start Stream&quot; to begin real-time vehicle and plate tracking.</p>
                <button
                  type="button"
                  className="anpr-stream-toggle-btn btn-start"
                  style={{ marginTop: "16px" }}
                  onClick={handleToggleStream}
                >
                  <Play size={14} fill="currentColor" />
                  <span>Start Stream</span>
                </button>
              </div>
            )}

            {/* RADAR TARGETING RETICLE OVERLAY WHEN SEARCHING */}
            {activeTarget && activeTarget.status === "NOT_SEEN_YET" && isRunning && (
              <div className="anpr-target-scanner-crosshair">
                <div className="reticle-line-scan"></div>
                <div className="reticle-text">
                  <Crosshair size={13} />
                  <span>TARGET LOCKED: {activeTarget.plate}</span>
                </div>
              </div>
            )}

            {/* STANDBY NOTICE BADGE */}
            {isRunning && feedMode === "STANDBY" && (
              <div className="standby-notice-pill" title="Hardware fallback ensures continuous surveillance even if external CCTV host is reconnecting">
                <span>🛡️ Sentinel Auto-Protection: Optical Standby Feed Active</span>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT: REAL-TIME DETECTION LOG TABLE */}
        <div className="anpr-log-card">
          <div className="log-card-header">
            <div className="log-header-left">
              <Activity size={16} />
              <h4>Live Vehicle Detection Logs</h4>
              <span className="log-count">{filteredEvents.length} passed vehicles</span>
            </div>

            <div style={{ display: "flex", gap: "8px" }}>
              {events.length > 0 && (
                <button
                  type="button"
                  className="export-log-btn"
                  onClick={handleClearLogs}
                  title="Clear history"
                  style={{ color: "#f87171" }}
                >
                  <Trash2 size={13} />
                  <span>Clear</span>
                </button>
              )}

              <button
                type="button"
                className="export-log-btn"
                onClick={handleExportCsv}
                title="Download CSV"
              >
                <FileSpreadsheet size={13} />
                <span>Export CSV</span>
              </button>
            </div>
          </div>

          {/* SEARCH & CATEGORY FILTER TABS */}
          <div className="anpr-search-bar">
            <div className="search-input-wrap">
              <Search size={14} className="search-icon" />
              <input
                type="text"
                placeholder="Filter passed cars by plate..."
                value={logFilter}
                onChange={(e) => setLogFilter(e.target.value)}
              />
            </div>
          </div>

          {/* CATEGORY FILTER CHIPS */}
          <div className="category-filter-chips">
            <button
              type="button"
              className={`cat-chip ${categoryFilter === "ALL" ? "active" : ""}`}
              onClick={() => setCategoryFilter("ALL")}
            >
              All Passes ({events.length})
            </button>
            <button
              type="button"
              className={`cat-chip cat-catched ${categoryFilter === "CATCHED" ? "active" : ""}`}
              onClick={() => setCategoryFilter("CATCHED")}
            >
              🎯 Intercepted Only
            </button>
            <button
              type="button"
              className={`cat-chip ${categoryFilter === "AUTO" ? "active" : ""}`}
              onClick={() => setCategoryFilter("AUTO")}
            >
              🛺 Auto-Rickshaws
            </button>
            <button
              type="button"
              className={`cat-chip ${categoryFilter === "BIKE" ? "active" : ""}`}
              onClick={() => setCategoryFilter("BIKE")}
            >
              🏍️ Two-Wheelers
            </button>
            <button
              type="button"
              className={`cat-chip ${categoryFilter === "CAR" ? "active" : ""}`}
              onClick={() => setCategoryFilter("CAR")}
            >
              🚗 Cars & SUVs
            </button>
            <button
              type="button"
              className={`cat-chip ${categoryFilter === "COMMERCIAL" ? "active" : ""}`}
              onClick={() => setCategoryFilter("COMMERCIAL")}
            >
              🚛 Heavy (Buses/Trucks)
            </button>
          </div>

          {/* EVENT TABLE */}
          <div className="anpr-table-scroll">
            <table className="anpr-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Captured Plate (Crop & HSRP)</th>
                  <th>Vehicle Class</th>
                  <th>Location / Camera</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filteredEvents.map((log) => {
                  const isCatched = log.is_target_catched || log.status === "TARGET_CATCHED";
                  return (
                    <tr
                      key={log.event_id}
                      className={isCatched ? "row-alert row-target-intercepted" : ""}
                    >
                      <td className="time-cell">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </td>

                      {/* PHYSICAL CAPTURED PLATE CROP + HSRP NUMBER */}
                      <td>
                        <div className="plate-showcase-cell">
                          {log.crop_url ? (
                            <div
                              className="plate-crop-preview-box"
                              onClick={() => setPreviewCrop(log.crop_url)}
                              title="Physical plate crop from camera - Click to enlarge"
                            >
                              <img
                                src={log.crop_url}
                                alt={log.plate?.number}
                                className="plate-crop-img"
                              />
                              <span className="crop-tag">LIVE CROP</span>
                            </div>
                          ) : null}

                          <div className="hsrp-plate-wrap">
                            <div className="hsrp-blue-band">
                              <span className="hsrp-ind">IND</span>
                            </div>
                            <span className="hsrp-number">
                              {log.plate?.number || log.plate?.raw_number}
                            </span>
                          </div>
                        </div>
                      </td>

                      {/* INTELLIGENT VEHICLE CLASSIFICATION */}
                      <td>
                        {renderVehicleBadge(log.vehicle?.type)}
                      </td>

                      <td>
                        <div className="location-cell">
                          <span className="location-name">
                            {log.dept_name || log.camera_name || log.camera_id}
                          </span>
                          <span className="camera-code-tag">
                            📷 {log.camera_code || "CAM"}
                          </span>
                        </div>
                      </td>

                      <td>
                        <span
                          className={`status-pill ${
                            isCatched ? "status-target" : "status-normal"
                          }`}
                        >
                          {isCatched ? "🎯 CATCHED" : "PASSED"}
                        </span>
                      </td>
                    </tr>
                  );
                })}

                {filteredEvents.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ textAlign: "center", padding: "40px 20px", color: "#94a3b8" }}>
                      <Camera size={28} style={{ margin: "0 auto 10px", opacity: 0.4, display: "block" }} />
                      <p style={{ margin: 0, fontWeight: 600 }}>No vehicle detections found.</p>
                      <span style={{ fontSize: "11px", color: "#64748b" }}>
                        {isRunning
                          ? "Waiting for vehicles to pass in front of camera..."
                          : "Start the stream to detect passing vehicles in real-time."}
                      </span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 6. CCTV CAMERA SELECTOR MODAL */}
      {isCctvModalOpen && (
        <div className="cctv-modal-overlay" onClick={() => setIsCctvModalOpen(false)}>
          <div className="cctv-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="cctv-modal-header">
              <div className="cctv-modal-title">
                <Camera size={20} style={{ color: "#38bdf8" }} />
                <div>
                  <h3>Gujarat Sentinel Statewide CCTV Grid</h3>
                  <p>Select any registered municipal, highway, or toll-plaza CCTV camera to connect stream.</p>
                </div>
              </div>
              <button
                type="button"
                className="cctv-modal-close"
                onClick={() => setIsCctvModalOpen(false)}
              >
                <X size={20} />
              </button>
            </div>

            {/* MODAL SEARCH BAR */}
            <div className="cctv-modal-search">
              <Search size={15} style={{ color: "#64748b" }} />
              <input
                type="text"
                placeholder="Search by city, department, camera code, or IP..."
                value={cctvSearchQuery}
                onChange={(e) => setCctvSearchQuery(e.target.value)}
                autoFocus
              />
              {cctvSearchQuery && (
                <button
                  type="button"
                  onClick={() => setCctvSearchQuery("")}
                  className="search-clear-btn"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {/* CAMERA CARDS GRID */}
            <div className="cctv-cards-grid">
              {filteredCctvCameras.map((cam) => {
                const isSelected = selectedSourceId === cam.id;
                return (
                  <div
                    key={cam.id}
                    className={`cctv-camera-card ${isSelected ? "selected" : ""}`}
                    onClick={() => {
                      handleSelectSource(cam.id);
                      setIsCctvModalOpen(false);
                    }}
                  >
                    <div className="cam-card-top">
                      <span className="cam-code-badge">{cam.code || "CAM"}</span>
                      <span className="cam-status-indicator">
                        <span className="dot"></span>
                        {cam.status || "ONLINE"}
                      </span>
                    </div>
                    <strong className="cam-card-dept">{cam.location || cam.name}</strong>
                    <div className="cam-card-meta">
                      <span>IP: {cam.ip_address || "103.250.160.189"}</span>
                      <span>Model: {cam.make_model || "Generic CCTV"}</span>
                    </div>
                    <button
                      type="button"
                      className={`cam-card-connect-btn ${isSelected ? "active" : ""}`}
                    >
                      {isSelected ? "Currently Connected" : "Connect Stream"}
                    </button>
                  </div>
                );
              })}

              {filteredCctvCameras.length === 0 && (
                <div className="cctv-empty-state">
                  <p>No registered cameras found matching &quot;{cctvSearchQuery}&quot;</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 7. HIGH-RES CROP PREVIEW MODAL */}
      {previewCrop && (
        <div className="crop-modal-overlay" onClick={() => setPreviewCrop(null)}>
          <div className="crop-modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="crop-modal-header">
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <Eye size={18} style={{ color: "#38bdf8" }} />
                <h4>Captured License Plate Optical Inspection</h4>
              </div>
              <button
                type="button"
                onClick={() => setPreviewCrop(null)}
                className="crop-modal-close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="crop-modal-body">
              <img
                src={previewCrop}
                alt="Plate Crop High-Res"
                className="crop-modal-img"
              />
              <div className="crop-modal-caption">
                <span>Verified by YOLOv8 Optical Bounding & EasyOCR Indian Character Corrector</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

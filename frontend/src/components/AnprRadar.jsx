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
  Maximize2
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
      <span className="vbadge vbadge-bus" title="Bus / Transit">
        <Truck size={14} />
        <span>Bus</span>
      </span>
    );
  }
  if (typeStr.includes("truck")) {
    return (
      <span className="vbadge vbadge-truck" title="Commercial Truck">
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
  // Sources & Stream State
  const [sources, setSources] = useState([]);
  const [selectedSourceId, setSelectedSourceId] = useState("demo_video");
  const [isRunning, setIsRunning] = useState(false);
  const [streamUrl, setStreamUrl] = useState("/api/anpr/stream");
  const [fps, setFps] = useState(0);

  // Search & Target Interception State
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [activeTarget, setActiveTarget] = useState(null); // { plate, status: "CATCHED"|"NOT_SEEN_YET", event?: ... }
  const [searchNotice, setSearchNotice] = useState(null); // { type: "info"|"warning"|"error", message: string }
  const [uploadedPreview, setUploadedPreview] = useState(null);

  // Real Detection Logs State
  const [events, setEvents] = useState([]);
  const [logFilter, setLogFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL"); // "ALL" | "CATCHED" | "NORMAL"
  const [previewCrop, setPreviewCrop] = useState(null); // Modal crop view

  const fileInputRef = useRef(null);

  // 1. Fetch available sources on mount
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

  // 2. Fetch Detection Events
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

  // 3. Periodic Polling for Telemetry & Events when running
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
          console.warn("Polling error:", err);
        }
      }, 2500);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isRunning]);

  // 4. Start / Stop Stream
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

  // 5. Change Selected Source
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
        setIsRunning(true);
        setStreamUrl(`/api/anpr/stream?t=${Date.now()}`);
      }
    } catch (err) {
      console.error("Failed to switch source:", err);
    }
  };

  // 6. Search by Number Plate Text
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
          message: data.message || "🚨 TARGET CATCHED! Vehicle intercepted in camera logs."
        });
      } else {
        setActiveTarget({
          plate: clean,
          status: "NOT_SEEN_YET"
        });
        setSearchNotice({
          type: "info",
          message: `ℹ️ Not seen yet. Target ${clean} is locked! Actively scanning video streams across cameras...`
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

  // 7. Search by Image Upload (Vehicle / Plate Photo)
  const handleImageUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsSearching(true);
    setSearchNotice(null);

    // Show local preview
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
          message: "⚠️ Could not recognize a number plate in the uploaded image. Please try a clearer photo or enter plate text manually."
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
          message: `ℹ️ Plate recognized: ${data.extracted_plate}. Status: Not seen yet. Target locked and actively scanning video streams...`
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

  // 8. Clear Active Target Search
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

  // 9. Clear All Detection Logs
  const handleClearLogs = async () => {
    if (!window.confirm("Are you sure you want to clear all ANPR detection logs?")) return;
    try {
      await fetch("/api/anpr/events", { method: "DELETE" });
      setEvents([]);
    } catch (err) {
      console.error("Failed to clear logs:", err);
    }
  };

  // 10. Export Logs to CSV
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

  // Filtered Events
  const filteredEvents = events.filter((ev) => {
    const plateText = (ev.plate?.number || ev.plate?.raw_number || "").toLowerCase();
    if (logFilter && !plateText.includes(logFilter.toLowerCase())) {
      return false;
    }
    if (statusFilter === "CATCHED" && !ev.is_target_catched && ev.status !== "TARGET_CATCHED") {
      return false;
    }
    if (statusFilter === "NORMAL" && (ev.is_target_catched || ev.status === "TARGET_CATCHED")) {
      return false;
    }
    return true;
  });

  const activeSource = sources.find((s) => s.id === selectedSourceId) || sources[0];

  return (
    <div className="anpr-radar-container">
      {/* 1. TOP HEADER & TELEMETRY */}
      <div className="anpr-header">
        <div className="anpr-title-group">
          <div className="anpr-badge">
            <Radio size={14} className="radar-pulse-icon" />
            <span>GUJARAT SENTINEL ANPR INTELLIGENCE</span>
          </div>
          <h2>Automated Number Plate Recognition (ANPR) & Interception</h2>
          <p>Real-time vehicle detection, HSRP optical character recognition, and suspect vehicle matching.</p>
        </div>

        {/* CONTROLS: SOURCE SELECTOR & STREAM TOGGLE */}
        <div className="anpr-quick-controls">
          <div className="select-cam-wrap">
            <Sliders size={14} className="select-icon" />
            <select
              value={selectedSourceId}
              onChange={(e) => handleSelectSource(e.target.value)}
              className="anpr-select"
            >
              <optgroup label="Core Video & Local Feeds">
                {sources.filter(s => s.source_type !== "CAMERA").map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Registered Gujarat Sentinel CCTV Grid">
                {sources.filter(s => s.source_type === "CAMERA").map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </div>

          <button
            type="button"
            className={`anpr-action-btn btn-scan ${isRunning ? "btn-active" : ""}`}
            onClick={handleToggleStream}
          >
            {isRunning ? (
              <>
                <Square size={14} fill="currentColor" />
                <span>Stop Stream</span>
              </>
            ) : (
              <>
                <Play size={14} fill="currentColor" />
                <span>Start Stream</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* 2. DUAL-MODE TARGET SEARCH BAR (TEXT + IMAGE UPLOAD) */}
      <div style={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: "12px", padding: "16px 20px", marginBottom: "20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "10px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Crosshair size={18} style={{ color: "#38bdf8" }} />
            <strong style={{ fontSize: "14px", color: "#f8fafc", letterSpacing: "0.5px" }}>
              TARGET VEHICLE SEARCH & INTERCEPTION
            </strong>
          </div>
          <span style={{ fontSize: "12px", color: "#94a3b8" }}>
            Enter number plate text OR upload a car photo to lock and track.
          </span>
        </div>

        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", alignItems: "center" }}>
          {/* TEXT SEARCH FORM */}
          <form onSubmit={handleSearchText} style={{ display: "flex", gap: "8px", flex: 1, minWidth: "280px" }}>
            <div style={{ position: "relative", flex: 1 }}>
              <Search size={15} style={{ position: "absolute", left: "12px", top: "50%", transform: "translateY(-50%)", color: "#64748b" }} />
              <input
                type="text"
                placeholder="Enter plate number (e.g. 16J921, GJ01AB1234)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  width: "100%",
                  padding: "9px 12px 9px 36px",
                  background: "#1e293b",
                  border: "1px solid #334155",
                  borderRadius: "8px",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontFamily: "monospace",
                  fontWeight: 600,
                  outline: "none"
                }}
              />
            </div>
            <button
              type="submit"
              disabled={isSearching || !searchQuery.trim()}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "6px",
                padding: "9px 16px",
                background: "#0284c7",
                border: "none",
                borderRadius: "8px",
                color: "#ffffff",
                fontSize: "13px",
                fontWeight: 700,
                cursor: "pointer",
                opacity: isSearching || !searchQuery.trim() ? 0.6 : 1
              }}
            >
              <Search size={14} />
              <span>{isSearching ? "Searching..." : "Search & Track"}</span>
            </button>
          </form>

          {/* DIVIDER */}
          <span style={{ color: "#475569", fontSize: "12px", fontWeight: 700 }}>OR</span>

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
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "9px 16px",
              background: "#334155",
              border: "1px solid #475569",
              borderRadius: "8px",
              color: "#f8fafc",
              fontSize: "13px",
              fontWeight: 600,
              cursor: "pointer",
              transition: "all 0.2s"
            }}
          >
            <Upload size={14} />
            <span>Upload Vehicle / Plate Photo</span>
          </button>

          {/* CLEAR TARGET BUTTON IF ACTIVE */}
          {activeTarget && (
            <button
              type="button"
              onClick={handleClearTarget}
              className="clear-target-btn"
            >
              <X size={13} />
              <span>Clear Target</span>
            </button>
          )}
        </div>

        {/* SEARCH NOTIFICATION BANNER */}
        {searchNotice && (
          <div
            style={{
              marginTop: "12px",
              padding: "10px 14px",
              borderRadius: "8px",
              fontSize: "13px",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: "10px",
              background:
                searchNotice.type === "success"
                  ? "rgba(16, 185, 129, 0.15)"
                  : searchNotice.type === "warning"
                  ? "rgba(234, 179, 8, 0.15)"
                  : searchNotice.type === "error"
                  ? "rgba(239, 68, 68, 0.15)"
                  : "rgba(56, 189, 248, 0.15)",
              border:
                searchNotice.type === "success"
                  ? "1px solid rgba(16, 185, 129, 0.4)"
                  : searchNotice.type === "warning"
                  ? "1px solid rgba(234, 179, 8, 0.4)"
                  : searchNotice.type === "error"
                  ? "1px solid rgba(239, 68, 68, 0.4)"
                  : "1px solid rgba(56, 189, 248, 0.4)",
              color:
                searchNotice.type === "success"
                  ? "#34d399"
                  : searchNotice.type === "warning"
                  ? "#facc15"
                  : searchNotice.type === "error"
                  ? "#f87171"
                  : "#38bdf8"
            }}
          >
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

      {/* 3. TARGET STATUS BANNER: "CATCHED" vs "NOT SEEN YET" */}
      {activeTarget && (
        activeTarget.status === "CATCHED" ? (
          /* CATCHED BANNER */
          <div className="anpr-target-intercepted-banner">
            <div className="intercept-icon-wrap" style={{ background: "#ef4444" }}>
              <AlertTriangle size={24} />
            </div>
            <div className="intercept-content">
              <h4 style={{ color: "#fee2e2" }}>🚨 TARGET VEHICLE CATCHED!</h4>
              <p>
                Suspect vehicle matching target plate{" "}
                <span className="highlight-plate">{activeTarget.plate}</span> was intercepted on the surveillance grid!
              </p>
              <div className="intercept-meta-row">
                <span>📍 Camera: <strong>{activeTarget.event?.dept_name || activeTarget.event?.camera_name || "Surveillance Grid"}</strong></span>
                <span>🕒 Intercepted at: <strong>{new Date(activeTarget.event?.timestamp || Date.now()).toLocaleTimeString()}</strong></span>
                <span>🚗 Vehicle Class: <strong>{activeTarget.event?.vehicle?.type || "Car"}</strong></span>
                {activeTarget.event?.crop_url && (
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                    📷 Plate Snapshot:
                    <img
                      src={activeTarget.event.crop_url}
                      alt="Crop"
                      style={{ height: "24px", borderRadius: "3px", border: "1px solid #10b981", verticalAlign: "middle", cursor: "pointer" }}
                      onClick={() => setPreviewCrop(activeTarget.event.crop_url)}
                    />
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              className="intercept-ack-btn"
              onClick={handleClearTarget}
            >
              Dismiss Alert
            </button>
          </div>
        ) : (
          /* NOT SEEN YET BANNER */
          <div className="anpr-target-hunt-bar">
            <div className="hunt-left">
              <div className="hunt-badge">
                <Crosshair size={13} />
                <span>SEARCH TARGET ACTIVE</span>
              </div>
              <div className="hunt-plate">
                <span className="hunt-ind">IND</span>
                <strong>{activeTarget.plate}</strong>
              </div>
              <div className="hunt-status status-hunting">
                <span className="pulsar-dot"></span>
                <span>Status: <strong>Not seen yet</strong> &bull; Actively scanning video stream...</span>
              </div>
            </div>
            <button
              type="button"
              className="clear-target-btn"
              onClick={handleClearTarget}
            >
              <X size={13} />
              <span>Cancel Search</span>
            </button>
          </div>
        )
      )}

      {/* 4. MAIN WORKSPACE: LEFT LIVE STREAM + RIGHT DETECTION LOGS */}
      <div className="anpr-main-grid">
        {/* LEFT: LIVE MJPEG STREAM */}
        <div className="anpr-video-card">
          <div className="video-card-header">
            <div className="cam-title-info">
              <Camera size={16} className="cam-icon" />
              <div>
                <strong>{activeSource?.name || "Active Source"}</strong>
                <span className="cam-loc-tag">{activeSource?.location || "Gujarat Surveillance"}</span>
              </div>
            </div>

            <div className="stream-badge-group">
              <span className={`live-feed-pill ${isRunning ? "status-online" : "status-offline"}`}>
                <span className="live-dot"></span>
                {isRunning ? "LIVE AI INFERENCE" : "STREAM PAUSED"}
              </span>
              {isRunning && <span className="fps-counter">{fps} FPS</span>}
            </div>
          </div>

          <div className="video-screen-wrapper">
            {isRunning ? (
              <img
                src={streamUrl}
                alt="Live ANPR Stream"
                className="anpr-video-element"
                style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
                onError={() => {
                  console.warn("MJPEG stream reconnecting...");
                }}
              />
            ) : (
              <div className="stream-offline-overlay">
                <Camera size={44} className="offline-cam-icon" />
                <p>AI STREAM PAUSED</p>
                <span>Select source and click &quot;Start Stream&quot; to begin real-time vehicle and plate tracking</span>
                <button
                  type="button"
                  className="anpr-action-btn btn-scan"
                  style={{ marginTop: "14px" }}
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
                  <Crosshair size={12} />
                  <span>FINDING: {activeTarget.plate}</span>
                </div>
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

          {/* SEARCH & FILTER BAR */}
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

            <div className="filter-pill-group">
              <button
                type="button"
                className={`filter-pill ${statusFilter === "ALL" ? "active" : ""}`}
                onClick={() => setStatusFilter("ALL")}
              >
                All
              </button>
              <button
                type="button"
                className={`filter-pill ${statusFilter === "CATCHED" ? "active" : ""}`}
                onClick={() => setStatusFilter("CATCHED")}
              >
                Catched
              </button>
              <button
                type="button"
                className={`filter-pill ${statusFilter === "NORMAL" ? "active" : ""}`}
                onClick={() => setStatusFilter("NORMAL")}
              >
                Normal
              </button>
            </div>
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
                      <p style={{ margin: 0, fontWeight: 600 }}>No live detections recorded yet.</p>
                      <span style={{ fontSize: "11px", color: "#64748b" }}>
                        Start the stream to detect passing vehicles in real-time.
                      </span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 5. CROP PREVIEW MODAL */}
      {previewCrop && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            background: "rgba(0, 0, 0, 0.8)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999
          }}
          onClick={() => setPreviewCrop(null)}
        >
          <div
            style={{
              background: "#0f172a",
              padding: "20px",
              borderRadius: "12px",
              border: "1px solid #334155",
              maxWidth: "500px",
              textAlign: "center"
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
              <h4 style={{ margin: 0, color: "#f8fafc" }}>Captured Plate Snapshot</h4>
              <button
                type="button"
                onClick={() => setPreviewCrop(null)}
                style={{ background: "transparent", border: "none", color: "#94a3b8", cursor: "pointer" }}
              >
                <X size={18} />
              </button>
            </div>
            <img
              src={previewCrop}
              alt="Plate Crop"
              style={{ width: "100%", maxHeight: "300px", objectFit: "contain", borderRadius: "8px", border: "2px solid #0284c7" }}
            />
            <p style={{ margin: "12px 0 0", fontSize: "12px", color: "#94a3b8" }}>
              High-resolution optical crop verified by YOLOv8-plate and EasyOCR.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

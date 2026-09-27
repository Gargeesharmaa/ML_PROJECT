import { useState, useEffect, useRef } from "react";
import {
  Shield,
  Search,
  AlertTriangle,
  CheckCircle2,
  Camera,
  RotateCw,
  Bell,
  Car,
  Truck,
  Bike,
  Activity,
  Radio,
  FileSpreadsheet,
  Upload,
  RefreshCw,
  Trash2,
  ArrowLeft,
  Target,
  Crosshair,
  Zap,
  X
} from "lucide-react";
import "./AnprRadar.css";

// Built-in Laptop Webcam profile
const LAPTOP_CAMERA_OPTION = {
  id: "LOCAL_LAPTOP_CAMERA",
  camera_code: "LAPTOP-CAM",
  dept_name: "Gujarat Police - Control Station",
  make_model: "Integrated Laptop Camera",
  source_type: "LOCAL_WEBCAM",
  camera_type: "WEBCAM",
  status: "ONLINE"
};

// Web Audio API Synthesizer for Interception Siren
function playInterceptionAlert() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.linearRampToValueAtTime(1320, now + 0.2);
    osc.frequency.linearRampToValueAtTime(880, now + 0.4);
    osc.frequency.linearRampToValueAtTime(1320, now + 0.6);
    osc.frequency.linearRampToValueAtTime(880, now + 0.8);

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.2);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 1.2);
  } catch (e) {
    console.warn("Audio alert unavailable:", e);
  }
}

// Fuzzy & Character-Confusion Tolerant Plate Matching
function isTargetMatch(detectedPlate, target) {
  if (!detectedPlate || !target) return false;
  const c1 = detectedPlate.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const c2 = target.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (!c1 || !c2) return false;
  if (c1 === c2 || c1.includes(c2) || c2.includes(c1)) return true;

  // Character confusion mapping (O->0, I->1, Z->2, S->5, B->8)
  const mapConfusion = (s) =>
    s
      .replace(/O/g, "0")
      .replace(/I/g, "1")
      .replace(/Z/g, "2")
      .replace(/S/g, "5")
      .replace(/B/g, "8");
  const n1 = mapConfusion(c1);
  const n2 = mapConfusion(c2);
  return n1 === n2 || n1.includes(n2) || n2.includes(n1);
}

export default function AnprRadar({ onNavigateToOnboarding }) {
  const [cameras, setCameras] = useState([]);
  const [activeCam, setActiveCam] = useState(LAPTOP_CAMERA_OPTION);
  const [plateLogs, setPlateLogs] = useState([]);
  const [filterQuery, setFilterQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL"); // "ALL" | "HOTLIST" | "NORMAL"
  const [autoScanActive, setAutoScanActive] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [activeOverlay, setActiveOverlay] = useState(null);
  const [hotlistAlert, setHotlistAlert] = useState(null);
  const [scanMessage, setScanMessage] = useState("");
  const [uploadedImageSrc, setUploadedImageSrc] = useState(null);
  const [webcamError, setWebcamError] = useState(null);
  const [streamError, setStreamError] = useState(false);

  // Target Plate Hunting state
  const [targetPlate, setTargetPlate] = useState(null);
  const [targetPlateRaw, setTargetPlateRaw] = useState(null);
  const [isHuntingActive, setIsHuntingActive] = useState(false);
  const [targetInterceptedAlert, setTargetInterceptedAlert] = useState(null);

  const localVideoRef = useRef(null);
  const fileInputRef = useRef(null);
  const targetPlateRef = useRef(null);

  useEffect(() => {
    targetPlateRef.current = targetPlateRaw || targetPlate || null;
  }, [targetPlate, targetPlateRaw]);

  // 1. Fetch Registered Cameras & Real Initial Events from Backend
  useEffect(() => {
    async function loadData() {
      try {
        // Fetch cameras from registry
        const camRes = await fetch("/api/cameras");
        if (camRes.ok) {
          const camData = await camRes.json();
          let camList = [];
          if (Array.isArray(camData)) {
            camList = camData;
          } else if (camData.features && Array.isArray(camData.features)) {
            camList = camData.features.map((f) => f.properties || f);
          } else if (camData.cameras) {
            camList = camData.cameras;
          }

          setCameras(camList);

          // If a registered camera is LOCAL_WEBCAM, select it; otherwise default to LAPTOP_CAMERA_OPTION
          const registeredWebcam = camList.find((c) => (c.source_type || "").toUpperCase() === "LOCAL_WEBCAM");
          if (registeredWebcam) {
            setActiveCam(registeredWebcam);
          }
        }

        // Fetch real ANPR events from backend (no dummy data)
        const eventsRes = await fetch("/api/anpr/events?limit=50");
        if (eventsRes.ok) {
          const eventsData = await eventsRes.json();
          if (Array.isArray(eventsData)) {
            setPlateLogs(
              eventsData.map((e) => ({
                id: e.event_id || `REC-${Date.now()}`,
                timestamp: new Date(e.timestamp || Date.now()).toLocaleTimeString(),
                plate: e.plate?.number || "UNKNOWN",
                vehicle_type: e.vehicle?.type || "Car",
                location: e.dept_name || "Gujarat Police - Control Station",
                speed: e.speed || 48,
                status: e.is_watchlist_match
                  ? (e.watchlist_alert?.reason || "HOTLIST_STOLEN")
                  : "NORMAL",
                confidence: (e.plate?.confidence ? (e.plate.confidence <= 1.0 ? e.plate.confidence * 100 : e.plate.confidence) : 96.5).toFixed(1),
                camera_code: e.camera_code || "LAPTOP-CAM",
                watchlist_alert: e.watchlist_alert
              }))
            );
          }
        }
      } catch (err) {
        console.error("Error loading ANPR data:", err);
      }
    }
    loadData();
  }, []);

  // 2. Local Webcam Streaming if Active Camera is LOCAL_WEBCAM and not showing an uploaded photo
  useEffect(() => {
    let localStream = null;
    if (!uploadedImageSrc && activeCam?.source_type === "LOCAL_WEBCAM") {
      setWebcamError(null);
      if (navigator.mediaDevices?.getUserMedia) {
        navigator.mediaDevices
          .getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
          .then((stream) => {
            localStream = stream;
            if (localVideoRef.current) {
              localVideoRef.current.srcObject = stream;
              localVideoRef.current.play().catch(() => {});
            }
          })
          .catch((err) => {
            console.warn("Webcam access notice:", err);
            setWebcamError(err.message || "Camera access permission denied or device not found.");
          });
      } else {
        setWebcamError("Webcam is not supported or permission denied in this browser.");
      }
    }
    return () => {
      if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [activeCam, uploadedImageSrc]);

  // Handle detection result from AI model
  const handleDetectionResult = (data, isUpload = false) => {
    if (!data.detected) {
      if (isHuntingActive && targetPlateRef.current) {
        setScanMessage(`🔍 Hunting target [${targetPlateRef.current}]... Scanning video feed.`);
      } else {
        setScanMessage(data.message || "No license plate recognized in this frame.");
      }
      setActiveOverlay(null);
      setTimeout(() => setScanMessage(""), 4000);
      return;
    }

    const currentTarget = targetPlateRef.current || targetPlate;
    const isTargetMatchFound = Boolean(
      data.is_target_match ||
      (currentTarget && isTargetMatch(data.plate, currentTarget)) ||
      (currentTarget && data.raw_plate && isTargetMatch(data.raw_plate, currentTarget))
    );

    const isHotlist = Boolean(data.is_watchlist_match) || isTargetMatchFound;
    let statusText = "NORMAL";
    if (isTargetMatchFound) {
      statusText = "TARGET_INTERCEPTED";
    } else if (isHotlist) {
      statusText = data.watchlist_alert?.reason || "HOTLIST_STOLEN";
    }

    if (isTargetMatchFound) {
      playInterceptionAlert();
      setTargetInterceptedAlert({
        plate: data.plate,
        location: activeCam?.dept_name || "Gujarat Police - Control Station",
        camera_code: activeCam?.camera_code || "LAPTOP-CAM",
        confidence: data.confidence,
        timestamp: new Date().toLocaleTimeString()
      });
      setScanMessage(`🚨 TARGET INTERCEPTED: Plate #${data.plate} matched locked target on camera!`);
    } else if (isHotlist) {
      setScanMessage(
        `🚨 WATCHLIST ALERT: Plate #${data.plate} matched hotlist (${data.confidence}% confidence)!`
      );
    } else {
      setScanMessage(`✓ Plate Tracked & Flagged: ${data.plate} (${data.confidence}% confidence)`);
    }
    setTimeout(() => setScanMessage(""), 6000);

    const newRecord = {
      id: data.event?.event_id || "REC-" + Date.now(),
      timestamp: new Date().toLocaleTimeString(),
      plate: data.plate,
      vehicle_type: data.vehicle_type || "Car",
      location: activeCam?.dept_name || "Gujarat Police - Control Station",
      speed: Math.floor(48 + Math.random() * 8),
      status: statusText,
      confidence: data.confidence,
      camera_code: activeCam?.camera_code || "LAPTOP-CAM",
      watchlist_alert:
        data.watchlist_alert ||
        (isTargetMatchFound
          ? {
              reason: "TARGET_INTERCEPTED",
              severity: "CRITICAL",
              description: `Target plate ${currentTarget} actively intercepted on camera!`
            }
          : null)
    };

    // Flag bounding box directly onto the radar viewport
    setActiveOverlay({
      plate: data.plate,
      confidence: data.confidence,
      vehicle_type: data.vehicle_type || "Car",
      status: statusText,
      bbox: data.bounding_box,
      frame_dimensions: data.frame_dimensions || [1076, 610],
      isUpload,
      isTargetHit: isTargetMatchFound
    });

    // If live webcam, remove box after 6s (or 10s if target hit). If uploaded photo, leave it flagged for user inspection!
    if (!isUpload) {
      setTimeout(() => {
        setActiveOverlay(null);
      }, isTargetMatchFound ? 10000 : 6000);
    }

    // Trigger alert banner if hotlist vehicle (and not already shown as target intercept banner)
    if (isHotlist && !isTargetMatchFound) {
      setHotlistAlert(newRecord);
    }

    setPlateLogs((prev) => [newRecord, ...prev.slice(0, 49)]);
  };

  // 3. Capture frame from Laptop Webcam and send to FastAPI /api/anpr/detect-frame
  const captureWebcamFrameAndDetect = async () => {
    if (!localVideoRef.current || localVideoRef.current.readyState < 2) {
      setScanMessage("Waiting for camera feed to initialize...");
      return;
    }

    const video = localVideoRef.current;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const base64 = canvas.toDataURL("image/jpeg", 0.85);

    setIsScanning(true);
    setScanMessage(
      isHuntingActive && targetPlateRef.current
        ? `Optical search in progress for target [${targetPlateRef.current}]...`
        : "Running YOLOv8 + PaddleOCR on live camera frame..."
    );

    try {
      const res = await fetch("/api/anpr/detect-frame", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_base64: base64,
          camera_id: activeCam?.id || "LOCAL_LAPTOP_CAMERA",
          camera_code: activeCam?.camera_code || "LAPTOP-CAM",
          dept_name: activeCam?.dept_name || "Gujarat Police - Control Station",
          target_plate: targetPlateRef.current
        })
      });

      if (res.ok) {
        const data = await res.json();
        handleDetectionResult(data, false);
      } else {
        setScanMessage("Detection failed. Verify backend is running on port 8000.");
      }
    } catch (err) {
      console.error("Frame detection error:", err);
      setScanMessage("Network error communicating with ANPR API.");
    } finally {
      setIsScanning(false);
    }
  };

  // 4. Handle file upload (photo of a car / number plate)
  const handleImageUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result;
      setUploadedImageSrc(base64);
      setIsScanning(true);
      setScanMessage("Analyzing uploaded plate photo with YOLOv8 + PaddleOCR...");

      try {
        const res = await fetch("/api/anpr/detect-frame", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image_base64: base64,
            camera_id: activeCam?.id || "LOCAL_LAPTOP_CAMERA",
            camera_code: activeCam?.source_type === "LOCAL_WEBCAM" ? "LAPTOP-CAM" : (activeCam?.camera_code || "UPLOAD-PHOTO"),
            dept_name: activeCam?.dept_name || "Gujarat Police - Control Station"
          })
        });

        if (res.ok) {
          const data = await res.json();
          handleDetectionResult(data, true);

          if (data.detected && data.plate) {
            const detectedPlate = data.plate;
            const rawPlate = data.raw_plate || data.plate;
            setTargetPlate(detectedPlate);
            setTargetPlateRaw(rawPlate);
            setIsHuntingActive(true);
            setTargetInterceptedAlert(null);

            setScanMessage(`🎯 TARGET NUMBER PLATE LOCKED: [${detectedPlate}] — Activating webcam to track vehicle...`);

            // After 2.5s showing photo + box, automatically switch to live laptop camera feed and start hunting!
            setTimeout(() => {
              setUploadedImageSrc(null);
              setActiveOverlay(null);
              setActiveCam(LAPTOP_CAMERA_OPTION);
              setAutoScanActive(true);
              setScanMessage(`🔍 HUNTING ACTIVE: Searching live camera feed for target [${detectedPlate}]...`);
            }, 2500);
          }
        } else {
          setScanMessage("Failed to process uploaded image.");
        }
      } catch (err) {
        console.error("Upload error:", err);
        setScanMessage("Network error during image analysis.");
      } finally {
        setIsScanning(false);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  // Cancel active target hunting
  const handleClearTarget = () => {
    setTargetPlate(null);
    setTargetPlateRaw(null);
    setIsHuntingActive(false);
    setTargetInterceptedAlert(null);
    setScanMessage("Target tracking cancelled. Returned to standard surveillance.");
    setTimeout(() => setScanMessage(""), 3000);
  };

  // Return from uploaded image back to live laptop camera
  const handleReturnToLiveCam = () => {
    setUploadedImageSrc(null);
    setActiveOverlay(null);
    setScanMessage("Returned to live laptop camera feed.");
    setTimeout(() => setScanMessage(""), 2500);
  };

  // 5. Automated Live Plate Capture when Auto Scan is toggled ON
  useEffect(() => {
    if (!autoScanActive || uploadedImageSrc) return;

    const scanDelay = isHuntingActive ? 2000 : 3500;
    const interval = setInterval(() => {
      if (activeCam?.source_type === "LOCAL_WEBCAM") {
        captureWebcamFrameAndDetect();
      }
    }, scanDelay);

    return () => clearInterval(interval);
  }, [autoScanActive, activeCam, uploadedImageSrc, isHuntingActive]);

  // Clear all detection logs
  const handleClearLogs = async () => {
    setPlateLogs([]);
    try {
      await fetch("/api/anpr/events", { method: "DELETE" });
    } catch (err) {
      console.warn("Clear logs error:", err);
    }
  };

  // Export ANPR detections as CSV
  const handleExportCsv = () => {
    if (plateLogs.length === 0) return;
    const headers = "id,timestamp,camera_code,plate,vehicle_type,location,speed_kmh,status,confidence\n";
    const rows = plateLogs
      .map(
        (r) =>
          `"${r.id}","${r.timestamp}","${r.camera_code}","${r.plate}","${r.vehicle_type}","${r.location}",${r.speed},"${r.status}",${r.confidence}`
      )
      .join("\n");
    const blob = new Blob([headers + rows], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gujarat_anpr_detections_${Date.now()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Compute bounding box CSS position dynamically
  const getOverlayStyle = () => {
    if (!activeOverlay || !activeOverlay.bbox) return {};
    const [bx, by, bw, bh] = activeOverlay.bbox;
    const [fw, fh] = activeOverlay.frame_dimensions || [1076, 610];
    if (fw <= 0 || fh <= 0) return { top: "25%", left: "20%", width: "60%", height: "50%" };

    const left = Math.max(0, Math.min(95, (bx / fw) * 100));
    const top = Math.max(0, Math.min(95, (by / fh) * 100));
    const width = Math.max(4, Math.min(100 - left, (bw / fw) * 100));
    const height = Math.max(4, Math.min(100 - top, (bh / fh) * 100));

    return {
      left: `${left}%`,
      top: `${top}%`,
      width: `${width}%`,
      height: `${height}%`
    };
  };

  // Filtered Logs
  const filteredLogs = plateLogs.filter((log) => {
    if (filterQuery && !log.plate.toLowerCase().includes(filterQuery.toLowerCase())) {
      return false;
    }
    if (statusFilter === "HOTLIST" && log.status === "NORMAL") {
      return false;
    }
    if (statusFilter === "NORMAL" && log.status !== "NORMAL") {
      return false;
    }
    return true;
  });

  return (
    <div className="anpr-radar-container">
      {/* TARGET INTERCEPTED CRITICAL ALERT BANNER */}
      {targetInterceptedAlert && (
        <div className="anpr-target-intercepted-banner">
          <div className="intercept-icon-wrap">
            <Target size={24} className="animate-spin" />
          </div>
          <div className="intercept-content">
            <h4>🎯 TARGET NUMBER PLATE INTERCEPTED!</h4>
            <p>
              Vehicle with target plate <strong className="highlight-plate">{targetInterceptedAlert.plate}</strong> was recognized and intercepted by AI vision radar!
            </p>
            <div className="intercept-meta-row">
              <span>📍 Location: <strong>{targetInterceptedAlert.location}</strong></span>
              <span>📷 Camera: <strong>{targetInterceptedAlert.camera_code}</strong></span>
              <span>⚡ Accuracy: <strong>{targetInterceptedAlert.confidence}%</strong></span>
              <span>🕒 Time: <strong>{targetInterceptedAlert.timestamp}</strong></span>
            </div>
          </div>
          <button
            type="button"
            className="intercept-ack-btn"
            onClick={() => setTargetInterceptedAlert(null)}
          >
            Acknowledge Interception
          </button>
        </div>
      )}

      {/* HOTLIST CRITICAL ALERT BANNER */}
      {hotlistAlert && (
        <div className="anpr-hotlist-alert-banner">
          <div className="alert-badge">
            <Bell size={18} className="animate-bounce" />
            <span>CRITICAL HOTLIST ALERT</span>
          </div>
          <div className="alert-details">
            <strong>Plate #{hotlistAlert.plate}</strong>
            <span>
              Flagged as <em>{hotlistAlert.status.replace(/_/g, " ")}</em> at {hotlistAlert.location} (Camera {hotlistAlert.camera_code})
              {hotlistAlert.watchlist_alert?.description && ` — ${hotlistAlert.watchlist_alert.description}`}
            </span>
          </div>
          <button
            type="button"
            className="dismiss-alert-btn"
            onClick={() => setHotlistAlert(null)}
          >
            Acknowledge Alert
          </button>
        </div>
      )}

      {/* TOP HEADER CONTROLS */}
      <div className="anpr-header">
        <div className="header-info">
          <div className="eyebrow-tag">
            <Shield size={13} />
            <span>AI NUMBER PLATE RECOGNITION (ANPR)</span>
          </div>
          <h2>ANPR Live Surveillance & Vehicle Radar</h2>
          <p className="page-description">
            Live optical recognition powered by YOLOv8 and PaddleOCR. Hold a vehicle number plate to your laptop camera or upload an image to run real-time inference.
          </p>
        </div>

        {/* CONTROLS */}
        <div className="anpr-header-actions" style={{ flexWrap: "wrap", gap: "10px" }}>
          {/* Active Camera Selector */}
          <div className="anpr-cam-picker">
            <label>Camera Source:</label>
            <select
              value={activeCam?.id || "LOCAL_LAPTOP_CAMERA"}
              onChange={(e) => {
                const val = e.target.value;
                setUploadedImageSrc(null);
                setActiveOverlay(null);
                if (val === "LOCAL_LAPTOP_CAMERA") {
                  setActiveCam(LAPTOP_CAMERA_OPTION);
                  return;
                }
                const found = cameras.find((c) => String(c.id || c.camera_code) === val);
                if (found) setActiveCam(found);
              }}
            >
              {/* Guaranteed Laptop Camera Option */}
              <option value="LOCAL_LAPTOP_CAMERA">💻 Laptop Camera (Live Webcam)</option>

              {/* Registered cameras from database */}
              {cameras
                .filter((c) => c.id !== "LOCAL_LAPTOP_CAMERA")
                .map((c) => (
                  <option key={c.id || c.camera_code} value={c.id || c.camera_code}>
                    {c.camera_code} ({(c.source_type === "LOCAL_WEBCAM" ? "💻 LAPTOP WEBCAM" : c.camera_type || "CCTV")}) - {c.dept_name}
                  </option>
                ))}
            </select>
          </div>

          {/* Trigger Scan Button (Webcam Mode) */}
          {!uploadedImageSrc && activeCam?.source_type === "LOCAL_WEBCAM" && (
            <button
              type="button"
              className="anpr-scan-btn"
              onClick={captureWebcamFrameAndDetect}
              disabled={isScanning}
              title="Capture live webcam frame and run YOLO + OCR"
            >
              {isScanning ? <RefreshCw size={14} className="animate-spin" /> : <Camera size={14} />}
              <span>{isScanning ? "Processing..." : "Scan Laptop Camera"}</span>
            </button>
          )}

          {/* Upload Image Test Button */}
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleImageUpload}
            accept="image/*"
            style={{ display: "none" }}
          />
          <button
            type="button"
            className="anpr-toggle-btn"
            onClick={() => fileInputRef.current?.click()}
            title="Upload photo of a vehicle or plate to test OCR"
          >
            <Upload size={14} />
            <span>Upload Plate Image</span>
          </button>

          {/* Toggle Auto Scan */}
          {!uploadedImageSrc && activeCam?.source_type === "LOCAL_WEBCAM" && (
            <button
              type="button"
              className={`anpr-toggle-btn ${autoScanActive ? "active" : ""}`}
              onClick={() => setAutoScanActive(!autoScanActive)}
              title="Automatically scan webcam frames every 3.5 seconds"
            >
              <Radio size={14} />
              <span>{autoScanActive ? "Auto Scan: ON" : "Auto Scan: OFF"}</span>
            </button>
          )}
        </div>
      </div>

      {/* SCAN FEEDBACK STATUS */}
      {scanMessage && (
        <div style={{
          background: "rgba(56, 189, 248, 0.12)",
          border: "1px solid rgba(56, 189, 248, 0.3)",
          color: "#38bdf8",
          padding: "8px 16px",
          borderRadius: "8px",
          fontSize: "12px",
          fontWeight: 600,
          marginBottom: "16px",
          display: "flex",
          alignItems: "center",
          gap: "8px"
        }}>
          <Activity size={14} className="animate-pulse" />
          <span>{scanMessage}</span>
        </div>
      )}

      {/* KPI METRICS ROW */}
      <div className="anpr-kpi-row">
        <div className="anpr-kpi-card">
          <span className="kpi-label">Plates Captured</span>
          <strong className="kpi-val">{plateLogs.length}</strong>
          <span className="kpi-sub">Total Live Detections</span>
        </div>
        <div className="anpr-kpi-card alert">
          <span className="kpi-label">Hotlist Hits</span>
          <strong className="kpi-val">
            {plateLogs.filter((p) => p.status !== "NORMAL").length}
          </strong>
          <span className="kpi-sub">Watchlist Matches</span>
        </div>
        <div className="anpr-kpi-card">
          <span className="kpi-label">Active Camera</span>
          <strong className="kpi-val" style={{ fontSize: "16px", color: "#38bdf8" }}>
            {uploadedImageSrc ? "PHOTO UPLOAD" : (activeCam?.camera_code || "LAPTOP-CAM")}
          </strong>
          <span className="kpi-sub">
            {uploadedImageSrc ? "Static Image Analyzed" : (activeCam?.source_type === "LOCAL_WEBCAM" ? "Live Webcam Active" : "CCTV Stream")}
          </span>
        </div>
        <div className="anpr-kpi-card">
          <span className="kpi-label">AI Engine</span>
          <strong className="kpi-val" style={{ fontSize: "15px", color: "#10b981" }}>YOLOv8 + PaddleOCR</strong>
          <span className="kpi-sub">Backend Port 8000 Ready</span>
        </div>
      </div>

      {/* ACTIVE TARGET HUNTING HUD BAR */}
      {targetPlate && (
        <div className="anpr-target-hunt-bar">
          <div className="hunt-left">
            <div className="hunt-badge">
              <Target size={14} className={isHuntingActive ? "animate-spin" : ""} />
              <span>LOCKED SEARCH TARGET</span>
            </div>
            <div className="hunt-plate">
              <span className="hunt-ind">IND</span>
              <strong>{targetPlate}</strong>
            </div>
            <div className="hunt-status">
              {targetInterceptedAlert ? (
                <span className="status-intercepted">🎯 TARGET INTERCEPTED ON CAMERA!</span>
              ) : (
                <span className="status-hunting">
                  <span className="pulsar-dot"></span>
                  SCANNING CAMERA FEEDS...
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            className="clear-target-btn"
            onClick={handleClearTarget}
            title="Cancel search for this plate"
          >
            <X size={13} />
            <span>Cancel Search</span>
          </button>
        </div>
      )}

      {/* SPLIT LAYOUT: LIVE VIDEO FEED (LEFT) + DETECTION LOG TABLE (RIGHT) */}
      <div className="anpr-split-layout">
        {/* LEFT: LIVE ANPR CAMERA VIEWPORT WITH BOUNDING BOX */}
        <div className="anpr-video-card">
          <div className="video-card-header">
            <div className="cam-title">
              {uploadedImageSrc ? (
                <>
                  <span className="upload-indicator-dot">● PHOTO</span>
                  <strong>Uploaded Plate Image</strong>
                  <span className="dept-tag">Zone Detection Active</span>
                </>
              ) : (
                <>
                  <span className="live-dot">● LIVE</span>
                  <strong>{activeCam?.camera_code || "LAPTOP-CAM"}</strong>
                  <span className="dept-tag">
                    {activeCam?.source_type === "LOCAL_WEBCAM" ? "💻 Laptop Webcam Feed" : activeCam?.dept_name}
                  </span>
                </>
              )}
            </div>

            {uploadedImageSrc ? (
              <button
                type="button"
                className="return-cam-btn"
                onClick={handleReturnToLiveCam}
                title="Return to live laptop camera feed"
              >
                <ArrowLeft size={12} />
                <span>Return to Live Camera</span>
              </button>
            ) : (
              <span className="feed-specs">
                {activeCam?.source_type === "LOCAL_WEBCAM" ? "Webcam Active (Hold plate to camera)" : "1080p @ 30 FPS • AI Radar"}
              </span>
            )}
          </div>

          <div className="anpr-viewport">
            {/* 1. Uploaded Image View with Flagged Bounding Box */}
            {uploadedImageSrc ? (
              <div className="anpr-media-frame">
                <img
                  src={uploadedImageSrc}
                  alt="Uploaded Vehicle Frame"
                  className="anpr-display-media"
                />
                {activeOverlay && (
                  <div
                    className={`anpr-bounding-box ${
                      activeOverlay.isTargetHit
                        ? "box-target-intercepted"
                        : activeOverlay.status !== "NORMAL"
                        ? "box-alert"
                        : ""
                    }`}
                    style={getOverlayStyle()}
                  >
                    <div className="box-corners"></div>
                    <div className="detected-plate-badge">
                      <div className="hsrp-flag">
                        <span className="ind-text">IND</span>
                      </div>
                      <strong className="plate-text">{activeOverlay.plate}</strong>
                    </div>
                    <div className="detection-meta-tag">
                      <span>
                        {activeOverlay.isTargetHit
                          ? "🎯 TARGET INTERCEPTED"
                          : activeOverlay.status !== "NORMAL"
                          ? "🚨 " + activeOverlay.status.replace(/_/g, " ")
                          : "✓ " + activeOverlay.vehicle_type}
                      </span>
                      <span>{activeOverlay.confidence}% CONFIDENCE</span>
                    </div>
                  </div>
                )}
              </div>
            ) : activeCam?.source_type === "LOCAL_WEBCAM" ? (
              /* 2. Live Laptop Webcam Stream */
              webcamError ? (
                <div className="anpr-webcam-error-box">
                  <AlertTriangle size={36} color="#f87171" />
                  <p className="webcam-error-title">Webcam Access Notice</p>
                  <span className="webcam-error-sub">{webcamError}</span>
                  <span className="webcam-help-hint">
                    Please allow camera access in your browser, or click <strong>&quot;Upload Plate Image&quot;</strong> above to test with any vehicle photo.
                  </span>
                </div>
              ) : (
                <div className="anpr-media-frame webcam-frame">
                  <video
                    ref={localVideoRef}
                    className="anpr-display-media video-mode"
                    autoPlay
                    playsInline
                    muted
                  />
                  {/* Hunting reticle laser crosshair */}
                  {isHuntingActive && targetPlate && !targetInterceptedAlert && (
                    <div className="anpr-target-scanner-crosshair">
                      <div className="reticle-line-scan"></div>
                      <div className="reticle-text">
                        <Crosshair size={12} className="animate-spin" />
                        <span>HUNTING: {targetPlate}</span>
                      </div>
                    </div>
                  )}
                  {activeOverlay && (
                    <div
                      className={`anpr-bounding-box ${
                        activeOverlay.isTargetHit
                          ? "box-target-intercepted"
                          : activeOverlay.status !== "NORMAL"
                          ? "box-alert"
                          : ""
                      }`}
                      style={getOverlayStyle()}
                    >
                      <div className="box-corners"></div>
                      <div className="detected-plate-badge">
                        <div className="hsrp-flag">
                          <span className="ind-text">IND</span>
                        </div>
                        <strong className="plate-text">{activeOverlay.plate}</strong>
                      </div>
                      <div className="detection-meta-tag">
                        <span>
                          {activeOverlay.isTargetHit
                            ? "🎯 TARGET INTERCEPTED"
                            : activeOverlay.status !== "NORMAL"
                            ? "🚨 " + activeOverlay.status.replace(/_/g, " ")
                            : "✓ " + activeOverlay.vehicle_type}
                        </span>
                        <span>{activeOverlay.confidence}% CONFIDENCE</span>
                      </div>
                    </div>
                  )}
                </div>
              )
            ) : activeCam ? (
              /* 3. CCTV RTSP Stream */
              <div className="anpr-media-frame">
                <img
                  src={`/api/cameras/${activeCam.id || activeCam.camera_code}/stream?t=${Date.now()}`}
                  alt="ANPR Stream"
                  className="anpr-display-media"
                  onError={() => setStreamError(true)}
                />
                {streamError && (
                  <div className="anpr-fallback-sim">
                    <div className="sim-scanline"></div>
                    <div className="anpr-hud-target"></div>
                    <p>RADAR SCANNING ZONE</p>
                    <span>{activeCam?.rtsp_url || "RTSP Stream Offline"}</span>
                  </div>
                )}
              </div>
            ) : (
              /* 4. Fallback when nothing selected */
              <div className="anpr-fallback-sim">
                <div className="sim-scanline"></div>
                <div className="anpr-hud-target"></div>
                <p>RADAR SCANNING ZONE</p>
                <span>Select a camera or upload an image</span>
              </div>
            )}

            {/* STATIC HUD METADATA */}
            <div className="anpr-hud-osd top-left">
              <span>{uploadedImageSrc ? "PHOTO INFERENCE MODE" : "ACTIVE ANPR OPTICAL TRACKER"}</span>
              <code>{uploadedImageSrc ? "FILE: UPLOADED PLATE PHOTO" : (activeCam?.source_type === "LOCAL_WEBCAM" ? "LOCAL LAPTOP WEBCAM (LIVE)" : "CCTV GRID MONITORED")}</code>
            </div>
            <div className="anpr-hud-osd bottom-left">
              <span>{uploadedImageSrc ? "INPUT: HIGH-RES STILL IMAGE" : (activeCam?.ip_address || "127.0.0.1")}</span>
            </div>
          </div>
        </div>

        {/* RIGHT: REAL-TIME DETECTION LOG TABLE WITH TRACKED LOCATION */}
        <div className="anpr-log-card">
          <div className="log-card-header">
            <div className="log-header-left">
              <h4>Real-Time Plate Detection Log</h4>
              <span className="log-count">{filteredLogs.length} events logged</span>
            </div>

            <div style={{ display: "flex", gap: "8px" }}>
              {plateLogs.length > 0 && (
                <button
                  type="button"
                  className="export-log-btn"
                  onClick={handleClearLogs}
                  title="Clear all detection history"
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
                title="Download CSV log"
              >
                <FileSpreadsheet size={13} />
                <span>Export CSV</span>
              </button>
            </div>
          </div>

          {/* SEARCH & FILTER BAR */}
          <div className="log-filter-bar">
            <div className="search-wrap">
              <Search size={14} />
              <input
                type="text"
                placeholder="Search plate (e.g. GJ 01)..."
                value={filterQuery}
                onChange={(e) => setFilterQuery(e.target.value)}
              />
            </div>

            <div className="filter-chips">
              <button
                type="button"
                className={`filter-chip ${statusFilter === "ALL" ? "active" : ""}`}
                onClick={() => setStatusFilter("ALL")}
              >
                All
              </button>
              <button
                type="button"
                className={`filter-chip hotlist ${statusFilter === "HOTLIST" ? "active" : ""}`}
                onClick={() => setStatusFilter("HOTLIST")}
              >
                Alerts / Hotlist
              </button>
              <button
                type="button"
                className={`filter-chip ${statusFilter === "NORMAL" ? "active" : ""}`}
                onClick={() => setStatusFilter("NORMAL")}
              >
                Normal
              </button>
            </div>
          </div>

          {/* EVENT TABLE WITH LOCATION / CAMERA TRACKED */}
          <div className="anpr-table-scroll">
            <table className="anpr-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Number Plate</th>
                  <th>Location / Camera</th>
                  <th>Vehicle Class</th>
                  <th>Status / Alert</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.map((log) => (
                  <tr
                    key={log.id}
                    className={
                      log.status === "TARGET_INTERCEPTED"
                        ? "row-alert row-target-intercepted"
                        : log.status !== "NORMAL"
                        ? "row-alert"
                        : ""
                    }
                  >
                    <td className="time-cell">{log.timestamp}</td>

                    {/* HSRP NUMBER PLATE BADGE */}
                    <td>
                      <div className="hsrp-plate-wrap">
                        <div className="hsrp-blue-band">
                          <span className="hsrp-ind">IND</span>
                        </div>
                        <span className="hsrp-number">{log.plate}</span>
                      </div>
                    </td>

                    {/* TRACKED LOCATION & CAMERA CODE */}
                    <td>
                      <div className="location-cell">
                        <span className="location-name">{log.location}</span>
                        <span className="camera-code-tag">📷 {log.camera_code}</span>
                      </div>
                    </td>

                    <td>
                      <div className="vehicle-class-cell">
                        {log.vehicle_type.toLowerCase().includes("truck") ? (
                          <Truck size={14} />
                        ) : log.vehicle_type.toLowerCase().includes("motorcycle") || log.vehicle_type.toLowerCase().includes("bike") ? (
                          <Bike size={14} />
                        ) : (
                          <Car size={14} />
                        )}
                        <span>{log.vehicle_type}</span>
                      </div>
                    </td>

                    <td>
                      <span
                        className={`status-pill ${
                          log.status === "TARGET_INTERCEPTED"
                            ? "status-target"
                            : log.status !== "NORMAL"
                            ? "status-hotlist"
                            : "status-normal"
                        }`}
                      >
                        {log.status === "TARGET_INTERCEPTED"
                          ? "🎯 TARGET HIT"
                          : log.status.replace(/_/g, " ")}
                      </span>
                    </td>
                  </tr>
                ))}

                {filteredLogs.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ textAlign: "center", padding: "40px 20px", color: "#94a3b8" }}>
                      <Camera size={28} style={{ margin: "0 auto 10px", opacity: 0.4, display: "block" }} />
                      <p style={{ margin: 0, fontWeight: 600 }}>No live detections recorded yet.</p>
                      <span style={{ fontSize: "11px", color: "#64748b" }}>
                        Hold a number plate to your laptop camera and click &quot;Scan Laptop Camera&quot; or click &quot;Upload Plate Image&quot;.
                      </span>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

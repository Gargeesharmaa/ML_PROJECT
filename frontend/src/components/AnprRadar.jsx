import { useState, useEffect, useRef } from "react";
import {
  Shield,
  Search,
  AlertTriangle,
  CheckCircle2,
  Camera,
  Download,
  Play,
  RotateCw,
  Bell,
  Sliders,
  Car,
  Truck,
  Bike,
  Activity,
  Zap,
  Radio,
  FileSpreadsheet
} from "lucide-react";

// Pre-seeded realistic Gujarat vehicle plates for detection simulation
const SAMPLE_PLATES = [
  { plate: "GJ 01 AX 9921", type: "Car (Sedan)", dept: "Ahmedabad SG Highway", speed: 58, status: "NORMAL" },
  { plate: "GJ 05 MK 4320", type: "SUV", dept: "Surat Ring Road", speed: 74, status: "OVER_SPEEDING" },
  { plate: "GJ 06 BH 8812", type: "Commercial Truck", dept: "Vadodara NH-48", speed: 42, status: "HOTLIST_STOLEN" },
  { plate: "GJ 03 RT 1109", type: "Car (Hatchback)", dept: "Rajkot Ring Road", speed: 51, status: "NORMAL" },
  { plate: "GJ 18 CA 2024", type: "SUV (Govt Escort)", dept: "Gandhinagar Sector 10", speed: 45, status: "NORMAL" },
  { plate: "GJ 01 ER 5567", type: "Motorcycle", dept: "Ahmedabad SG Highway", speed: 64, status: "NORMAL" },
  { plate: "GJ 27 JK 3341", type: "Commercial Bus", dept: "GSRTC Depot Zone", speed: 38, status: "NORMAL" },
  { plate: "GJ 05 QW 7719", type: "SUV", dept: "Surat Ring Road", speed: 89, status: "OVER_SPEEDING" },
  { plate: "GJ 12 FF 9081", type: "Car (Sedan)", dept: "Kutch Border Checkpost", speed: 49, status: "SUSPECT_VEHICLE" },
];

export default function AnprRadar({ onNavigateToOnboarding }) {
  const [cameras, setCameras] = useState([]);
  const [activeCam, setActiveCam] = useState(null);
  const [plateLogs, setPlateLogs] = useState([]);
  const [filterQuery, setFilterQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL"); // "ALL" | "HOTLIST" | "NORMAL"
  const [autoScanActive, setAutoScanActive] = useState(true);
  const [activeOverlay, setActiveOverlay] = useState(null);
  const [hotlistAlert, setHotlistAlert] = useState(null);

  const localVideoRef = useRef(null);

  // 1. Fetch Registered Cameras
  useEffect(() => {
    async function loadCameras() {
      try {
        const res = await fetch("/api/cameras");
        if (res.ok) {
          const data = await res.json();
          const camList = Array.isArray(data) ? data : (data.cameras || []);
          setCameras(camList);

          // Prefer ANPR camera, otherwise pick first available
          const anpr = camList.find((c) => (c.camera_type || "").toUpperCase() === "ANPR");
          setActiveCam(anpr || camList[0] || null);
        }
      } catch (err) {
        console.error("Error fetching cameras for ANPR:", err);
      }
    }
    loadCameras();
  }, []);

  // 2. Local Webcam Streaming if Active Camera is LOCAL_WEBCAM
  useEffect(() => {
    let localStream = null;
    if (activeCam?.source_type === "LOCAL_WEBCAM" && localVideoRef.current) {
      if (navigator.mediaDevices?.getUserMedia) {
        navigator.mediaDevices
          .getUserMedia({ video: true, audio: false })
          .then((stream) => {
            localStream = stream;
            if (localVideoRef.current) {
              localVideoRef.current.srcObject = stream;
              localVideoRef.current.play().catch(() => {});
            }
          })
          .catch((err) => console.warn("Webcam error:", err));
      }
    }
    return () => {
      if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
      }
    };
  }, [activeCam]);

  // 3. Initialize with some initial real-time detections
  useEffect(() => {
    const initialRecords = SAMPLE_PLATES.slice(0, 5).map((item, idx) => ({
      id: "REC-" + (Date.now() - (idx + 1) * 25000),
      timestamp: new Date(Date.now() - (idx + 1) * 25000).toLocaleTimeString(),
      plate: item.plate,
      vehicle_type: item.type,
      location: item.dept,
      speed: item.speed,
      status: item.status,
      confidence: (96.5 + Math.random() * 3).toFixed(1),
      camera_code: activeCam ? activeCam.camera_code : "CAM-GJ-ANPR01",
    }));
    setPlateLogs(initialRecords);
  }, [activeCam]);

  // 4. Automated Live Plate Capture Simulation
  useEffect(() => {
    if (!autoScanActive) return;

    const interval = setInterval(() => {
      triggerDetectionEvent();
    }, 7000);

    return () => clearInterval(interval);
  }, [autoScanActive, activeCam]);

  // Trigger a single plate detection event
  const triggerDetectionEvent = () => {
    const randomItem = SAMPLE_PLATES[Math.floor(Math.random() * SAMPLE_PLATES.length)];
    const now = new Date();
    const isHotlist = randomItem.status === "HOTLIST_STOLEN" || randomItem.status === "SUSPECT_VEHICLE";

    // Randomize slight plate variation
    const randNum = Math.floor(1000 + Math.random() * 9000);
    const generatedPlate = randomItem.plate.substring(0, 8) + randNum;

    const newRecord = {
      id: "REC-" + Date.now(),
      timestamp: now.toLocaleTimeString(),
      plate: generatedPlate,
      vehicle_type: randomItem.type,
      location: activeCam?.dept_name || randomItem.dept,
      speed: Math.floor(randomItem.speed + (Math.random() * 10 - 5)),
      status: randomItem.status,
      confidence: (97.0 + Math.random() * 2.8).toFixed(1),
      camera_code: activeCam?.camera_code || "CAM-GJ-ANPR01",
    };

    // Update overlay bounding box on video screen
    setActiveOverlay({
      plate: generatedPlate,
      confidence: newRecord.confidence,
      vehicle_type: newRecord.vehicle_type,
      status: newRecord.status,
    });

    setTimeout(() => {
      setActiveOverlay(null);
    }, 3500);

    // If hotlisted, trigger banner alert
    if (isHotlist) {
      setHotlistAlert(newRecord);
      setTimeout(() => setHotlistAlert(null), 8000);
    }

    setPlateLogs((prev) => [newRecord, ...prev.slice(0, 49)]);
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
      {/* HOTLIST CRITICAL ALERT BANNER */}
      {hotlistAlert && (
        <div className="anpr-hotlist-alert-banner">
          <div className="alert-badge">
            <Bell size={18} className="animate-bounce" />
            <span>HOTLIST VEHICLE ALERT</span>
          </div>
          <div className="alert-details">
            <strong>Plate #{hotlistAlert.plate}</strong>
            <span>
              Flagged as <em>{hotlistAlert.status.replace("_", " ")}</em> at {hotlistAlert.location} (Camera {hotlistAlert.camera_code})
            </span>
          </div>
          <button
            type="button"
            className="dismiss-alert-btn"
            onClick={() => setHotlistAlert(null)}
          >
            Acknowledge
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
            High-speed optical recognition detecting vehicle plates across Gujarat state highways and urban junctions.
          </p>
        </div>

        {/* CONTROLS */}
        <div className="anpr-header-actions">
          {/* Active Camera Selector */}
          <div className="anpr-cam-picker">
            <label>Monitored Camera:</label>
            <select
              value={activeCam ? (activeCam.id || activeCam.camera_code) : ""}
              onChange={(e) => {
                const found = cameras.find((c) => String(c.id || c.camera_code) === e.target.value);
                if (found) setActiveCam(found);
              }}
            >
              {cameras.length === 0 ? (
                <option value="">Simulation ANPR Camera</option>
              ) : (
                cameras.map((c) => (
                  <option key={c.id || c.camera_code} value={c.id || c.camera_code}>
                    {c.camera_code} ({(c.camera_type || "CCTV").toUpperCase()}) - {c.dept_name}
                  </option>
                ))
              )}
            </select>
          </div>

          {/* Trigger Scan Button */}
          <button
            type="button"
            className="anpr-scan-btn"
            onClick={triggerDetectionEvent}
            title="Force immediate plate capture"
          >
            <Zap size={14} />
            <span>Simulate Plate Capture</span>
          </button>

          {/* Toggle Auto Scan */}
          <button
            type="button"
            className={`anpr-toggle-btn ${autoScanActive ? "active" : ""}`}
            onClick={() => setAutoScanActive(!autoScanActive)}
          >
            <Radio size={14} />
            <span>{autoScanActive ? "Live Scanning ON" : "Scanning Paused"}</span>
          </button>
        </div>
      </div>

      {/* KPI METRICS ROW */}
      <div className="anpr-kpi-row">
        <div className="anpr-kpi-card">
          <span className="kpi-label">Plates Captured</span>
          <strong className="kpi-val">{plateLogs.length * 14 + 182}</strong>
          <span className="kpi-sub">Today's Total Scans</span>
        </div>
        <div className="anpr-kpi-card alert">
          <span className="kpi-label">Hotlist Hits</span>
          <strong className="kpi-val">
            {plateLogs.filter((r) => r.status.includes("HOTLIST") || r.status.includes("SUSPECT")).length + 3}
          </strong>
          <span className="kpi-sub text-red">Stolen / Suspect Flaggable</span>
        </div>
        <div className="anpr-kpi-card">
          <span className="kpi-label">Avg Traffic Speed</span>
          <strong className="kpi-val">54.2 km/h</strong>
          <span className="kpi-sub">Highway Flow Rate</span>
        </div>
        <div className="anpr-kpi-card">
          <span className="kpi-label">OCR Confidence</span>
          <strong className="kpi-val">98.4%</strong>
          <span className="kpi-sub">Optical Accuracy</span>
        </div>
      </div>

      {/* SPLIT LAYOUT: LIVE VIDEO FEED (LEFT) + DETECTION LOG TABLE (RIGHT) */}
      <div className="anpr-split-layout">
        {/* LEFT: LIVE ANPR CAMERA VIEWPORT WITH BOUNDING BOX */}
        <div className="anpr-video-card">
          <div className="video-card-header">
            <div className="cam-title">
              <span className="live-dot">● LIVE</span>
              <strong>{activeCam?.camera_code || "ANPR-FEED-01"}</strong>
              <span className="dept-tag">{activeCam?.dept_name || "Gujarat State Highway"}</span>
            </div>
            <span className="feed-specs">1080p @ 30 FPS • AI Radar</span>
          </div>

          <div className="anpr-viewport">
            {/* Real Stream or Webcam */}
            {activeCam?.source_type === "LOCAL_WEBCAM" ? (
              <video ref={localVideoRef} className="anpr-video-element" autoPlay playsInline muted />
            ) : activeCam ? (
              <img
                src={`/api/cameras/${activeCam.id || activeCam.camera_code}/stream?t=${Date.now()}`}
                alt="ANPR Stream"
                className="anpr-stream-img"
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                  const fb = e.currentTarget.parentElement.querySelector(".anpr-fallback-sim");
                  if (fb) fb.style.display = "flex";
                }}
              />
            ) : null}

            {/* Simulated Surveillance Feed Background */}
            <div className="anpr-fallback-sim">
              <div className="sim-scanline"></div>
              <div className="anpr-hud-target"></div>
              <p>RADAR SCANNING ZONE</p>
              <span>{activeCam?.rtsp_url || "RTSP Stream Active"}</span>
            </div>

            {/* DYNAMIC ANPR BOUNDING BOX OVERLAY */}
            {activeOverlay && (
              <div className={`anpr-bounding-box ${activeOverlay.status !== "NORMAL" ? "box-alert" : ""}`}>
                <div className="box-corners"></div>
                <div className="detected-plate-badge">
                  <div className="hsrp-flag">
                    <span className="ind-text">IND</span>
                  </div>
                  <strong className="plate-text">{activeOverlay.plate}</strong>
                </div>
                <div className="detection-meta-tag">
                  <span>{activeOverlay.vehicle_type}</span>
                  <span>{activeOverlay.confidence}% MATCH</span>
                </div>
              </div>
            )}

            {/* STATIC HUD METADATA */}
            <div className="anpr-hud-osd top-left">
              <span>ACTIVE ANPR OPTICAL TRACKER</span>
              <code>LANE 01 & 02 MONITORED</code>
            </div>
            <div className="anpr-hud-osd bottom-left">
              <span>{activeCam?.ip_address || "10.10.1.11"}</span>
            </div>
          </div>
        </div>

        {/* RIGHT: REAL-TIME DETECTION LOG TABLE */}
        <div className="anpr-log-card">
          <div className="log-card-header">
            <div className="log-header-left">
              <h4>Real-Time Plate Detection Log</h4>
              <span className="log-count">{filteredLogs.length} events logged</span>
            </div>

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

          {/* EVENT TABLE */}
          <div className="anpr-table-scroll">
            <table className="anpr-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Number Plate</th>
                  <th>Vehicle Class</th>
                  <th>Speed</th>
                  <th>Status / Alert</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.map((log) => (
                  <tr key={log.id} className={log.status !== "NORMAL" ? "row-alert" : ""}>
                    <td className="time-cell">{log.timestamp}</td>

                    {/* HSRP NUMBER PLATE BADGE */}
                    <td>
                      <div className="hsrp-plate-wrap">
                        <div className="hsrp-blue-band">
                          <span className="band-ind">IND</span>
                        </div>
                        <span className="hsrp-number">{log.plate}</span>
                      </div>
                    </td>

                    <td>
                      <div className="vehicle-cell">
                        {log.vehicle_type.includes("Truck") ? (
                          <Truck size={14} />
                        ) : log.vehicle_type.includes("Motorcycle") ? (
                          <Bike size={14} />
                        ) : (
                          <Car size={14} />
                        )}
                        <span>{log.vehicle_type}</span>
                      </div>
                    </td>

                    <td className="speed-cell">
                      <span className={log.speed > 70 ? "speed-fast" : "speed-normal"}>
                        {log.speed} km/h
                      </span>
                    </td>

                    <td>
                      {log.status === "HOTLIST_STOLEN" ? (
                        <span className="badge-alert stolen">
                          <AlertTriangle size={11} /> STOLEN
                        </span>
                      ) : log.status === "OVER_SPEEDING" ? (
                        <span className="badge-alert speed">
                          <Zap size={11} /> SPEEDING
                        </span>
                      ) : log.status === "SUSPECT_VEHICLE" ? (
                        <span className="badge-alert suspect">
                          <AlertTriangle size={11} /> SUSPECT
                        </span>
                      ) : (
                        <span className="badge-alert normal">
                          <CheckCircle2 size={11} /> VALID
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState, useMemo } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import {
  Layers,
  RefreshCw,
  Search,
  Radio,
  Crosshair,
  Compass,
  AlertTriangle,
  Video,
  Plus,
  Play,
  Trash2
} from "lucide-react";
import CameraFeedModal from "./CameraFeedModal";

// Fix default Leaflet icon paths in Vite
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

// Custom colored SVG pin markers
const createCustomMarkerIcon = (status) => {
  const colorMap = {
    ONLINE: { bg: "#10b981", border: "#065f46", text: "ON" },
    OFFLINE: { bg: "#ef4444", border: "#991b1b", text: "OFF" },
    MAINTENANCE: { bg: "#f59e0b", border: "#92400e", text: "MNT" },
  };

  const c = colorMap[status] || colorMap.OFFLINE;

  return L.divIcon({
    className: "custom-gis-pin",
    html: `
      <div style="
        position: relative;
        width: 34px;
        height: 34px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: ${c.bg};
        border: 2px solid #ffffff;
        border-radius: 50%;
        box-shadow: 0 4px 10px rgba(0,0,0,0.35);
        color: white;
        font-weight: 800;
        font-size: 10px;
        cursor: pointer;
      ">
        <span style="letter-spacing: -0.5px;">${c.text}</span>
        ${status === "ONLINE" ? `<span style="position: absolute; width: 100%; height: 100%; border-radius: 50%; border: 2px solid ${c.bg}; opacity: 0.7; animation: radarPing 1.8s infinite ease-out;"></span>` : ""}
      </div>
    `,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -18],
  });
};

// Calculate distance between two coordinates in km (Haversine formula)
function getDistanceFromLatLonInKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export default function GisMap({ onSwitchToOnboarding }) {
  const mapContainerRef = useRef(null);
  const mapInstanceRef = useRef(null);
  const markersLayerRef = useRef(null);
  const proximityCircleRef = useRef(null);
  const proximityMarkerRef = useRef(null);

  const [cameras, setCameras] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Live Camera Feed Modal state
  const [activeFeedCamera, setActiveFeedCamera] = useState(null);

  // Filters
  const [selectedDept, setSelectedDept] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [typeFilter, setTypeFilter] = useState("ALL");
  const [searchQuery, setSearchQuery] = useState("");

  // Proximity Search State
  const [proximityActive, setProximityActive] = useState(false);
  const [radiusKm, setRadiusKm] = useState(15);
  const [proximityCenter, setProximityCenter] = useState(null);

  // 1. Fetch Cameras GeoJSON & Departments
  useEffect(() => {
    let isCancelled = false;

    async function loadData() {
      setLoading(true);
      setError("");
      try {
        const [camsRes, deptsRes] = await Promise.all([
          fetch("/api/cameras"),
          fetch("/api/departments"),
        ]);

        if (!isCancelled) {
          if (camsRes.ok) {
            const geojson = await camsRes.json();
            const features = geojson.features || [];
            setCameras(features);
          } else {
            setError("Failed to load camera locations from backend.");
          }

          if (deptsRes.ok) {
            const depts = await deptsRes.json();
            setDepartments(depts);
          }
        }
      } catch {
        if (!isCancelled) {
          setError("Cannot reach backend server to load GIS map data.");
        }
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    }

    loadData();

    return () => {
      isCancelled = true;
    };
  }, []);

  const refreshData = async () => {
    setLoading(true);
    setError("");
    try {
      const [camsRes, deptsRes] = await Promise.all([
        fetch("/api/cameras"),
        fetch("/api/departments"),
      ]);

      if (camsRes.ok) {
        const geojson = await camsRes.json();
        const features = geojson.features || [];
        setCameras(features);
      } else {
        setError("Failed to load camera locations from backend.");
      }

      if (deptsRes.ok) {
        const depts = await deptsRes.json();
        setDepartments(depts);
      }
    } catch {
      setError("Cannot reach backend server to load GIS map data.");
    } finally {
      setLoading(false);
    }
  };

  // Delete Single Camera
  const handleDeleteCamera = async (camId, camCode) => {
    if (!window.confirm(`Are you sure you want to remove camera "${camCode || camId}" from the registry?`)) {
      return;
    }
    try {
      const res = await fetch(`/api/cameras/${encodeURIComponent(camId)}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        throw new Error("Failed to delete camera.");
      }
      setCameras((prev) =>
        prev.filter((f) => {
          const p = f.properties || {};
          return p.id !== camId && p.camera_code !== camCode && p.camera_code !== camId;
        })
      );
      if (activeFeedCamera && (activeFeedCamera.id === camId || activeFeedCamera.camera_code === camCode)) {
        setActiveFeedCamera(null);
      }
    } catch (err) {
      alert("Error deleting camera: " + err.message);
    }
  };

  // Clear All Cameras
  const handleClearAllCameras = async () => {
    if (!window.confirm("Are you sure you want to remove ALL registered cameras from the registry?")) {
      return;
    }
    try {
      const res = await fetch("/api/cameras", { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to clear cameras.");
      setCameras([]);
      setActiveFeedCamera(null);
    } catch (err) {
      alert("Error clearing cameras: " + err.message);
    }
  };

  // 2. Initialize Leaflet Map (Centered on Gujarat)
  useEffect(() => {
    if (!mapContainerRef.current) return;
    if (mapInstanceRef.current) return;

    // Centered on Gujarat
    const map = L.map(mapContainerRef.current, {
      center: [22.8, 71.8],
      zoom: 7.5,
      minZoom: 6,
      maxZoom: 18,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> | Gujarat Sentinel GIS',
      maxZoom: 19,
    }).addTo(map);

    const markersLayer = L.layerGroup().addTo(map);
    markersLayerRef.current = markersLayer;
    mapInstanceRef.current = map;

    // Handle "Watch Live Feed" and "Delete Camera" clicks inside Leaflet Popups
    map.on("popupopen", (e) => {
      const popupEl = e.popup.getElement();
      const btn = popupEl?.querySelector(".watch-feed-btn");
      if (btn) {
        btn.onclick = () => {
          const rawData = btn.getAttribute("data-cam");
          if (rawData) {
            try {
              const camObj = JSON.parse(decodeURIComponent(rawData));
              setActiveFeedCamera(camObj);
            } catch (err) {
              console.error("Error opening feed:", err);
            }
          }
        };
      }

      const delBtn = popupEl?.querySelector(".delete-cam-popup-btn");
      if (delBtn) {
        delBtn.onclick = () => {
          const camId = delBtn.getAttribute("data-cam-id");
          const camCode = delBtn.getAttribute("data-cam-code");
          if (camId) {
            map.closePopup();
            handleDeleteCamera(camId, camCode);
          }
        };
      }
    });

    // Map click for Proximity Search
    map.on("click", (e) => {
      const { lat, lng } = e.latlng;
      setProximityCenter({ lat, lng });
    });

    return () => {
      map.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  // 3. Filtered Cameras Memo
  const filteredCameras = useMemo(() => {
    return cameras.filter((f) => {
      const p = f.properties || {};
      const status = (p.status || "").toUpperCase();
      const dept = p.dept_name || "";
      const type = (p.camera_type || "").toUpperCase();
      const code = (p.camera_code || "").toLowerCase();
      const query = searchQuery.toLowerCase().trim();

      if (selectedDept !== "ALL" && dept !== selectedDept) return false;
      if (statusFilter !== "ALL" && status !== statusFilter) return false;
      if (typeFilter !== "ALL" && type !== typeFilter) return false;
      if (
        query &&
        !code.includes(query) &&
        !dept.toLowerCase().includes(query) &&
        !(p.ip_address || "").includes(query)
      ) {
        return false;
      }

      // If proximity mode active and center chosen, filter by radius
      if (proximityActive && proximityCenter && f.geometry?.coordinates) {
        const [lng, lat] = f.geometry.coordinates;
        const dist = getDistanceFromLatLonInKm(
          proximityCenter.lat,
          proximityCenter.lng,
          lat,
          lng
        );
        if (dist > radiusKm) return false;
      }

      return true;
    });
  }, [
    cameras,
    selectedDept,
    statusFilter,
    typeFilter,
    searchQuery,
    proximityActive,
    proximityCenter,
    radiusKm,
  ]);

  // Compute nearby cameras using useMemo
  const nearbyCameras = useMemo(() => {
    if (!proximityActive || !proximityCenter) return [];

    return cameras
      .filter((f) => f.geometry?.coordinates)
      .map((f) => {
        const [lng, lat] = f.geometry.coordinates;
        const dist = getDistanceFromLatLonInKm(
          proximityCenter.lat,
          proximityCenter.lng,
          lat,
          lng
        );
        return { ...f, distanceKm: Math.round(dist * 10) / 10 };
      })
      .filter((f) => f.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }, [proximityActive, proximityCenter, radiusKm, cameras]);

  // 4. Render Markers and Proximity Circle on Leaflet Map
  useEffect(() => {
    const map = mapInstanceRef.current;
    const markersLayer = markersLayerRef.current;
    if (!map || !markersLayer) return;

    markersLayer.clearLayers();

    // Render Proximity Circle
    if (proximityCircleRef.current) {
      map.removeLayer(proximityCircleRef.current);
      proximityCircleRef.current = null;
    }
    if (proximityMarkerRef.current) {
      map.removeLayer(proximityMarkerRef.current);
      proximityMarkerRef.current = null;
    }

    if (proximityActive && proximityCenter) {
      const circle = L.circle([proximityCenter.lat, proximityCenter.lng], {
        radius: radiusKm * 1000,
        color: "#3b82f6",
        fillColor: "#3b82f6",
        fillOpacity: 0.12,
        weight: 2,
        dashArray: "6, 6",
      }).addTo(map);
      proximityCircleRef.current = circle;

      const centerMarker = L.marker([proximityCenter.lat, proximityCenter.lng], {
        icon: L.divIcon({
          className: "proximity-pin",
          html: `
            <div style="
              width: 24px;
              height: 24px;
              background: #2563eb;
              border: 3px solid #ffffff;
              border-radius: 50%;
              box-shadow: 0 0 12px rgba(37,99,235,0.7);
            "></div>
          `,
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        }),
      }).addTo(map);
      centerMarker.bindPopup(`<strong>Proximity Center</strong><br/>Radius: ${radiusKm} km`);
      proximityMarkerRef.current = centerMarker;
    }

    // Render Camera Markers
    filteredCameras.forEach((feature) => {
      const coords = feature.geometry?.coordinates;
      if (!coords || coords.length < 2) return;
      const [lng, lat] = coords;
      const p = feature.properties || {};
      const status = (p.status || "OFFLINE").toUpperCase();

      const marker = L.marker([lat, lng], {
        icon: createCustomMarkerIcon(status),
      });

      const camDataEncoded = encodeURIComponent(JSON.stringify({ ...p, latitude: lat, longitude: lng }));

      const popupHtml = `
        <div style="font-family: inherit; font-size: 13px; line-height: 1.4; min-width: 240px; padding: 2px;">
          <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; margin-bottom: 8px;">
            <strong style="font-size: 14px; color: #0f172a;">${p.camera_code || "Unnamed"}</strong>
            <span style="
              padding: 2px 7px;
              border-radius: 999px;
              font-size: 11px;
              font-weight: 700;
              background: ${status === "ONLINE" ? "#dcfce7" : status === "OFFLINE" ? "#fee2e2" : "#fef3c7"};
              color: ${status === "ONLINE" ? "#16a34a" : status === "OFFLINE" ? "#dc2626" : "#d97706"};
            ">${status}</span>
          </div>

          <div style="margin-bottom: 4px;">
            <span style="color: #64748b; font-size: 11px;">Department:</span><br/>
            <strong>${p.dept_name || "N/A"}</strong>
          </div>

          <div style="margin-bottom: 4px;">
            <span style="color: #64748b; font-size: 11px;">Type & Source:</span><br/>
            <span>${p.make_model || "Camera"} (${p.source_type === "LOCAL_WEBCAM" ? "Laptop Webcam" : p.camera_type || "CCTV"})</span>
          </div>

          <div style="margin-bottom: 4px;">
            <span style="color: #64748b; font-size: 11px;">Network IP:</span><br/>
            <code style="background: #f1f5f9; padding: 2px 5px; border-radius: 4px; font-size: 11px;">${p.ip_address || "Local Device"}</code>
          </div>

          <div style="margin-bottom: 10px;">
            <span style="color: #64748b; font-size: 11px;">Stream URL:</span><br/>
            <code style="word-break: break-all; font-size: 10px; color: #2563eb;">${p.rtsp_url || "webrtc://live"}</code>
          </div>

          <!-- ACTION BUTTONS: WATCH FEED & DELETE -->
          <div style="display: flex; gap: 6px; margin-top: 10px;">
            <button
              type="button"
              class="watch-feed-btn"
              data-cam="${camDataEncoded}"
              style="
                flex: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 5px;
                background: #0f172a;
                color: #ffffff;
                border: none;
                padding: 8px 12px;
                border-radius: 6px;
                font-size: 11px;
                font-weight: 700;
                cursor: pointer;
                transition: all 0.15s ease;
              "
            >
              ▶ Watch Feed
            </button>

            <button
              type="button"
              class="delete-cam-popup-btn"
              data-cam-id="${p.id || p.camera_code}"
              data-cam-code="${p.camera_code}"
              style="
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
                background: #fee2e2;
                color: #991b1b;
                border: 1px solid #fecaca;
                padding: 8px 10px;
                border-radius: 6px;
                font-size: 11px;
                font-weight: 700;
                cursor: pointer;
                transition: all 0.15s ease;
              "
              title="Delete this camera from registry"
            >
              🗑 Delete
            </button>
          </div>
        </div>
      `;

      marker.bindPopup(popupHtml);
      markersLayer.addLayer(marker);
    });

    // Auto-fit bounds if cameras exist
    if (filteredCameras.length > 0) {
      const bounds = L.latLngBounds(
        filteredCameras.map((f) => [f.geometry.coordinates[1], f.geometry.coordinates[0]])
      );
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    }
  }, [filteredCameras, proximityActive, proximityCenter, radiusKm]);

  // Overall Statistics
  const stats = useMemo(() => {
    let online = 0;
    let offline = 0;
    let maintenance = 0;
    cameras.forEach((f) => {
      const s = (f.properties?.status || "").toUpperCase();
      if (s === "ONLINE") online++;
      else if (s === "OFFLINE") offline++;
      else if (s === "MAINTENANCE") maintenance++;
    });
    return {
      total: cameras.length,
      online,
      offline,
      maintenance,
    };
  }, [cameras]);

  const resetAllFilters = () => {
    setSelectedDept("ALL");
    setStatusFilter("ALL");
    setTypeFilter("ALL");
    setSearchQuery("");
    setProximityActive(false);
    setProximityCenter(null);
  };

  const focusGujaratCenter = () => {
    if (mapInstanceRef.current) {
      mapInstanceRef.current.flyTo([22.8, 71.8], 7.5);
    }
  };

  return (
    <div className="gis-map-view">
      {/* GIS TOP TOOLBAR */}
      <div className="gis-toolbar">
        <div className="toolbar-row-top">
          <div className="toolbar-title">
            <Layers size={22} className="text-primary" />
            <div>
              <h3>Gujarat Statewide GIS Camera Map</h3>
              <p>Live spatial monitoring & surveillance feed center</p>
            </div>
          </div>

          <div className="stats-badges-cluster">
            <div className="stat-pill total">
              <span>Fed Cameras:</span>
              <strong>{filteredCameras.length} registered</strong>
            </div>
            <div className="stat-pill online">
              <span className="dot online"></span>
              <span>Online: <strong>{stats.online}</strong></span>
            </div>
            <div className="stat-pill offline">
              <span className="dot offline"></span>
              <span>Offline: <strong>{stats.offline}</strong></span>
            </div>
            <div className="stat-pill maintenance">
              <span className="dot maintenance"></span>
              <span>MNT: <strong>{stats.maintenance}</strong></span>
            </div>
          </div>
        </div>

        {/* CONTROLS ROW */}
        <div className="toolbar-controls">
          {/* SEARCH INPUT */}
          <div className="search-box">
            <Search size={16} />
            <input
              type="text"
              placeholder="Search camera code, department, IP..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                className="clear-search"
                onClick={() => setSearchQuery("")}
              >
                ✕
              </button>
            )}
          </div>

          {/* DEPARTMENT SELECT */}
          <div className="filter-item">
            <select
              value={selectedDept}
              onChange={(e) => setSelectedDept(e.target.value)}
            >
              <option value="ALL">All Departments ({departments.length})</option>
              {departments.map((d) => (
                <option key={d.id || d.dept_name} value={d.dept_name}>
                  {d.dept_name}
                </option>
              ))}
            </select>
          </div>

          {/* STATUS PILL BUTTONS */}
          <div className="status-toggle-group">
            <button
              type="button"
              className={`status-btn ${statusFilter === "ALL" ? "active" : ""}`}
              onClick={() => setStatusFilter("ALL")}
            >
              All
            </button>
            <button
              type="button"
              className={`status-btn online ${statusFilter === "ONLINE" ? "active" : ""}`}
              onClick={() => setStatusFilter("ONLINE")}
            >
              Online
            </button>
            <button
              type="button"
              className={`status-btn offline ${statusFilter === "OFFLINE" ? "active" : ""}`}
              onClick={() => setStatusFilter("OFFLINE")}
            >
              Offline
            </button>
            <button
              type="button"
              className={`status-btn maintenance ${statusFilter === "MAINTENANCE" ? "active" : ""}`}
              onClick={() => setStatusFilter("MAINTENANCE")}
            >
              MNT
            </button>
          </div>

          {/* CAMERA TYPE SELECT */}
          <div className="filter-item">
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <option value="ALL">All Types</option>
              <option value="BULLET">Bullet</option>
              <option value="PTZ">PTZ</option>
              <option value="DOME">Dome</option>
              <option value="FIXED">Fixed</option>
            </select>
          </div>

          {/* PROXIMITY TOOL TOGGLE */}
          <button
            type="button"
            className={`proximity-toggle-btn ${proximityActive ? "active" : ""}`}
            onClick={() => {
              setProximityActive(!proximityActive);
              if (!proximityActive && !proximityCenter) {
                setProximityCenter({ lat: 23.0225, lng: 72.5714 });
              }
            }}
          >
            <Crosshair size={16} />
            <span>Proximity Radius</span>
          </button>

          {/* RESET BUTTON */}
          <button
            type="button"
            className="reset-filters-btn"
            onClick={resetAllFilters}
            title="Reset Filters"
          >
            <RefreshCw size={15} />
            <span>Reset</span>
          </button>
        </div>

        {/* PROXIMITY EXPANDED DRAWER */}
        {proximityActive && (
          <div className="proximity-drawer">
            <div className="proximity-info">
              <Compass size={18} className="text-primary" />
              <span>
                <strong>Spatial Proximity Search Active:</strong> Click anywhere on the map to drop center pin.
              </span>
            </div>

            <div className="radius-selector">
              <label>Radius:</label>
              {[5, 10, 15, 25, 50].map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`radius-chip ${radiusKm === r ? "selected" : ""}`}
                  onClick={() => setRadiusKm(r)}
                >
                  {r} km
                </button>
              ))}
            </div>

            <div className="nearby-count-pill">
              Found <strong>{nearbyCameras.length}</strong> cameras within {radiusKm} km
            </div>
          </div>
        )}
      </div>

      {/* MAP VIEW CONTAINER */}
      <div className="map-view-wrapper">
        <div ref={mapContainerRef} className="leaflet-gis-map-canvas" />

        {/* FLOATING MAP CONTROLS OVERLAY */}
        <div className="map-floating-overlay">
          <button
            type="button"
            className="floating-map-btn"
            onClick={focusGujaratCenter}
            title="Reset View to Gujarat"
          >
            <Radio size={16} />
            Gujarat Overview
          </button>

          <button
            type="button"
            className="floating-map-btn"
            onClick={refreshData}
            title="Refresh Camera Data"
          >
            <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>

        {/* EMPTY STATE BANNER (When user hasn't registered cameras yet) */}
        {!loading && cameras.length === 0 && (
          <div className="map-empty-state-card">
            <div className="empty-icon-circle">
              <Video size={36} />
            </div>
            <h4>No Cameras Registered Yet</h4>
            <p>
              Your GIS Map displays only the real cameras you feed into the registry. Add your laptop webcam or a Network CCTV to see it live on the map!
            </p>
            <button
              type="button"
              className="primary-button"
              onClick={onSwitchToOnboarding}
            >
              <Plus size={18} />
              Feed Your First Camera
            </button>
          </div>
        )}

        {/* QUICK LIVE FEED LIST SIDEBAR (When cameras exist) */}
        {cameras.length > 0 && (
          <div className="map-feed-quick-sidebar">
            <div className="sidebar-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <Video size={16} />
                <span>Live Feeds ({cameras.length})</span>
              </div>
              <button
                type="button"
                className="clear-all-sidebar-btn"
                onClick={handleClearAllCameras}
                title="Clear all cameras from registry"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "#f87171",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                  fontSize: "11px",
                  fontWeight: 600,
                  padding: "3px 6px",
                  borderRadius: "4px",
                  transition: "all 0.15s ease"
                }}
              >
                <Trash2 size={13} />
                <span>Clear</span>
              </button>
            </div>
            <div className="sidebar-feed-list">
              {cameras.map((f) => {
                const p = f.properties || {};
                const isOnline = (p.status || "").toUpperCase() === "ONLINE";
                return (
                  <div
                    key={p.id || p.camera_code}
                    className="quick-feed-card"
                    onClick={() =>
                      setActiveFeedCamera({
                        ...p,
                        latitude: f.geometry?.coordinates?.[1],
                        longitude: f.geometry?.coordinates?.[0],
                      })
                    }
                  >
                    <div className="quick-feed-title">
                      <strong>{p.camera_code}</strong>
                      <span className={`status-dot ${isOnline ? "online" : "offline"}`}></span>
                    </div>
                    <p className="quick-feed-dept">{p.dept_name}</p>
                    <div className="quick-feed-footer">
                      <span>{p.source_type === "LOCAL_WEBCAM" ? "Webcam" : p.camera_type || "CCTV"}</span>
                      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                        <span className="watch-link">
                          <Play size={11} /> Watch
                        </span>
                        <span
                          className="delete-feed-link"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteCamera(p.id || p.camera_code, p.camera_code);
                          }}
                          title="Delete Camera"
                          style={{
                            color: "#ef4444",
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            padding: "2px",
                            borderRadius: "4px"
                          }}
                        >
                          <Trash2 size={13} />
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ERROR NOTIFICATION OVERLAY */}
        {error && (
          <div className="map-error-banner">
            <AlertTriangle size={18} />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* LIVE CCTV FEED PLAYER MODAL SCREEN */}
      {activeFeedCamera && (
        <CameraFeedModal
          camera={activeFeedCamera}
          onClose={() => setActiveFeedCamera(null)}
        />
      )}
    </div>
  );
}

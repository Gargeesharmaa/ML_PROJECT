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
  Trash2,
  UploadCloud
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

export default function GisMap({ onSwitchToOnboarding, onSwitchToBulkCsv }) {
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

  // Camera Removal / Deletion State
  const [cameraToDelete, setCameraToDelete] = useState(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteSuccessMsg, setDeleteSuccessMsg] = useState("");

  // Confirm and execute camera deletion
  const confirmDeleteCamera = async () => {
    if (!cameraToDelete) return;
    setDeleteLoading(true);
    try {
      const targetId = cameraToDelete.id || cameraToDelete.code;
      const res = await fetch(`/api/cameras/${encodeURIComponent(targetId)}`, {
        method: "DELETE",
      });

      if (res.ok) {
        setCameras((prev) =>
          prev.filter((c) => {
            const p = c.properties || {};
            return (
              p.id !== cameraToDelete.id &&
              p.camera_code !== cameraToDelete.id &&
              p.camera_code !== cameraToDelete.code
            );
          })
        );
        if (mapInstanceRef.current) {
          mapInstanceRef.current.closePopup();
        }
        setDeleteSuccessMsg(`Camera ${cameraToDelete.code} successfully removed.`);
        setTimeout(() => setDeleteSuccessMsg(""), 4000);
        setCameraToDelete(null);
      } else {
        const data = await res.json().catch(() => ({}));
        alert(`Failed to remove camera: ${data.detail || "Server error"}`);
      }
    } catch {
      alert("Error communicating with server to remove camera.");
    } finally {
      setDeleteLoading(false);
    }
  };

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

    // Handle "Watch Live Feed" and "Remove Camera" clicks inside Leaflet Popups
    map.on("popupopen", (e) => {
      const popupEl = e.popup.getElement();
      if (!popupEl) return;

      const feedBtn = popupEl.querySelector(".watch-feed-btn");
      if (feedBtn) {
        feedBtn.onclick = () => {
          const rawData = feedBtn.getAttribute("data-cam");
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

      const deleteBtn = popupEl.querySelector(".delete-cam-btn");
      if (deleteBtn) {
        deleteBtn.onclick = () => {
          const camId = deleteBtn.getAttribute("data-id");
          const camCode = deleteBtn.getAttribute("data-code");
          if (camId || camCode) {
            setCameraToDelete({ id: camId || camCode, code: camCode || camId });
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

          <!-- ACTION BUTTONS: WATCH LIVE FEED & REMOVE CAMERA -->
          <div style="display: flex; gap: 8px; margin-top: 8px;">
            <button
              type="button"
              class="watch-feed-btn"
              data-cam="${camDataEncoded}"
              style="
                flex: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                background: #0f172a;
                color: #ffffff;
                border: none;
                padding: 8px 10px;
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
              class="delete-cam-btn"
              data-id="${p.id || p.camera_code}"
              data-code="${p.camera_code || "Camera"}"
              title="Remove camera from GIS registry"
              style="
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 4px;
                background: #fee2e2;
                color: #dc2626;
                border: 1px solid #fca5a5;
                padding: 8px 10px;
                border-radius: 6px;
                font-size: 11px;
                font-weight: 700;
                cursor: pointer;
                transition: all 0.15s ease;
              "
            >
              🗑️ Remove
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
              Your GIS Map displays only the real cameras you feed into the registry. Add your laptop webcam, a Network CCTV, or import via CSV to see them live on the map!
            </p>
            <div style={{ display: "flex", gap: "10px", justifyContent: "center" }}>
              <button
                type="button"
                className="primary-button"
                onClick={onSwitchToOnboarding}
              >
                <Plus size={18} />
                Feed Camera
              </button>
              {onSwitchToBulkCsv && (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={onSwitchToBulkCsv}
                  style={{ display: "flex", alignItems: "center", gap: "6px" }}
                >
                  <UploadCloud size={18} />
                  Bulk CSV Import
                </button>
              )}
            </div>
          </div>
        )}

        {/* QUICK LIVE FEED LIST SIDEBAR (When cameras exist) */}
        {cameras.length > 0 && (
          <div className="map-feed-quick-sidebar">
            <div className="sidebar-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <Video size={16} />
                <span>Live Feeds ({cameras.length})</span>
              </div>
              {onSwitchToBulkCsv && (
                <button
                  type="button"
                  onClick={onSwitchToBulkCsv}
                  title="Import more cameras via CSV"
                  style={{
                    background: "rgba(255,255,255,0.15)",
                    border: "none",
                    color: "#fff",
                    borderRadius: "4px",
                    padding: "2px 6px",
                    fontSize: "11px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "4px"
                  }}
                >
                  <UploadCloud size={12} /> +CSV
                </button>
              )}
            </div>
            <div className="sidebar-feed-list">
              {cameras.map((f) => {
                const p = f.properties || {};
                const isOnline = (p.status || "").toUpperCase() === "ONLINE";
                return (
                  <div
                    key={p.id || p.camera_code}
                    className="quick-feed-card"
                    style={{ position: "relative" }}
                  >
                    <div
                      className="quick-feed-title"
                      style={{ cursor: "pointer" }}
                      onClick={() =>
                        setActiveFeedCamera({
                          ...p,
                          latitude: f.geometry?.coordinates?.[1],
                          longitude: f.geometry?.coordinates?.[0],
                        })
                      }
                    >
                      <strong>{p.camera_code}</strong>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <span className={`status-dot ${isOnline ? "online" : "offline"}`}></span>
                        <button
                          type="button"
                          className="quick-feed-delete-btn"
                          title={`Remove ${p.camera_code}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setCameraToDelete({
                              id: p.id || p.camera_code,
                              code: p.camera_code || "Camera",
                            });
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                    <p
                      className="quick-feed-dept"
                      style={{ cursor: "pointer" }}
                      onClick={() =>
                        setActiveFeedCamera({
                          ...p,
                          latitude: f.geometry?.coordinates?.[1],
                          longitude: f.geometry?.coordinates?.[0],
                        })
                      }
                    >
                      {p.dept_name}
                    </p>
                    <div
                      className="quick-feed-footer"
                      style={{ cursor: "pointer" }}
                      onClick={() =>
                        setActiveFeedCamera({
                          ...p,
                          latitude: f.geometry?.coordinates?.[1],
                          longitude: f.geometry?.coordinates?.[0],
                        })
                      }
                    >
                      <span>{p.source_type === "LOCAL_WEBCAM" ? "Webcam" : p.camera_type || "CCTV"}</span>
                      <span className="watch-link">
                        <Play size={11} /> Watch
                      </span>
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

      {/* DELETE CAMERA CONFIRMATION MODAL */}
      {cameraToDelete && (
        <div className="cctv-modal-overlay">
          <div
            style={{
              background: "#ffffff",
              borderRadius: "12px",
              padding: "24px",
              maxWidth: "440px",
              width: "100%",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.25)",
              animation: "fadeIn 0.15s ease-out",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "14px", marginBottom: "14px" }}>
              <div
                style={{
                  width: "42px",
                  height: "42px",
                  borderRadius: "50%",
                  background: "#fee2e2",
                  color: "#dc2626",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <Trash2 size={20} />
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>
                  Remove Camera from GIS Map?
                </h3>
                <p style={{ margin: "3px 0 0", fontSize: "13px", color: "#64748b" }}>
                  Camera Code: <strong style={{ color: "#0f172a" }}>{cameraToDelete.code}</strong>
                </p>
              </div>
            </div>
            <p style={{ fontSize: "13px", color: "#475569", lineHeight: 1.5, marginBottom: "20px" }}>
              Are you sure you want to remove this camera? It will be deleted from the statewide GIS registry database and live surveillance feeds.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button
                type="button"
                disabled={deleteLoading}
                onClick={() => setCameraToDelete(null)}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  border: "1px solid #cbd5e1",
                  background: "#ffffff",
                  color: "#334155",
                  fontWeight: 600,
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleteLoading}
                onClick={confirmDeleteCamera}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  border: "none",
                  background: "#dc2626",
                  color: "#ffffff",
                  fontWeight: 600,
                  fontSize: "13px",
                  cursor: deleteLoading ? "not-allowed" : "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                }}
              >
                {deleteLoading ? <RefreshCw size={14} className="animate-spin" /> : <Trash2 size={14} />}
                {deleteLoading ? "Removing..." : "Yes, Remove Camera"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* DELETE SUCCESS NOTIFICATION TOAST */}
      {deleteSuccessMsg && (
        <div
          style={{
            position: "fixed",
            bottom: "24px",
            right: "24px",
            zIndex: 10000,
            background: "#0f172a",
            color: "#ffffff",
            padding: "12px 18px",
            borderRadius: "8px",
            boxShadow: "0 10px 15px -3px rgba(0,0,0,0.3)",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            fontSize: "13px",
            fontWeight: 600,
            borderLeft: "4px solid #10b981",
          }}
        >
          <span>✓</span>
          <span>{deleteSuccessMsg}</span>
        </div>
      )}

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

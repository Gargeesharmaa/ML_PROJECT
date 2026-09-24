import { useState, useRef } from "react";
import {
  FileSpreadsheet,
  UploadCloud,
  Download,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  FileText,
  RefreshCw,
  MapPin,
  Check,
  AlertCircle,
  Eye,
  Layers,
  ArrowRight,
  Edit2,
  Trash2,
  Plus,
  X,
  Save
} from "lucide-react";

export default function CsvImport({ onNavigateToMap }) {
  const fileInputRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);

  // Validation State
  const [isValidating, setIsValidating] = useState(false);
  const [validationData, setValidationData] = useState(null);
  const [validationError, setValidationError] = useState("");
  const [filterMode, setFilterMode] = useState("ALL"); // "ALL" | "VALID" | "ERROR"

  // Inline Row Editing State
  const [editingRowIndex, setEditingRowIndex] = useState(null);
  const [editDraft, setEditDraft] = useState({});

  // Import State
  const [isImporting, setIsImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importError, setImportError] = useState("");

  // 1. Download CSV Template
  const handleDownloadTemplate = async () => {
    try {
      const response = await fetch("/api/cameras/csv-template");
      if (!response.ok) throw new Error("Failed to download template");
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "gujarat_cctv_registry_template.csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      alert("Error downloading CSV template: " + err.message);
    }
  };

  // 2. File Selection & Drag-and-Drop Handling
  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  // 3. Process & Pre-validate CSV
  const processFile = async (file) => {
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setValidationError("Please upload a valid CSV file ending with .csv");
      return;
    }

    setSelectedFile(file);
    setValidationError("");
    setImportError("");
    setImportResult(null);
    setEditingRowIndex(null);
    setIsValidating(true);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch("/api/cameras/validate-csv", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Failed to validate CSV file");
      }

      setValidationData(data);
    } catch (err) {
      setValidationError(err.message || "Failed to validate CSV file");
      setValidationData(null);
    } finally {
      setIsValidating(false);
    }
  };

  // 4. Revalidate current rows after inline edit / delete / add
  const revalidateCurrentRows = async (rows) => {
    setIsValidating(true);
    try {
      const response = await fetch("/api/cameras/validate-records", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: rows }),
      });
      const data = await response.json();
      if (response.ok) {
        setValidationData(data);
      }
    } catch (err) {
      console.error("Failed to revalidate records:", err);
    } finally {
      setIsValidating(false);
    }
  };

  // 5. Row Edit Handlers
  const handleStartEdit = (row, idx) => {
    setEditingRowIndex(idx);
    setEditDraft({
      camera_code: row.camera_code || "",
      dept_name: row.dept_name || "",
      camera_type: row.camera_type || "FIXED",
      make_model: row.make_model || "",
      source_type: row.source_type || "NETWORK_CCTV",
      ip_address: row.ip_address || "",
      rtsp_url: row.rtsp_url || "",
      latitude: row.latitude !== undefined && row.latitude !== null ? row.latitude : 23.0225,
      longitude: row.longitude !== undefined && row.longitude !== null ? row.longitude : 72.5714,
      status: row.status || "ONLINE",
      ageing: row.ageing !== undefined && row.ageing !== null ? row.ageing : 1.0,
    });
  };

  const handleCancelEdit = () => {
    setEditingRowIndex(null);
    setEditDraft({});
  };

  const handleSaveEdit = async (idx) => {
    if (!validationData || !validationData.rows) return;
    const updatedRows = [...validationData.rows];
    updatedRows[idx] = {
      ...updatedRows[idx],
      ...editDraft,
      latitude: editDraft.latitude ? parseFloat(editDraft.latitude) : null,
      longitude: editDraft.longitude ? parseFloat(editDraft.longitude) : null,
      ageing: editDraft.ageing ? parseFloat(editDraft.ageing) : 0.0,
    };
    setEditingRowIndex(null);
    setEditDraft({});
    await revalidateCurrentRows(updatedRows);
  };

  const handleDeleteRow = async (idx) => {
    if (!validationData || !validationData.rows) return;
    const updatedRows = validationData.rows.filter((_, i) => i !== idx);
    setEditingRowIndex(null);
    await revalidateCurrentRows(updatedRows);
  };

  const handleAddNewRow = async () => {
    const currentRows = validationData?.rows || [];
    const newIdx = currentRows.length;
    const newRow = {
      row_number: newIdx + 1,
      camera_code: `CAM-GJ-${String(newIdx + 1).padStart(4, "0")}`,
      dept_name: "Gujarat Police",
      camera_type: "ANPR",
      make_model: "Hikvision ANPR 4K",
      source_type: "NETWORK_CCTV",
      ip_address: `192.168.1.${100 + newIdx}`,
      rtsp_url: `rtsp://admin:pass123@192.168.1.${100 + newIdx}:554/live`,
      latitude: 23.0225,
      longitude: 72.5714,
      status: "ONLINE",
      ageing: 0.5,
    };
    const updatedRows = [...currentRows, newRow];
    await revalidateCurrentRows(updatedRows);
    setEditingRowIndex(newIdx);
    setEditDraft({ ...newRow });
  };

  // 6. Confirm & Bulk Import
  const handleConfirmImport = async () => {
    if (!validationData?.rows || validationData.rows.length === 0) return;

    setIsImporting(true);
    setImportError("");

    try {
      const validRowsToImport = validationData.rows.filter((r) => r.is_valid);
      if (validRowsToImport.length === 0) {
        throw new Error("No valid camera rows to import. Please fix row errors first.");
      }

      const response = await fetch("/api/cameras/bulk-import-json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cameras: validRowsToImport }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Failed to import cameras");
      }

      setImportResult(data);
    } catch (err) {
      setImportError(err.message || "Bulk import failed. Please verify the entries.");
    } finally {
      setIsImporting(false);
    }
  };

  const handleReset = () => {
    setSelectedFile(null);
    setValidationData(null);
    setValidationError("");
    setImportResult(null);
    setImportError("");
    setEditingRowIndex(null);
    setEditDraft({});
    setFilterMode("ALL");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // Filtered rows for table
  const filteredRows = (validationData?.rows || []).map((row, originalIndex) => ({
    ...row,
    originalIndex,
  })).filter((r) => {
    if (filterMode === "VALID") return r.is_valid;
    if (filterMode === "ERROR") return !r.is_valid;
    return true;
  });

  return (
    <main className="onboarding-main csv-import-container">
      {/* HEADER SECTION */}
      <div className="csv-page-header">
        <div>
          <div className="eyebrow-tag">
            <FileSpreadsheet size={13} />
            <span>BULK ASSET REGISTRATION & INLINE EDITING</span>
          </div>
          <h2>Bulk Camera Onboarding via CSV</h2>
          <p className="page-description">
            Upload CSV camera lists, edit row fields directly in-place, add or delete entries, and deploy directly to GIS.
          </p>
        </div>

        <button
          type="button"
          className="template-download-btn"
          onClick={handleDownloadTemplate}
          title="Download pre-filled CSV sample template"
        >
          <Download size={15} />
          <span>Download Sample Template</span>
        </button>
      </div>

      {/* SUCCESS CONFIRMATION MODAL / BANNER */}
      {importResult && (
        <div className="import-success-card">
          <div className="success-icon-wrap">
            <CheckCircle2 size={40} />
          </div>
          <div className="success-content">
            <h3>Cameras Successfully Imported!</h3>
            <p>
              Imported <strong>{importResult.imported_count}</strong> cameras into the Gujarat State CCTV Registry.
              {importResult.skipped_count > 0 && ` (${importResult.skipped_count} skipped due to duplicates or errors).`}
            </p>
            {importResult.imported_cameras?.length > 0 && (
              <div className="imported-chips-row">
                {importResult.imported_cameras.slice(0, 8).map((code) => (
                  <span key={code} className="imported-cam-badge">
                    {code}
                  </span>
                ))}
                {importResult.imported_cameras.length > 8 && (
                  <span className="imported-cam-badge more">
                    +{importResult.imported_cameras.length - 8} more
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="success-actions">
            <button
              type="button"
              className="primary-button map-nav-btn"
              onClick={onNavigateToMap}
            >
              <MapPin size={16} />
              <span>View Imported Cameras on GIS Live Map</span>
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={handleReset}
            >
              Upload Another CSV
            </button>
          </div>
        </div>
      )}

      {/* DROPZONE SECTION (Hidden once file is uploaded and validated) */}
      {!validationData && !importResult && (
        <div
          className={`csv-dropzone ${dragActive ? "drag-active" : ""}`}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv"
            style={{ display: "none" }}
            onChange={handleFileChange}
          />

          {!selectedFile ? (
            <div className="dropzone-content">
              <div className="dropzone-icon">
                <UploadCloud size={44} />
              </div>
              <h4>Drag & drop your CSV file here</h4>
              <p>or click to browse from your computer (Standard .csv format)</p>
              <div className="format-hint">
                <span>Headers: camera_code, dept_name, camera_type (ANPR, PTZ, Bullet...), ip_address, rtsp_url, latitude, longitude</span>
              </div>
            </div>
          ) : (
            <div className="dropzone-file-card" onClick={(e) => e.stopPropagation()}>
              <div className="file-info-col">
                <div className="file-icon-badge">
                  <FileText size={24} />
                </div>
                <div>
                  <strong>{selectedFile.name}</strong>
                  <span>{(selectedFile.size / 1024).toFixed(1)} KB • CSV Document</span>
                </div>
              </div>

              <div className="file-actions">
                <button
                  type="button"
                  className="change-file-btn"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Change File
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* VALIDATION SPINNER */}
      {isValidating && (
        <div className="validating-banner">
          <RefreshCw size={18} className="animate-spin" />
          <span>Validating schema, coordinates, and network camera parameters...</span>
        </div>
      )}

      {/* VALIDATION ERROR ALERT */}
      {validationError && (
        <div className="csv-error-alert">
          <AlertCircle size={20} />
          <div>
            <strong>Validation Error</strong>
            <p>{validationError}</p>
          </div>
          <button type="button" onClick={() => setValidationError("")}>
            <XCircle size={16} />
          </button>
        </div>
      )}

      {/* VALIDATION RESULTS TABLE & CONTROLS */}
      {validationData && !importResult && (
        <div className="csv-results-section">
          {/* STATS & FILTER BAR */}
          <div className="csv-summary-toolbar">
            <div className="kpi-group">
              <div className="kpi-pill total">
                <span>Total Rows:</span>
                <strong>{validationData.total_rows}</strong>
              </div>
              <div className="kpi-pill valid">
                <Check size={14} />
                <span>Ready to Import:</span>
                <strong>{validationData.valid_count}</strong>
              </div>
              {validationData.invalid_count > 0 && (
                <div className="kpi-pill error">
                  <AlertTriangle size={14} />
                  <span>Issues / Incomplete:</span>
                  <strong>{validationData.invalid_count}</strong>
                </div>
              )}
            </div>

            <div className="filter-and-actions">
              <div className="filter-toggle-group">
                <button
                  type="button"
                  className={`filter-btn ${filterMode === "ALL" ? "active" : ""}`}
                  onClick={() => setFilterMode("ALL")}
                >
                  All ({validationData.total_rows})
                </button>
                <button
                  type="button"
                  className={`filter-btn valid ${filterMode === "VALID" ? "active" : ""}`}
                  onClick={() => setFilterMode("VALID")}
                >
                  Valid Only ({validationData.valid_count})
                </button>
                {validationData.invalid_count > 0 && (
                  <button
                    type="button"
                    className={`filter-btn error ${filterMode === "ERROR" ? "active" : ""}`}
                    onClick={() => setFilterMode("ERROR")}
                  >
                    Errors Only ({validationData.invalid_count})
                  </button>
                )}
              </div>

              {/* ADD ROW BUTTON */}
              <button
                type="button"
                className="add-row-action-btn"
                onClick={handleAddNewRow}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "7px 12px",
                  background: "#0f172a",
                  color: "#ffffff",
                  borderRadius: "6px",
                  fontSize: "12px",
                  fontWeight: 600,
                  cursor: "pointer",
                  border: "none"
                }}
              >
                <Plus size={14} />
                <span>Add Camera Row</span>
              </button>
            </div>
          </div>

          {/* DATA TABLE */}
          <div className="csv-table-wrapper">
            <table className="csv-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Status</th>
                  <th>Camera Code</th>
                  <th>Department</th>
                  <th>Type</th>
                  <th>IP Address</th>
                  <th>RTSP Stream</th>
                  <th>Coordinates</th>
                  <th>Diagnostics / Notes</th>
                  <th style={{ textAlign: "center", minWidth: "90px" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => {
                  const isEditing = editingRowIndex === row.originalIndex;

                  return (
                    <tr
                      key={row.row_number || row.originalIndex}
                      className={row.is_valid ? "row-valid" : "row-invalid"}
                      style={isEditing ? { background: "#f0fdf4" } : {}}
                    >
                      <td>{row.originalIndex + 1}</td>

                      {/* STATUS BADGE */}
                      <td>
                        {row.is_valid ? (
                          <span className="status-badge valid">
                            <Check size={12} /> Valid
                          </span>
                        ) : (
                          <span className="status-badge error">
                            <XCircle size={12} /> Error
                          </span>
                        )}
                      </td>

                      {/* CAMERA CODE */}
                      <td>
                        {isEditing ? (
                          <input
                            type="text"
                            value={editDraft.camera_code}
                            onChange={(e) => setEditDraft({ ...editDraft, camera_code: e.target.value })}
                            style={{ width: "120px", padding: "4px 6px", fontSize: "12px", borderRadius: "4px", border: "1px solid #cbd5e1" }}
                          />
                        ) : (
                          <strong className="code-text">{row.camera_code}</strong>
                        )}
                      </td>

                      {/* DEPARTMENT */}
                      <td>
                        {isEditing ? (
                          <input
                            type="text"
                            value={editDraft.dept_name}
                            onChange={(e) => setEditDraft({ ...editDraft, dept_name: e.target.value })}
                            style={{ width: "150px", padding: "4px 6px", fontSize: "12px", borderRadius: "4px", border: "1px solid #cbd5e1" }}
                          />
                        ) : (
                          row.dept_name
                        )}
                      </td>

                      {/* CAMERA TYPE */}
                      <td>
                        {isEditing ? (
                          <select
                            value={editDraft.camera_type}
                            onChange={(e) => setEditDraft({ ...editDraft, camera_type: e.target.value })}
                            style={{ padding: "4px 6px", fontSize: "12px", borderRadius: "4px", border: "1px solid #cbd5e1" }}
                          >
                            <option value="ANPR">ANPR</option>
                            <option value="BULLET">Bullet</option>
                            <option value="PTZ">PTZ</option>
                            <option value="DOME">Dome</option>
                            <option value="FIXED">Fixed</option>
                            <option value="THERMAL">Thermal</option>
                          </select>
                        ) : (
                          <span className="type-pill" style={row.camera_type === "ANPR" ? { background: "#e0e7ff", color: "#4338ca", fontWeight: 700 } : {}}>
                            {row.camera_type}
                          </span>
                        )}
                      </td>

                      {/* IP ADDRESS */}
                      <td>
                        {isEditing ? (
                          <input
                            type="text"
                            value={editDraft.ip_address}
                            onChange={(e) => setEditDraft({ ...editDraft, ip_address: e.target.value })}
                            style={{ width: "110px", padding: "4px 6px", fontSize: "12px", borderRadius: "4px", border: "1px solid #cbd5e1" }}
                          />
                        ) : (
                          <code>{row.ip_address || "N/A"}</code>
                        )}
                      </td>

                      {/* RTSP STREAM */}
                      <td className="stream-cell">
                        {isEditing ? (
                          <input
                            type="text"
                            value={editDraft.rtsp_url}
                            onChange={(e) => setEditDraft({ ...editDraft, rtsp_url: e.target.value })}
                            style={{ width: "180px", padding: "4px 6px", fontSize: "11px", borderRadius: "4px", border: "1px solid #cbd5e1" }}
                          />
                        ) : (
                          <span title={row.rtsp_url}>
                            {row.rtsp_url ? (row.rtsp_url.length > 26 ? row.rtsp_url.substring(0, 26) + "..." : row.rtsp_url) : "—"}
                          </span>
                        )}
                      </td>

                      {/* COORDINATES */}
                      <td>
                        {isEditing ? (
                          <div style={{ display: "flex", gap: "4px" }}>
                            <input
                              type="number"
                              step="0.0001"
                              placeholder="Lat"
                              value={editDraft.latitude}
                              onChange={(e) => setEditDraft({ ...editDraft, latitude: e.target.value })}
                              style={{ width: "65px", padding: "4px 4px", fontSize: "11px", borderRadius: "4px", border: "1px solid #cbd5e1" }}
                            />
                            <input
                              type="number"
                              step="0.0001"
                              placeholder="Lng"
                              value={editDraft.longitude}
                              onChange={(e) => setEditDraft({ ...editDraft, longitude: e.target.value })}
                              style={{ width: "65px", padding: "4px 4px", fontSize: "11px", borderRadius: "4px", border: "1px solid #cbd5e1" }}
                            />
                          </div>
                        ) : (
                          <span className="coords-text">
                            {row.latitude !== null && row.latitude !== undefined ? row.latitude.toFixed(4) : "—"}, {row.longitude !== null && row.longitude !== undefined ? row.longitude.toFixed(4) : "—"}
                          </span>
                        )}
                      </td>

                      {/* DIAGNOSTICS */}
                      <td>
                        {row.is_valid ? (
                          <span className="note-ok">Passed verification</span>
                        ) : (
                          <span className="note-err" title={(row.errors || []).join("; ")}>
                            {(row.errors || []).join("; ")}
                          </span>
                        )}
                      </td>

                      {/* ACTIONS: EDIT, SAVE, CANCEL, DELETE */}
                      <td style={{ textAlign: "center" }}>
                        {isEditing ? (
                          <div style={{ display: "inline-flex", gap: "6px" }}>
                            <button
                              type="button"
                              onClick={() => handleSaveEdit(row.originalIndex)}
                              title="Save edits"
                              style={{
                                padding: "4px 8px",
                                background: "#16a34a",
                                color: "#ffffff",
                                border: "none",
                                borderRadius: "4px",
                                cursor: "pointer",
                                display: "inline-flex",
                                alignItems: "center"
                              }}
                            >
                              <Save size={13} />
                            </button>
                            <button
                              type="button"
                              onClick={handleCancelEdit}
                              title="Cancel"
                              style={{
                                padding: "4px 8px",
                                background: "#94a3b8",
                                color: "#ffffff",
                                border: "none",
                                borderRadius: "4px",
                                cursor: "pointer",
                                display: "inline-flex",
                                alignItems: "center"
                              }}
                            >
                              <X size={13} />
                            </button>
                          </div>
                        ) : (
                          <div style={{ display: "inline-flex", gap: "6px" }}>
                            <button
                              type="button"
                              onClick={() => handleStartEdit(row, row.originalIndex)}
                              title="Edit this camera"
                              style={{
                                padding: "4px 7px",
                                background: "#f1f5f9",
                                color: "#2563eb",
                                border: "1px solid #cbd5e1",
                                borderRadius: "4px",
                                cursor: "pointer",
                                display: "inline-flex",
                                alignItems: "center"
                              }}
                            >
                              <Edit2 size={12} />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteRow(row.originalIndex)}
                              title="Remove from batch"
                              style={{
                                padding: "4px 7px",
                                background: "#fee2e2",
                                color: "#dc2626",
                                border: "1px solid #fecaca",
                                borderRadius: "4px",
                                cursor: "pointer",
                                display: "inline-flex",
                                alignItems: "center"
                              }}
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* IMPORT SUBMIT FOOTER BAR */}
          <div className="csv-submit-deck">
            <div className="submit-info">
              {validationData.valid_count > 0 ? (
                <p>
                  <strong>{validationData.valid_count}</strong> cameras verified and ready for statewide GIS deployment.
                  {validationData.invalid_count > 0 && ` (${validationData.invalid_count} invalid rows will be skipped).`}
                </p>
              ) : (
                <p className="text-danger">
                  No valid camera records detected. Click the edit icon to fix row errors or add a new camera row.
                </p>
              )}
            </div>

            {importError && (
              <div className="import-error-banner">
                <AlertCircle size={16} />
                <span>{importError}</span>
              </div>
            )}

            <div className="submit-buttons">
              <button
                type="button"
                className="cancel-button"
                onClick={handleReset}
              >
                Reset / Cancel
              </button>

              <button
                type="button"
                className="primary-button"
                onClick={handleConfirmImport}
                disabled={isImporting || validationData.valid_count === 0}
              >
                {isImporting ? (
                  <>
                    <RefreshCw size={16} className="animate-spin" />
                    <span>Importing Cameras...</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={16} />
                    <span>Confirm & Import {validationData.valid_count} Cameras</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

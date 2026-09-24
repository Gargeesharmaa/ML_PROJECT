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
  ArrowRight
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

  // 4. Confirm & Bulk Import
  const handleConfirmImport = async () => {
    if (!selectedFile) return;

    setIsImporting(true);
    setImportError("");

    try {
      const formData = new FormData();
      formData.append("file", selectedFile);

      const response = await fetch("/api/cameras/bulk-import", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.detail || "Failed to import cameras");
      }

      setImportResult(data);
    } catch (err) {
      setImportError(err.message || "Bulk import failed. Please verify the CSV format.");
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
    setFilterMode("ALL");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // Filtered rows for table
  const filteredRows = (validationData?.rows || []).filter((r) => {
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
            <span>BULK ASSET REGISTRATION</span>
          </div>
          <h2>Bulk Camera Onboarding via CSV</h2>
          <p className="page-description">
            Register dozens or hundreds of CCTV assets across Gujarat government departments in a single upload.
          </p>
        </div>

        <button
          type="button"
          className="csv-template-btn"
          onClick={handleDownloadTemplate}
          title="Download pre-formatted CSV template"
        >
          <Download size={16} />
          <span>Download Sample Template</span>
        </button>
      </div>

      {/* SUCCESS BANNER WHEN IMPORT FINISHED */}
      {importResult && (
        <div className="csv-success-banner">
          <div className="success-header">
            <div className="success-badge-icon">
              <CheckCircle2 size={32} />
            </div>
            <div>
              <h3>Bulk Import Completed!</h3>
              <p>
                Successfully registered <strong>{importResult.imported_count}</strong> cameras into Gujarat Sentinel Registry.
              </p>
            </div>
          </div>

          <div className="import-kpi-row">
            <div className="kpi-pill success">
              <span>Imported Successfully</span>
              <strong>{importResult.imported_count}</strong>
            </div>
            <div className="kpi-pill skipped">
              <span>Skipped / Duplicates</span>
              <strong>{importResult.skipped_count}</strong>
            </div>
            <div className="kpi-pill total">
              <span>Total Processed</span>
              <strong>{importResult.total_rows}</strong>
            </div>
          </div>

          {importResult.skipped && importResult.skipped.length > 0 && (
            <div className="skipped-items-box">
              <p className="skipped-title">Skipped Entries / Duplicates:</p>
              <ul>
                {importResult.skipped.map((s, idx) => (
                  <li key={idx}>
                    <strong>{s.camera_code || `Row ${s.row}`}:</strong> {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="success-actions">
            <button
              type="button"
              className="primary-button"
              onClick={onNavigateToMap}
            >
              <MapPin size={17} />
              <span>View Imported Cameras on GIS Live Map</span>
              <ArrowRight size={16} />
            </button>

            <button
              type="button"
              className="secondary-button"
              onClick={handleReset}
            >
              Upload Another CSV File
            </button>
          </div>
        </div>
      )}

      {/* DROPZONE AREA (Shown if not yet imported) */}
      {!importResult && (
        <div
          className={`csv-dropzone ${dragActive ? "drag-active" : ""} ${selectedFile ? "has-file" : ""}`}
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          onClick={() => !selectedFile && fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
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
                <span>Headers: camera_code, dept_name, camera_type, ip_address, rtsp_url, latitude, longitude</span>
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
                <button
                  type="button"
                  className="remove-file-btn"
                  onClick={handleReset}
                >
                  Remove
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* VALIDATING SPINNER */}
      {isValidating && (
        <div className="csv-loading-state">
          <RefreshCw size={24} className="animate-spin text-primary" />
          <span>Analyzing CSV structure and validating camera fields...</span>
        </div>
      )}

      {/* VALIDATION ERROR BANNER */}
      {validationError && (
        <div className="csv-error-banner">
          <AlertTriangle size={20} />
          <div>
            <strong>Validation Error:</strong>
            <p>{validationError}</p>
          </div>
        </div>
      )}

      {/* PRE-FLIGHT VALIDATION PREVIEW TABLE */}
      {!importResult && validationData && (
        <div className="csv-preview-section">
          {/* STATS SUMMARY BAR */}
          <div className="preview-toolbar">
            <div className="validation-kpi-group">
              <span className="kpi-tag total">
                Total Rows: <strong>{validationData.total_rows}</strong>
              </span>
              <span className="kpi-tag valid">
                <Check size={14} /> Ready to Import: <strong>{validationData.valid_count}</strong>
              </span>
              {validationData.invalid_count > 0 && (
                <span className="kpi-tag error">
                  <AlertCircle size={14} /> Issues / Errors: <strong>{validationData.invalid_count}</strong>
                </span>
              )}
            </div>

            {/* FILTER BUTTONS */}
            <div className="preview-filter-buttons">
              <button
                type="button"
                className={`filter-btn ${filterMode === "ALL" ? "active" : ""}`}
                onClick={() => setFilterMode("ALL")}
              >
                All Rows ({validationData.total_rows})
              </button>
              <button
                type="button"
                className={`filter-btn ${filterMode === "VALID" ? "active" : ""}`}
                onClick={() => setFilterMode("VALID")}
              >
                Valid ({validationData.valid_count})
              </button>
              {validationData.invalid_count > 0 && (
                <button
                  type="button"
                  className={`filter-btn error ${filterMode === "ERROR" ? "active" : ""}`}
                  onClick={() => setFilterMode("ERROR")}
                >
                  Errors ({validationData.invalid_count})
                </button>
              )}
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
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr
                    key={row.row_number}
                    className={row.is_valid ? "row-valid" : "row-invalid"}
                  >
                    <td>{row.row_number}</td>
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
                    <td>
                      <strong className="code-text">{row.camera_code}</strong>
                    </td>
                    <td>{row.dept_name}</td>
                    <td>
                      <span className="type-pill">{row.camera_type}</span>
                    </td>
                    <td>
                      <code>{row.ip_address || "N/A"}</code>
                    </td>
                    <td className="stream-cell">
                      <span title={row.rtsp_url}>
                        {row.rtsp_url ? (row.rtsp_url.length > 28 ? row.rtsp_url.substring(0, 28) + "..." : row.rtsp_url) : "—"}
                      </span>
                    </td>
                    <td>
                      <span className="coords-text">
                        {row.latitude?.toFixed(4)}, {row.longitude?.toFixed(4)}
                      </span>
                    </td>
                    <td>
                      {row.is_valid ? (
                        <span className="note-ok">Passed verification</span>
                      ) : (
                        <span className="note-err" title={row.errors.join("; ")}>
                          {row.errors.join("; ")}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
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
                  No valid camera records detected. Please fix formatting errors in your CSV file.
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
                Cancel
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

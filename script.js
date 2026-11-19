// ==========================================
// CAMPUSCONNECT - MAIN JAVASCRIPT
// STUDENT | ADMINISTRATOR | ANALYST
// ==========================================

const API_BASE = "https://t7jsqlniysev7enb3elizqhe7a0hjezy.lambda-url.us-east-1.on.aws/";
const DEMO_MODE = false;

const $ = id => document.getElementById(id);

const views = [
  "dashboard",
  "analyst",
  "analystComplaints",
  "report",
  "complaints",
  "admin"
];

const viewTitles = {
  dashboard: "Dashboard",
  analyst: "Analyst Dashboard",
  analystComplaints: "All Complaints",
  report: "Report an Issue",
  complaints: "My Complaints",
  admin: "Admin Management"
};

let complaintsCache = [];
let analystComplaints = [];
let toastTimer;
let refreshInProgress = false;

const MAX_FILE_SIZE = 2 * 1024 * 1024;
const ALLOWED_FILE_TYPES = ["image/jpeg", "image/png"];

// ==========================================
// LOGIN SESSION
// ==========================================

function getLoggedInUser() {
  try {
    return JSON.parse(
      sessionStorage.getItem("campusUser") || "null"
    );
  } catch {
    return null;
  }
}

const campusToken = sessionStorage.getItem("campusToken");
const campusUser = getLoggedInUser();

const userRole = String(campusUser?.role || "").toLowerCase();
const userEmail = String(campusUser?.email || "").toLowerCase();

const isStudent = userRole === "student";
const isAdmin = userRole === "administrator";
const isAnalyst = userRole === "analyst";

if (
  !campusToken ||
  !campusUser ||
  !userEmail ||
  (!isStudent && !isAdmin && !isAnalyst)
) {
  window.location.href = "login.html";
}

// ==========================================
// COMMON HELPERS
// ==========================================

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

function formatDate(value) {
  if (!value) return "—";

  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
}

function displayStatus(status) {
  const value = String(status || "")
    .toLowerCase()
    .replace(/-/g, "_");

  if (value === "submitted" || value === "pending") {
    return "Pending";
  }

  if (
    value === "in progress" ||
    value === "in_progress" ||
    value === "under_review" ||
    value === "in_review"
  ) {
    return "In Progress";
  }

  if (value === "resolved" || value === "completed") {
    return "Completed";
  }

  if (value === "rejected") {
    return "Rejected";
  }

  return status || "Pending";
}

function statusValue(status) {
  const label = displayStatus(status);

  if (label === "In Progress") return "in_progress";
  if (label === "Completed") return "completed";
  if (label === "Rejected") return "rejected";

  return "pending";
}

function statusBadge(status) {
  const label = displayStatus(status);
  const cssClass = label.toLowerCase().replace(/\s+/g, "-");

  return `
    <span class="badge ${escapeHTML(cssClass)}">
      ${escapeHTML(label)}
    </span>
  `;
}

// ==========================================
// TOAST MESSAGE
// ==========================================

function showToast(message) {
  const toast = $("toast");

  if (!toast) {
    console.log(message);
    return;
  }

  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 5000);
}

// ==========================================
// ROLE-BASED WEBSITE ACCESS
// ==========================================

function configureRoleInterface() {

  document.querySelectorAll("[data-view], [data-go]").forEach(element => {

    const view = element.dataset.view || element.dataset.go;

    const allowed =
      ((isStudent || isAdmin) && view === "dashboard") ||
      (isAnalyst && ["analyst", "analystComplaints"].includes(view)) ||
      (isStudent && ["report", "complaints"].includes(view)) ||
      (isAdmin && view === "admin");

    element.hidden = !allowed;
    element.style.display = allowed ? "" : "none";
  });

  const dashboardPanel = $("dashboardView");

  if (dashboardPanel) {
    dashboardPanel.hidden = isAnalyst;
  }

  const analystPanel = $("analystView");

  if (analystPanel) {
    analystPanel.hidden = !isAnalyst;
  }

  const analystComplaintsPanel = $("analystComplaintsView");

  if (analystComplaintsPanel) {
    analystComplaintsPanel.hidden = !isAnalyst;
  }

  const adminPanel = $("adminView");

  if (adminPanel) {
    adminPanel.hidden = !isAdmin;
  }

  const reportPanel = $("reportView");

  if (reportPanel) {
    reportPanel.hidden = !isStudent;
  }

  const complaintsPanel = $("complaintsView");

  if (complaintsPanel) {
    complaintsPanel.hidden = !isStudent;
  }

  const dashboardHeading = document.querySelector(
    "#dashboardView h1"
  );

  if (dashboardHeading) {
    dashboardHeading.textContent = isAdmin
      ? "ADMINISTRATOR DASHBOARD"
      : "Welcome back 👋";
  }

  document.querySelectorAll(
    "#dashboardView .stats-grid .stat-card"
  ).forEach((card, index) => {
    card.hidden = isStudent && index !== 0;
  });

  if (isAnalyst) {
    showView("analyst");
  } else {
    showView("dashboard");
  }
}

// ==========================================
// USER PROFILE AND LOGOUT
// ==========================================

function setupProfileAndLogout() {

  const displayName = campusUser.full_name || userEmail;

  const roleNames = {
    student: "Student",
    administrator: "Administrator",
    analyst: "Analyst"
  };

  const profileName = $("profileName");
  const profileRole = $("profileRole");
  const profileAvatar = $("profileAvatar");
  const logoutButton = $("logoutButton");

  if (profileName) {
    profileName.textContent = displayName;
  }

  if (profileRole) {
    profileRole.textContent = roleNames[userRole] || "User";
  }

  if (profileAvatar) {
    const initials = displayName
      .trim()
      .split(/\s+/)
      .map(word => word[0])
      .slice(0, 2)
      .join("")
      .toUpperCase();

    profileAvatar.textContent = initials || "U";
  }

  if (logoutButton) {
    logoutButton.addEventListener("click", () => {

      sessionStorage.removeItem("campusToken");
      sessionStorage.removeItem("campusUser");
      sessionStorage.removeItem("campusTokenExpiry");

      window.location.href = "login.html";
    });
  }
}

// ==========================================
// API RESPONSE HELPERS
// ==========================================

function unwrapApiData(data) {

  if (!data || !data.body) {
    return data || {};
  }

  try {
    return typeof data.body === "string"
      ? JSON.parse(data.body)
      : data.body;

  } catch (error) {
    console.error("Could not parse Lambda response body:", error);
    return data;
  }
}

function extractComplaints(data) {

  if (Array.isArray(data)) return data;

  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.complaints)) return data.complaints;
  if (Array.isArray(data?.Items)) return data.Items;

  if (data?.body) {
    try {
      const body = typeof data.body === "string"
        ? JSON.parse(data.body)
        : data.body;

      return extractComplaints(body);

    } catch (error) {
      console.error("Could not read API response body:", error);
    }
  }

  return [];
}

// ==========================================
// AUTHENTICATED API REQUEST
// ==========================================

async function apiRequest(path, options = {}) {

  const base = API_BASE.endsWith("/")
    ? API_BASE
    : API_BASE + "/";

  const headers = {
    ...(options.headers || {}),
    "Authorization": `Bearer ${campusToken}`
  };

  let apiResponse;

  try {

    apiResponse = await fetch(
      base + path.replace(/^\/+/, ""),
      {
        ...options,
        headers
      }
    );

  } catch (error) {

    console.error("API network error:", error);

    throw new Error(
      "Could not connect to the server. Check your internet connection and Lambda CORS settings."
    );
  }

  const responseText = await apiResponse.text();

  let data = {};

  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new Error(
      "The server returned an invalid response. Check the Lambda response."
    );
  }

  const result = unwrapApiData(data);

  if (!apiResponse.ok) {

    if (apiResponse.status === 401) {

      sessionStorage.removeItem("campusToken");
      sessionStorage.removeItem("campusUser");
      sessionStorage.removeItem("campusTokenExpiry");

      showToast("Your session has expired. Please log in again.");

      setTimeout(() => {
        window.location.href = "login.html";
      }, 1200);
    }

    throw new Error(
      result.error ||
      result.message ||
      data.error ||
      `Request failed (${apiResponse.status})`
    );
  }

  return result;
}

// ==========================================
// NORMALIZE COMPLAINT
// ==========================================

function normalizeComplaint(item) {

  return {
    complaint_id: item.complaint_id || item.id || "",
    student_id: item.student_id || "",
    department: item.department || "",
    title: item.title || "Untitled Complaint",
    category: item.category || "Other",
    location: item.location || "Not specified",
    description: item.description || "",
    status: item.status || "submitted",
    created_at: item.created_at || item.createdAt || "",
    updated_at: item.updated_at || "",
    resolved_at: item.resolved_at || "",
    admin_remarks: item.admin_remarks || "",
    status_history: Array.isArray(item.status_history)
      ? item.status_history
      : [],
    attachment_key: item.attachment_key || ""
  };
}

// ==========================================
// STATUS HISTORY DISPLAY
// ==========================================

function renderStatusHistory(history) {

  if (!Array.isArray(history) || history.length === 0) {
    return `
      <p class="history-empty">
        No status updates have been recorded yet.
      </p>
    `;
  }

  return `
    <details class="status-history">

      <summary>
        View status history (${history.length})
      </summary>

      <ul>
        ${history.map(entry => `
          <li>

            <strong>
              ${escapeHTML(displayStatus(entry.status))}
            </strong>

            <span>
              ${escapeHTML(formatDate(
                entry.changed_at ||
                entry.updated_at ||
                entry.timestamp ||
                entry.created_at
              ))}
            </span>

            ${entry.remarks || entry.remark ? `
              <p>${escapeHTML(entry.remarks || entry.remark)}</p>
            ` : ""}

          </li>
        `).join("")}
      </ul>

    </details>
  `;
}

// ==========================================
// S3 IMAGE UPLOAD
// ==========================================

async function uploadAttachment(file) {

  if (!file) return "";

  if (!ALLOWED_FILE_TYPES.includes(file.type)) {
    throw new Error("Only JPG and PNG images are allowed.");
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new Error("Image size must not exceed 2 MB.");
  }

  showToast("Preparing image upload...");

  const uploadData = await apiRequest("upload-url", {
    method: "POST",

    headers: {
      "Content-Type": "application/json"
    },

    body: JSON.stringify({
      content_type: file.type,
      file_size: file.size
    })
  });

  const uploadUrl = uploadData.upload_url;
  const attachmentKey = uploadData.attachment_key;

  if (!uploadUrl || !attachmentKey) {
    throw new Error("Lambda did not return a valid upload URL.");
  }

  showToast("Uploading image...");

  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",

    headers: {
      "Content-Type": file.type
    },

    body: file
  });

  if (!uploadResponse.ok) {
    throw new Error(
      `S3 image upload failed (${uploadResponse.status}).`
    );
  }

  return attachmentKey;
}

// ==========================================
// LOAD COMPLAINTS FROM AWS LAMBDA
// ==========================================

async function loadComplaints() {

  let records = [];

  if (DEMO_MODE) {

    records = JSON.parse(
      localStorage.getItem("campusconnect_demo_complaints") || "[]"
    );

  } else {

    const data = await apiRequest("complaints");

    records = extractComplaints(data);
  }

  complaintsCache = records.map(normalizeComplaint);

  render();
}

// ==========================================
// ANALYST DASHBOARD AND ALL COMPLAINTS
// ==========================================

function renderAnalystDashboard(items) {

  if (!isAnalyst) return;

  analystComplaints = items;

  // ========================================
  // ANALYST STATISTICS
  // ========================================

  const total = items.length;

  const pending = items.filter(item =>
    displayStatus(item.status) === "Pending"
  ).length;

  const resolved = items.filter(item =>
    displayStatus(item.status) === "Completed"
  ).length;

  const underReview = items.filter(item =>
    displayStatus(item.status) === "In Progress"
  ).length;

  if ($("analystTotalCount")) {
    $("analystTotalCount").textContent = total;
  }

  if ($("analystPendingCount")) {
    $("analystPendingCount").textContent = pending;
  }

  if ($("analystResolvedCount")) {
    $("analystResolvedCount").textContent = resolved;
  }

  if ($("analystReviewCount")) {
    $("analystReviewCount").textContent = underReview;
  }

  // ========================================
  // DEPARTMENT-WISE COMPLAINTS
  // ========================================

  const departmentCounts = {};

  items.forEach(item => {

    const department = String(
      item.department || "Not recorded (older complaint)"
    ).trim();

    departmentCounts[department] =
      (departmentCounts[department] || 0) + 1;
  });

  const sortedDepartments = Object.entries(departmentCounts)
    .sort((a, b) => b[1] - a[1]);

  const departmentRows = $("departmentRows");
  const departmentEmpty = $("departmentEmpty");

  if (departmentRows) {

    departmentRows.innerHTML = sortedDepartments.map(
      ([department, count]) => `
        <tr>
          <td>${escapeHTML(department)}</td>
          <td><strong>${count}</strong></td>
        </tr>
      `
    ).join("");
  }

  if (departmentEmpty) {
    departmentEmpty.classList.toggle(
      "show",
      sortedDepartments.length === 0
    );
  }

  // ========================================
  // ALL COMPLAINTS TABLE
  // ========================================

  const complaintRows = $("analystComplaintRows");
  const complaintEmpty = $("analystComplaintEmpty");

  if (complaintRows) {

    complaintRows.innerHTML = items.map(item => {

      const complaintId = String(item.complaint_id || "");

      return `
        <tr>

          <td>${escapeHTML(complaintId)}</td>

          <td>${escapeHTML(item.title || "Untitled")}</td>

          <td>${escapeHTML(
            item.department || "Not recorded"
          )}</td>

          <td>${escapeHTML(item.category || "N/A")}</td>

          <td>${statusBadge(item.status)}</td>

          <td>
            <button
              type="button"
              class="button secondary"
              data-analyst-open="${escapeHTML(complaintId)}">
              View
            </button>
          </td>

        </tr>
      `;
    }).join("");
  }

  if (complaintEmpty) {
    complaintEmpty.classList.toggle(
      "show",
      items.length === 0
    );
  }

  // Open complaint details.

  if (complaintRows) {

    complaintRows.onclick = function(event) {

      const button = event.target.closest(
        "[data-analyst-open]"
      );

      if (!button) return;

      openAnalystComplaint(
        button.dataset.analystOpen
      );
    };
  }

  // Close complaint details.

  const closeButton = $("closeAnalystDetails");

  if (closeButton) {

    closeButton.onclick = function() {

      const details = $("analystComplaintDetails");

      if (details) {
        details.hidden = true;
      }
    };
  }
}

// ========================================
// OPEN ANALYST COMPLAINT DETAILS
// ========================================

function openAnalystComplaint(complaintId) {

  if (!isAnalyst) return;

  const complaint = analystComplaints.find(item =>
    String(item.complaint_id) === String(complaintId)
  );

  if (!complaint) {
    showToast("Complaint details not found.");
    return;
  }

  const details = $("analystComplaintDetails");
  const content = $("analystComplaintDetailsContent");

  if (!details || !content) return;

  const fields = [
    ["Complaint ID", complaint.complaint_id],
    ["Student ID", complaint.student_id],
    ["Department", complaint.department],
    ["Title", complaint.title],
    ["Category", complaint.category],
    ["Location", complaint.location],
    ["Description", complaint.description],
    ["Status", displayStatus(complaint.status)],
    ["Submitted On", formatDate(complaint.created_at)]
  ];

  const detailsHTML = fields.map(([label, value]) => `
    <div class="detail-item">
      <strong>${escapeHTML(label)}</strong>
      <p>${escapeHTML(
        value === undefined || value === null || value === ""
          ? "Not available"
          : String(value)
      )}</p>
    </div>
  `).join("");

  // STATUS HISTORY

  const history = Array.isArray(complaint.status_history)
    ? complaint.status_history
    : [];

  const historyHTML = history.length
    ? history.map(entry => `
        <div class="detail-item">

          <strong>
            ${escapeHTML(displayStatus(entry.status))}
          </strong>

          <p>
            ${escapeHTML(
              entry.remarks || entry.remark || "No remarks"
            )}
          </p>

          <small>
            ${escapeHTML(formatDate(
              entry.changed_at ||
              entry.updated_at ||
              entry.timestamp ||
              entry.created_at
            ))}
          </small>

        </div>
      `).join("")
    : "<p>No status history available.</p>";

  const selectedStatus = statusValue(complaint.status);

  content.innerHTML = `

    <div class="details-grid">
      ${detailsHTML}
    </div>

    <div class="panel">

      <h3>Status History</h3>

      ${historyHTML}

    </div>

    <div class="panel analyst-update-form">

      <h3>Update Complaint</h3>

      <label class="field">

        <span>Complaint Status</span>

        <select id="analystStatusSelect">

          <option value="pending"
            ${selectedStatus === "pending" ? "selected" : ""}>
            Pending
          </option>

          <option value="in_progress"
            ${selectedStatus === "in_progress" ? "selected" : ""}>
            In Progress
          </option>

          <option value="completed"
            ${selectedStatus === "completed" ? "selected" : ""}>
            Completed
          </option>

          <option value="rejected"
            ${selectedStatus === "rejected" ? "selected" : ""}>
            Rejected
          </option>

        </select>

      </label>

      <label class="field">

        <span>Analyst Remarks</span>

        <textarea
          id="analystRemarksInput"
          rows="3"
          maxlength="1000"
          placeholder="Write an update or resolution note..."
        >${escapeHTML(complaint.admin_remarks)}</textarea>

      </label>

      <button
        type="button"
        class="button primary"
        id="analystUpdateStatusButton"
        data-id="${escapeHTML(complaint.complaint_id)}">

        Update Status

      </button>

    </div>
  `;

  details.hidden = false;

  details.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

// ==========================================
// ANALYST UPDATE STATUS
// ==========================================

if ($("analystComplaintDetailsContent")) {

  $("analystComplaintDetailsContent").addEventListener(
    "click",
    async event => {

      const button = event.target.closest(
        "#analystUpdateStatusButton"
      );

      if (!button || !isAnalyst) return;

      const complaintId = button.dataset.id;

      const statusSelect = $("analystStatusSelect");
      const remarksInput = $("analystRemarksInput");

      if (!statusSelect) {
        showToast("Please select a complaint status.");
        return;
      }

      const status = statusSelect.value;

      const adminRemarks = remarksInput
        ? remarksInput.value.trim()
        : "";

      button.disabled = true;
      button.textContent = "Updating...";

      try {

        await apiRequest("update-status", {

          method: "POST",

          headers: {
            "Content-Type": "application/json"
          },

          body: JSON.stringify({
            complaint_id: complaintId,
            status: status,
            admin_remarks: adminRemarks
          })

        });

        showToast("Complaint updated successfully!");

        await loadComplaints();

        openAnalystComplaint(complaintId);

      } catch (error) {

        console.error(
          "Analyst status update failed:",
          error
        );

        showToast(
          "Status update failed: " + error.message
        );

        button.disabled = false;
        button.textContent = "Update Status";
      }
    }
  );
}

// ==========================================
// MAIN DASHBOARD RENDERING
// ==========================================

function render() {

  const items = [...complaintsCache].sort((a, b) => {

    return new Date(b.created_at || 0) -
      new Date(a.created_at || 0);
  });

  const pending = items.filter(
    item => displayStatus(item.status) === "Pending"
  ).length;

  const progress = items.filter(
    item => displayStatus(item.status) === "In Progress"
  ).length;

  const completed = items.filter(
    item => displayStatus(item.status) === "Completed"
  ).length;

  // STUDENT / ADMINISTRATOR STATISTICS

  if ($("totalCount")) {
    $("totalCount").textContent = items.length;
  }

  if ($("pendingCount")) {
    $("pendingCount").textContent = pending;
  }

  if ($("progressCount")) {
    $("progressCount").textContent = progress;
  }

  if ($("resolvedCount")) {
    $("resolvedCount").textContent = completed;
  }

  // RECENT COMPLAINTS

  if ($("recentRows")) {

    $("recentRows").innerHTML = items.slice(0, 5).map(item => `
      <tr>

        <td>

          <div class="complaint-title">
            ${escapeHTML(item.title)}
          </div>

          <div class="complaint-id">
            ID: ${escapeHTML(item.complaint_id || "—")}
          </div>

        </td>

        <td>${escapeHTML(item.category)}</td>

        <td>${formatDate(item.created_at)}</td>

        <td>${statusBadge(item.status)}</td>

      </tr>
    `).join("");
  }

  if ($("recentEmpty")) {

    $("recentEmpty").classList.toggle(
      "show",
      items.length === 0
    );
  }

  // STUDENT COMPLAINT FILTER

  const filter = $("statusFilter")
    ? $("statusFilter").value
    : "All";

  const filtered = filter === "All"
    ? items
    : items.filter(
        item => displayStatus(item.status) === filter
      );

  // ========================================
  // STUDENT: MY COMPLAINTS
  // ========================================

  if ($("allComplaints")) {

    $("allComplaints").innerHTML = isStudent
      ? filtered.map(item => `

        <article class="complaint-card">

          <div class="complaint-card-top">

            <div class="complaint-card-heading">

              <h3>${escapeHTML(item.title)}</h3>

              <span class="complaint-id">
                ID: ${escapeHTML(item.complaint_id || "—")}
              </span>

            </div>

            ${statusBadge(item.status)}

          </div>

          <div class="complaint-details">

            <div class="complaint-detail">
              <span class="detail-label">Category</span>
              <strong>${escapeHTML(item.category)}</strong>
            </div>

            <div class="complaint-detail">
              <span class="detail-label">Location</span>
              <strong>${escapeHTML(item.location)}</strong>
            </div>

            <div class="complaint-detail">
              <span class="detail-label">Date submitted</span>
              <strong>${formatDate(item.created_at)}</strong>
            </div>

          </div>

          <div class="complaint-description">

            <span class="detail-label">Description</span>

            <p>
              ${escapeHTML(
                item.description || "No description provided."
              )}
            </p>

          </div>

          ${item.attachment_key ? `
            <div class="complaint-attachment">
              <span class="detail-label">Attachment</span>
              <strong>Image uploaded</strong>
            </div>
          ` : ""}

          <div class="complaint-description">

            <span class="detail-label">
              Latest administrator remarks
            </span>

            <p>
              ${escapeHTML(
                item.admin_remarks || "No administrator remarks yet."
              )}
            </p>

          </div>

          <div class="complaint-description">

            <span class="detail-label">Last updated</span>

            <p>
              ${formatDate(item.updated_at || item.created_at)}
            </p>

          </div>

          ${renderStatusHistory(item.status_history)}

        </article>

      `).join("")
      : "";
  }

  if ($("allEmpty")) {

    $("allEmpty").classList.toggle(
      "show",
      isStudent && filtered.length === 0
    );
  }

  // ADMINISTRATOR COMPLAINT MANAGEMENT

  renderAdminComplaints(items);

  // ANALYST DASHBOARD AND ALL COMPLAINTS

  renderAnalystDashboard(items);
}

// ==========================================
// ADMIN COMPLAINT MANAGEMENT
// ==========================================

function renderAdminComplaints(items) {

  const container = $("adminComplaints");

  if (!container) return;

  if (!isAdmin) {

    container.innerHTML = "";

    if ($("adminEmpty")) {
      $("adminEmpty").classList.remove("show");
    }

    return;
  }

  container.innerHTML = items.map(item => {

    const selectedStatus = statusValue(item.status);

    return `

      <article class="complaint-card admin-card">

        <div class="complaint-card-top">

          <div class="complaint-card-heading">

            <h3>${escapeHTML(item.title)}</h3>

            <span class="complaint-id">
              ID: ${escapeHTML(item.complaint_id)}
            </span>

          </div>

          ${statusBadge(item.status)}

        </div>

        <div class="complaint-details">

          <div class="complaint-detail">
            <span class="detail-label">Student Email</span>
            <strong>${escapeHTML(item.student_id || "—")}</strong>
          </div>

          <div class="complaint-detail">
            <span class="detail-label">Category</span>
            <strong>${escapeHTML(item.category)}</strong>
          </div>

          <div class="complaint-detail">
            <span class="detail-label">Location</span>
            <strong>${escapeHTML(item.location)}</strong>
          </div>

          <div class="complaint-detail">
            <span class="detail-label">Date submitted</span>
            <strong>${formatDate(item.created_at)}</strong>
          </div>

        </div>

        <div class="complaint-description">

          <span class="detail-label">Description</span>

          <p>${escapeHTML(item.description)}</p>

        </div>

        ${item.attachment_key ? `
          <div class="complaint-attachment">
            <span class="detail-label">Attachment</span>
            <strong>Image uploaded</strong>
          </div>
        ` : ""}

        <div class="admin-update-form">

          <label class="field">

            <span>Update complaint status</span>

            <select
              class="admin-status"
              data-id="${escapeHTML(item.complaint_id)}"
            >

              <option value="pending"
                ${selectedStatus === "pending" ? "selected" : ""}>
                Pending
              </option>

              <option value="in_progress"
                ${selectedStatus === "in_progress" ? "selected" : ""}>
                In Progress
              </option>

              <option value="completed"
                ${selectedStatus === "completed" ? "selected" : ""}>
                Completed
              </option>

              <option value="rejected"
                ${selectedStatus === "rejected" ? "selected" : ""}>
                Rejected
              </option>

            </select>

          </label>

          <label class="field">

            <span>Admin remarks</span>

            <textarea
              class="admin-remarks"
              data-id="${escapeHTML(item.complaint_id)}"
              rows="2"
              maxlength="1000"
              placeholder="Write an update or resolution note..."
            >${escapeHTML(item.admin_remarks)}</textarea>

          </label>

          <button
            type="button"
            class="button primary admin-update-button"
            data-id="${escapeHTML(item.complaint_id)}"
          >
            Update Status
          </button>

        </div>

        ${renderStatusHistory(item.status_history)}

      </article>

    `;
  }).join("");

  if ($("adminEmpty")) {

    $("adminEmpty").classList.toggle(
      "show",
      items.length === 0
    );
  }
}

// ==========================================
// ADMIN UPDATE STATUS
// ==========================================

if ($("adminComplaints")) {

  $("adminComplaints").addEventListener("click", async event => {

    const button = event.target.closest(".admin-update-button");

    if (!button || !isAdmin) return;

    const complaintId = button.dataset.id;

    const statusSelect = $("adminComplaints").querySelector(
      `.admin-status[data-id="${CSS.escape(complaintId)}"]`
    );

    const remarksInput = $("adminComplaints").querySelector(
      `.admin-remarks[data-id="${CSS.escape(complaintId)}"]`
    );

    if (!statusSelect) {
      showToast("Could not find the selected complaint.");
      return;
    }

    const status = statusSelect.value;

    const adminRemarks = remarksInput
      ? remarksInput.value.trim()
      : "";

    button.disabled = true;
    button.textContent = "Updating...";

    try {

      await apiRequest("update-status", {

        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          complaint_id: complaintId,
          status: status,
          admin_remarks: adminRemarks
        })

      });

      showToast("Complaint status updated successfully!");

      await loadComplaints();

    } catch (error) {

      console.error("Status update failed:", error);

      showToast("Status update failed: " + error.message);

      button.disabled = false;
      button.textContent = "Update Status";
    }
  });
}

// ==========================================
// NAVIGATION
// ==========================================

function showView(name) {

  const allowed =
    ((isStudent || isAdmin) && name === "dashboard") ||
    (isAnalyst && ["analyst", "analystComplaints"].includes(name)) ||
    (isStudent && ["report", "complaints"].includes(name)) ||
    (isAdmin && name === "admin");

  if (!allowed || !views.includes(name)) {
    return;
  }

  views.forEach(view => {

    const section = $(view + "View");

    if (section) {

      const active = view === name;

      section.classList.toggle("active", active);
      section.hidden = !active;
    }
  });

  document.querySelectorAll(".nav-link").forEach(button => {

    button.classList.toggle(
      "active",
      button.dataset.view === name
    );
  });

  if ($("breadcrumbTitle")) {
    $("breadcrumbTitle").textContent = viewTitles[name];
  }

  if ($("sidebar")) {
    $("sidebar").classList.remove("open");
  }

  if (
    name === "dashboard" ||
    name === "analyst" ||
    name === "analystComplaints" ||
    name === "complaints" ||
    name === "admin"
  ) {
    refreshData();
  }
}

// ==========================================
// REFRESH DATA
// ==========================================

async function refreshData() {

  if (refreshInProgress) return;

  refreshInProgress = true;

  try {

    await loadComplaints();

  } catch (error) {

    console.error("Loading complaints failed:", error);

    showToast(
      "Unable to load complaints: " + error.message
    );

  } finally {

    refreshInProgress = false;
  }
}

// ==========================================
// NAVIGATION BUTTONS
// ==========================================

document.querySelectorAll("[data-view], [data-go]").forEach(button => {

  button.addEventListener("click", () => {

    showView(
      button.dataset.view || button.dataset.go
    );

  });
});

// ==========================================
// MOBILE MENU
// ==========================================

if ($("menuToggle")) {

  $("menuToggle").addEventListener("click", () => {

    if ($("sidebar")) {
      $("sidebar").classList.toggle("open");
    }

  });
}

// ==========================================
// COMPLAINT FILTER
// ==========================================

if ($("statusFilter")) {

  $("statusFilter").addEventListener("change", render);

}

// ==========================================
// ADMIN REFRESH
// ==========================================

if ($("refreshAdmin")) {

  $("refreshAdmin").addEventListener("click", refreshData);

}

// ==========================================
// ANALYST REFRESH
// ==========================================

if ($("refreshAnalyst")) {

  $("refreshAnalyst").addEventListener("click", async () => {

    showToast("Refreshing analyst statistics...");

    await refreshData();

  });

}

// ==========================================
// ANALYST ALL COMPLAINTS REFRESH
// ==========================================

if ($("refreshAnalystComplaints")) {

  $("refreshAnalystComplaints").addEventListener(
    "click",
    async () => {

      showToast("Refreshing all complaints...");

      await refreshData();

    }
  );
}

// ==========================================
// IMAGE VALIDATION
// ==========================================

if ($("attachment")) {

  $("attachment").addEventListener("change", event => {

    const file = event.target.files[0];

    if (!file) {

      if ($("fileHint")) {
        $("fileHint").textContent =
          "JPG or PNG only. Maximum size 2 MB.";
      }

      return;
    }

    const validType = ALLOWED_FILE_TYPES.includes(file.type);
    const validSize = file.size <= MAX_FILE_SIZE;

    if (!validType || !validSize) {

      event.target.value = "";

      if ($("fileHint")) {
        $("fileHint").textContent =
          "Choose a JPG or PNG file up to 2 MB.";
      }

      showToast("Choose a JPG or PNG file up to 2 MB.");

    } else if ($("fileHint")) {

      $("fileHint").textContent =
        `${file.name} selected. Ready to upload.`;
    }

  });
}

// ==========================================
// STUDENT: SUBMIT COMPLAINT
// ==========================================

if ($("complaintForm")) {

  $("complaintForm").addEventListener("submit", async event => {

    event.preventDefault();

    if (!isStudent) {

      showToast("Only students can submit complaints.");

      return;
    }

    const form = event.currentTarget;

    if (!form.reportValidity()) return;

    const formData = new FormData(form);

    const selectedFile = $("attachment")
      ? $("attachment").files[0]
      : null;

    const payload = {

      title: String(formData.get("title") || "").trim(),

      category: String(formData.get("category") || "").trim(),

      location: String(formData.get("location") || "").trim(),

      description: String(formData.get("description") || "").trim(),

      attachment_key: ""
    };

    if (selectedFile) {

      const validType = ALLOWED_FILE_TYPES.includes(selectedFile.type);
      const validSize = selectedFile.size <= MAX_FILE_SIZE;

      if (!validType || !validSize) {

        showToast("Choose a JPG or PNG file up to 2 MB.");

        return;
      }
    }

    // DEMO MODE

    if (DEMO_MODE) {

      const list = JSON.parse(
        localStorage.getItem("campusconnect_demo_complaints") || "[]"
      );

      list.push({

        ...payload,

        student_id: userEmail,

        complaint_id: "CC-" + Date.now(),

        status: "submitted",

        created_at: new Date().toISOString(),

        updated_at: new Date().toISOString(),

        admin_remarks: "",

        status_history: []

      });

      localStorage.setItem(
        "campusconnect_demo_complaints",
        JSON.stringify(list)
      );

      complaintsCache = list.map(normalizeComplaint);

      form.reset();

      render();

      showView("complaints");

      showToast("Demo complaint saved.");

      return;
    }

    // LIVE AWS MODE

    try {

      if (selectedFile) {

        payload.attachment_key =
          await uploadAttachment(selectedFile);
      }

      showToast("Submitting complaint...");

      await apiRequest("complaints", {

        method: "POST",

        headers: {
          "Content-Type": "application/json"
        },

        body: JSON.stringify(payload)

      });

      form.reset();

      if ($("fileHint")) {

        $("fileHint").textContent =
          "JPG or PNG only. Maximum size 2 MB.";
      }

      await loadComplaints();

      showView("complaints");

      showToast(
        selectedFile
          ? "Complaint and image submitted successfully!"
          : "Complaint submitted successfully!"
      );

    } catch (error) {

      console.error("Complaint submission failed:", error);

      showToast(
        "Submission failed: " + error.message
      );
    }

  });
}

// ==========================================
// AUTOMATIC STUDENT COMPLAINT REFRESH
// ==========================================

if (isStudent && campusToken) {

  setInterval(() => {

    const complaintsPage = $("complaintsView");

    if (
      complaintsPage &&
      complaintsPage.classList.contains("active")
    ) {
      refreshData();
    }

  }, 15000);
}

// ==========================================
// INITIALIZE WEBSITE
// ==========================================

setupProfileAndLogout();

configureRoleInterface();

render();
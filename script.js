const API_BASE = "https://t7jsqlniysev7enb3elizqhe7a0hjezy.lambda-url.us-east-1.on.aws/";
const DEMO_MODE = false;

const $ = id => document.getElementById(id);

const views = ["dashboard", "report", "complaints", "admin"];

const viewTitles = {
  dashboard: "Dashboard",
  report: "Report an Issue",
  complaints: "My Complaints",
  admin: "Admin Management"
};

let complaintsCache = [];
let toastTimer;

const MAX_FILE_SIZE = 2 * 1024 * 1024;
const ALLOWED_FILE_TYPES = ["image/jpeg", "image/png"];

// ==========================================
// LOGIN SESSION
// ==========================================

function getLoggedInUser() {
  try {
    return JSON.parse(sessionStorage.getItem("campusUser") || "null");
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

if (
  !campusToken ||
  !campusUser ||
  !userEmail ||
  (!isStudent && !isAdmin)
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

  if (value === "submitted" || value === "pending") return "Pending";
  if (value === "in progress" || value === "in_progress") return "In Progress";
  if (value === "resolved" || value === "completed") return "Completed";
  if (value === "rejected") return "Rejected";

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

  return `<span class="badge ${escapeHTML(cssClass)}">${escapeHTML(label)}</span>`;
}

// ==========================================
// ROLE-BASED WEBSITE ACCESS
// ==========================================

function configureRoleInterface() {
  // Control sidebar menu visibility based on user role.
  document.querySelectorAll("[data-view], [data-go]").forEach(element => {
    const view = element.dataset.view || element.dataset.go;

    const allowed =
      view === "dashboard" ||
      (isStudent && ["report", "complaints"].includes(view)) ||
      (isAdmin && view === "admin");

    element.hidden = !allowed;
  });

  // Control Admin Management panel.
  const adminPanel = document.getElementById("adminView");
  if (adminPanel) {
    adminPanel.hidden = !isAdmin;
  }

  // Control student-only panels.
  const reportPanel = document.getElementById("reportView");
  if (reportPanel) {
    reportPanel.hidden = !isStudent;
  }

  const complaintsPanel = document.getElementById("complaintsView");
  if (complaintsPanel) {
    complaintsPanel.hidden = !isStudent;
  }

  // Display the correct dashboard heading.
  const dashboardHeading = document.querySelector(
    "#dashboardView h1, #dashboardView h2"
  );

  if (dashboardHeading) {
    dashboardHeading.textContent = isAdmin
      ? "ADMINISTRATOR DASHBOARD"
      : "STUDENT DASHBOARD";
  }

  // Open the dashboard after applying role permissions.
  showView("dashboard");
}


  // Update the profile name if the existing profile elements are present.
  const profileName = document.querySelector(
    ".profile-name, #profileName"
  );

  if (profileName) {
    profileName.textContent = campusUser.full_name || userEmail;
  }

  const profileRole = document.querySelector(
    ".profile-role, #profileRole"
  );

  if (profileRole) {
    profileRole.textContent = isAdmin ? "Administrator" : "Student";
  }

  // Show only Total Complaints to students.
const statisticCards = document.querySelectorAll(
  "#dashboardView .stats-grid .stat-card"
);

statisticCards.forEach((card, index) => {
  card.hidden = isStudent && index !== 0;
});

  // Start with the dashboard.
  showView("dashboard");
  

// ==========================================
// API RESPONSE HELPERS
// ==========================================

function unwrapApiData(data) {
  if (!data || !data.body) return data || {};

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

  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.complaints)) return data.complaints;
  if (Array.isArray(data.Items)) return data.Items;

  if (data.body) {
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
  const base = API_BASE.endsWith("/") ? API_BASE : API_BASE + "/";

  const headers = {
    ...(options.headers || {}),
    "Authorization": `Bearer ${campusToken}`
  };

  const apiResponse = await fetch(
    base + path.replace(/^\/+/, ""),
    {
      ...options,
      headers
    }
  );

  const data = await apiResponse.json().catch(() => ({}));
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
// LOAD COMPLAINTS
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
// DASHBOARD RENDERING
// ==========================================

function render() {
  const items = [...complaintsCache].sort((a, b) => {
    return new Date(b.created_at || 0) -
      new Date(a.created_at || 0);
  });

  const pending = items.filter(
    x => displayStatus(x.status) === "Pending"
  ).length;

  const progress = items.filter(
    x => displayStatus(x.status) === "In Progress"
  ).length;

  const completed = items.filter(
    x => displayStatus(x.status) === "Completed"
  ).length;

  if ($("totalCount")) $("totalCount").textContent = items.length;
  if ($("pendingCount")) $("pendingCount").textContent = pending;
  if ($("progressCount")) $("progressCount").textContent = progress;
  if ($("resolvedCount")) $("resolvedCount").textContent = completed;

  // Recent complaints
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

  // Student complaint filter
  const filter = $("statusFilter")
    ? $("statusFilter").value
    : "All";

  const filtered = filter === "All"
    ? items
    : items.filter(
        item => displayStatus(item.status) === filter
      );

  // My Complaints - students only
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
            <p>${escapeHTML(item.description || "No description provided.")}</p>
          </div>

          ${item.attachment_key ? `
            <div class="complaint-attachment">
              <span class="detail-label">Attachment</span>
              <strong>Image uploaded</strong>
            </div>
          ` : ""}

          ${item.admin_remarks ? `
            <div class="complaint-description">
              <span class="detail-label">Latest admin remarks</span>
              <p>${escapeHTML(item.admin_remarks)}</p>
            </div>
          ` : ""}

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

  // Administrator complaint management
  renderAdminComplaints(items);
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
            class="button primary admin-update-button"
            data-id="${escapeHTML(item.complaint_id)}"
          >
            Update Status
          </button>

        </div>

        ${item.status_history.length ? `
          <details class="status-history">

            <summary>
              View status history (${item.status_history.length})
            </summary>

            <ul>
              ${item.status_history.map(entry => `
                <li>
                  <strong>
                    ${escapeHTML(displayStatus(entry.status))}
                  </strong>

                  <span>${formatDate(entry.changed_at)}</span>

                  ${entry.remarks
                    ? `<p>${escapeHTML(entry.remarks)}</p>`
                    : ""}
                </li>
              `).join("")}
            </ul>

          </details>
        ` : ""}

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
    name === "dashboard" ||
    (isStudent && ["report", "complaints"].includes(name)) ||
    (isAdmin && name === "admin");

  if (!allowed || !views.includes(name)) return;

  views.forEach(view => {

    const section = $(view + "View");

    if (section) {
      section.classList.toggle("active", view === name);
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

  try {

    await loadComplaints();

  } catch (error) {

    console.error("Loading complaints failed:", error);

    showToast("Unable to load complaints: " + error.message);
  }
}

// ==========================================
// NAVIGATION BUTTONS
// ==========================================

document.querySelectorAll("[data-view], [data-go]").forEach(button => {

  button.addEventListener("click", () => {

    showView(button.dataset.view || button.dataset.go);

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

    try {

      if (selectedFile) {
        payload.attachment_key = await uploadAttachment(selectedFile);
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

      showToast("Submission failed: " + error.message);

    }
  });
}

// ==========================================
// TOAST MESSAGE
// ==========================================

function showToast(message) {

  const toast = $("toast");

  if (!toast) return;

  toast.textContent = message;

  toast.classList.add("show");

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 5000);
}

// ==========================================
// INITIALIZE WEBSITE
// ==========================================

configureRoleInterface();

render();

if (API_BASE && !DEMO_MODE && campusToken) {
  refreshData();
}

// ==========================================
// USER PROFILE AND LOGOUT
// ==========================================

(function setupProfileAndLogout() {

  const user = JSON.parse(
    sessionStorage.getItem("campusUser") || "{}"
  );

  const role = (user.role || "").toLowerCase();

  const roleNames = {
    student: "Student",
    administrator: "Administrator",
    analyst: "Analyst"
  };

  const displayName = user.full_name || "User";

  const profileName = document.getElementById("profileName");
  const profileRole = document.getElementById("profileRole");
  const profileAvatar = document.getElementById("profileAvatar");
  const logoutButton = document.getElementById("logoutButton");

  // Display logged-in user's name.
  if (profileName) {
    profileName.textContent = displayName;
  }

  // Display the correct role.
  if (profileRole) {
    profileRole.textContent = roleNames[role] || "User";
  }

  // Generate initials from the user's name.
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

  // Logout functionality.
  if (logoutButton) {
    logoutButton.addEventListener("click", function () {

      sessionStorage.removeItem("campusToken");
      sessionStorage.removeItem("campusUser");
      sessionStorage.removeItem("campusTokenExpiry");

      window.location.href = "login.html";

    });
  }

})();
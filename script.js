/*
 * CampusConnect cloud frontend
 * AWS Lambda + DynamoDB integration
 */

const API_BASE =
  "https://t7jsqlniysev7enb3elizqhe7a0hjezy.lambda-url.us-east-1.on.aws/";

const DEMO_MODE = false;

const views = ["dashboard", "report", "complaints"];

const viewTitles = {
  dashboard: "Dashboard",
  report: "Report an Issue",
  complaints: "My Complaints"
};

const $ = (id) => document.getElementById(id);

let complaintsCache = [];
let toastTimer;
let loadingComplaints = false;

/* Escape HTML safely */
function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

/* Format date */
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

/* Status helpers */
function displayStatus(status) {
  const normalized = String(status || "").toLowerCase();

  if (normalized === "submitted" || normalized === "pending") {
    return "Pending";
  }

  if (normalized === "in progress" || normalized === "in_progress") {
    return "In Progress";
  }

  if (normalized === "resolved") {
    return "Resolved";
  }

  return status || "Pending";
}

function statusClass(status) {
  return String(status || "pending")
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function statusBadge(status) {
  const safeStatus = displayStatus(status);

  return `
    <span class="badge ${escapeHTML(statusClass(safeStatus))}">
      ${escapeHTML(safeStatus)}
    </span>
  `;
}

/* Complaint title and ID */
function complaintCell(item) {
  return `
    <div class="complaint-title">
      ${escapeHTML(item.title || "Untitled Complaint")}
    </div>
    <div class="complaint-id">
      ID: ${escapeHTML(item.complaint_id || item.id || "—")}
    </div>
  `;
}

/* Normalize complaint data */
function normalizeComplaint(item) {
  return {
    complaint_id: item.complaint_id || item.id || "",
    title: item.title || "Untitled Complaint",
    category: item.category || "Other",
    location: item.location || "Not specified",
    description: item.description || "",
    priority: String(item.priority || "medium").toLowerCase(),
    status: item.status || "submitted",
    created_at: item.created_at || item.createdAt || ""
  };
}

/* Get complaints from different possible API formats */
function extractComplaints(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data.items)) {
    return data.items;
  }

  if (Array.isArray(data.complaints)) {
    return data.complaints;
  }

  if (Array.isArray(data.Items)) {
    return data.Items;
  }

  return [];
}

/* API configuration */
function requireApiBase() {
  if (!API_BASE.trim()) {
    throw new Error("AWS API URL is not configured.");
  }
}

/* API request */
async function apiRequest(path, options = {}) {
  requireApiBase();

  const base = API_BASE.endsWith("/")
    ? API_BASE
    : API_BASE + "/";

  const response = await fetch(
    base + path.replace(/^\/+/, ""),
    {
      ...options,
      headers: {
        ...(options.headers || {})
      }
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.error || `Request failed (${response.status})`
    );
  }

  return data;
}

/* Load complaints from AWS */
async function loadComplaints() {
  if (loadingComplaints) return;

  loadingComplaints = true;

  try {
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

  } finally {
    loadingComplaints = false;
  }
}

/* Render dashboard and complaint tables */
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

  const resolved = items.filter(
    item => displayStatus(item.status) === "Resolved"
  ).length;

  if ($("totalCount")) {
    $("totalCount").textContent = items.length;
    $("pendingCount").textContent = pending;
    $("progressCount").textContent = progress;
    $("resolvedCount").textContent = resolved;
  }

  /* Recent complaints */
  if ($("recentRows")) {
    $("recentRows").innerHTML = items
      .slice(0, 5)
      .map(item => `
        <tr>
          <td>${complaintCell(item)}</td>
          <td>${escapeHTML(item.category)}</td>
          <td>${formatDate(item.created_at)}</td>
          <td>${statusBadge(item.status)}</td>
        </tr>
      `)
      .join("");
  }

  if ($("recentEmpty")) {
    $("recentEmpty").classList.toggle(
      "show",
      items.length === 0
    );
  }

  /* Filter complaints */
  const filter = $("statusFilter")
    ? $("statusFilter").value
    : "All";

  const filtered = filter === "All"
    ? items
    : items.filter(
        item => displayStatus(item.status) === filter
      );

  /* All complaints */
  if ($("allRows")) {
    $("allRows").innerHTML = filtered
      .map(item => `
        <tr>
          <td>${complaintCell(item)}</td>
          <td>${escapeHTML(item.category)}</td>
          <td>${escapeHTML(item.location)}</td>
          <td>${formatDate(item.created_at)}</td>
          <td>
            <span class="priority ${escapeHTML(item.priority)}">
              ${escapeHTML(item.priority)}
            </span>
          </td>
          <td>${statusBadge(item.status)}</td>
        </tr>
      `)
      .join("");
  }

  if ($("allEmpty")) {
    $("allEmpty").classList.toggle(
      "show",
      filtered.length === 0
    );
  }
}

/* Change page */
function showView(name) {
  if (!views.includes(name)) return;

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

  if (name === "dashboard" || name === "complaints") {
    refreshData();
  }
}

/* Refresh data */
async function refreshData() {
  try {
    await loadComplaints();
  } catch (error) {
    console.error("Complaint loading error:", error);
    showToast("Unable to load complaints: " + error.message);
  }
}

/* Navigation */
document.querySelectorAll("[data-view], [data-go]")
  .forEach(button => {
    button.addEventListener("click", () => {
      showView(button.dataset.view || button.dataset.go);
    });
  });

/* Sidebar */
if ($("menuToggle")) {
  $("menuToggle").addEventListener("click", () => {
    $("sidebar").classList.toggle("open");
  });
}

/* Status filter */
if ($("statusFilter")) {
  $("statusFilter").addEventListener("change", render);
}

/* Attachment validation */
if ($("attachment")) {
  $("attachment").addEventListener("change", event => {
    const file = event.target.files[0];

    if (!file) {
      $("fileHint").textContent =
        "JPG or PNG only. Cloud S3 upload flow is a separate next step.";
      return;
    }

    const validType = [
      "image/jpeg",
      "image/png"
    ].includes(file.type);

    const validSize = file.size <= 2 * 1024 * 1024;

    if (!validType || !validSize) {
      event.target.value = "";

      $("fileHint").textContent =
        "Choose a JPG or PNG file up to 2 MB.";

      showToast("Choose a JPG or PNG file up to 2 MB.");
    } else {
      $("fileHint").textContent =
        `${file.name} selected. Photo upload to S3 is not enabled yet.`;
    }
  });
}

/* Submit complaint */
if ($("complaintForm")) {
  $("complaintForm").addEventListener("submit", async event => {
    event.preventDefault();

    const form = event.currentTarget;

    if (!form.reportValidity()) return;

    const data = new FormData(form);

    const payload = {
      student_id: "student-demo-01",
      title: String(data.get("title") || "").trim(),
      category: String(data.get("category") || "").trim(),
      location: String(data.get("location") || "").trim(),
      description: String(data.get("description") || "").trim(),
      priority: String(data.get("priority") || "medium").toLowerCase()
    };

    if (DEMO_MODE) {
      const list = JSON.parse(
        localStorage.getItem("campusconnect_demo_complaints") || "[]"
      );

      list.push({
        ...payload,
        complaint_id: "CC-" + Date.now(),
        status: "submitted",
        created_at: new Date().toISOString()
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
          "JPG or PNG only. Cloud S3 upload is not enabled yet.";
      }

      await loadComplaints();

      showView("complaints");

      showToast("Complaint submitted successfully!");

    } catch (error) {
      console.error("Complaint submission error:", error);
      showToast("Submission failed: " + error.message);
    }
  });
}

/* Toast message */
function showToast(message) {
  const toast = $("toast");

  if (!toast) return;

  toast.textContent = message;
  toast.classList.add("show");

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
  }, 4000);
}

/* Initial page load */
render();

if (API_BASE && !DEMO_MODE) {
  refreshData();
}
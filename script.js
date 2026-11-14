
const API_BASE = "https://t7jsqlniysev7enb3elizqhe7a0hjezy.lambda-url.us-east-1.on.aws/";
const DEMO_MODE = false;

const views = ["dashboard", "report", "complaints"];

const viewTitles = {
  dashboard: "Dashboard",
  report: "Report an Issue",
  complaints: "My Complaints"
};

const $ = id => document.getElementById(id);

let complaintsCache = [];
let toastTimer;

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
  const value = String(status || "").toLowerCase();

  if (value === "submitted" || value === "pending") return "Pending";
  if (value === "in progress" || value === "in_progress") return "In Progress";
  if (value === "resolved") return "Resolved";

  return status || "Pending";
}

function statusBadge(status) {
  const label = displayStatus(status);
  const cssClass = label.toLowerCase().replace(/\s+/g, "-");

  return `<span class="badge ${escapeHTML(cssClass)}">${escapeHTML(label)}</span>`;
}

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

async function apiRequest(path, options = {}) {
  const base = API_BASE.endsWith("/") ? API_BASE : API_BASE + "/";

  const response = await fetch(base + path.replace(/^\/+/, ""), {
    ...options,
    headers: {
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }

  return data;
}

/* Load complaints from AWS */
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

/* Dashboard and complaints rendering */
function render() {
  const items = [...complaintsCache].sort((a, b) => {
    return new Date(b.created_at || 0) - new Date(a.created_at || 0);
  });

  const pending = items.filter(x => displayStatus(x.status) === "Pending").length;
  const progress = items.filter(x => displayStatus(x.status) === "In Progress").length;
  const resolved = items.filter(x => displayStatus(x.status) === "Resolved").length;

  if ($("totalCount")) $("totalCount").textContent = items.length;
  if ($("pendingCount")) $("pendingCount").textContent = pending;
  if ($("progressCount")) $("progressCount").textContent = progress;
  if ($("resolvedCount")) $("resolvedCount").textContent = resolved;

  /* Recent complaints table */
  if ($("recentRows")) {
    $("recentRows").innerHTML = items.slice(0, 5).map(item => `
      <tr>
        <td>
          <div class="complaint-title">${escapeHTML(item.title)}</div>
          <div class="complaint-id">ID: ${escapeHTML(item.complaint_id || "—")}</div>
        </td>
        <td>${escapeHTML(item.category)}</td>
        <td>${formatDate(item.created_at)}</td>
        <td>${statusBadge(item.status)}</td>
      </tr>
    `).join("");
  }

  if ($("recentEmpty")) {
    $("recentEmpty").classList.toggle("show", items.length === 0);
  }

  /* Status filtering */
  const filter = $("statusFilter") ? $("statusFilter").value : "All";

  const filtered = filter === "All"
    ? items
    : items.filter(item => displayStatus(item.status) === filter);

  /* Individual complaint cards */
  if ($("allComplaints")) {
    $("allComplaints").innerHTML = filtered.map(item => `
      <article class="complaint-card">
        <div class="complaint-card-top">
          <div class="complaint-card-heading">
            <h3>${escapeHTML(item.title)}</h3>
            <span class="complaint-id">ID: ${escapeHTML(item.complaint_id || "—")}</span>
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

          <div class="complaint-detail">
            <span class="detail-label">Priority</span>
            <strong class="priority ${escapeHTML(item.priority)}">${escapeHTML(item.priority.toUpperCase())}</strong>
          </div>
        </div>

        <div class="complaint-description">
          <span class="detail-label">Description</span>
          <p>${escapeHTML(item.description || "No description provided.")}</p>
        </div>
      </article>
    `).join("");
  }

  if ($("allEmpty")) {
    $("allEmpty").classList.toggle("show", filtered.length === 0);
  }
}

/* Navigation */
function showView(name) {
  if (!views.includes(name)) return;

  views.forEach(view => {
    const section = $(view + "View");
    if (section) section.classList.toggle("active", view === name);
  });

  document.querySelectorAll(".nav-link").forEach(button => {
    button.classList.toggle("active", button.dataset.view === name);
  });

  if ($("breadcrumbTitle")) {
    $("breadcrumbTitle").textContent = viewTitles[name];
  }

  if ($("sidebar")) $("sidebar").classList.remove("open");

  if (name === "dashboard" || name === "complaints") {
    refreshData();
  }
}

async function refreshData() {
  try {
    await loadComplaints();
  } catch (error) {
    console.error("Loading complaints failed:", error);
    showToast("Unable to load complaints: " + error.message);
  }
}

/* Navigation buttons */
document.querySelectorAll("[data-view], [data-go]").forEach(button => {
  button.addEventListener("click", () => {
    showView(button.dataset.view || button.dataset.go);
  });
});

/* Mobile menu */
if ($("menuToggle")) {
  $("menuToggle").addEventListener("click", () => {
    $("sidebar").classList.toggle("open");
  });
}

/* Filter */
if ($("statusFilter")) {
  $("statusFilter").addEventListener("change", render);
}

/* Image validation */
if ($("attachment")) {
  $("attachment").addEventListener("change", event => {
    const file = event.target.files[0];

    if (!file) return;

    const validType = ["image/jpeg", "image/png"].includes(file.type);
    const validSize = file.size <= 2 * 1024 * 1024;

    if (!validType || !validSize) {
      event.target.value = "";
      $("fileHint").textContent = "Choose a JPG or PNG file up to 2 MB.";
      showToast("Choose a JPG or PNG file up to 2 MB.");
    } else {
      $("fileHint").textContent =
        `${file.name} selected. Image upload to S3 is not enabled yet.`;
    }
  });
}

/* Submit complaint */
if ($("complaintForm")) {
  $("complaintForm").addEventListener("submit", async event => {
    event.preventDefault();

    const form = event.currentTarget;

    if (!form.reportValidity()) return;

    const formData = new FormData(form);

    const payload = {
      student_id: "student-demo-01",
      title: String(formData.get("title") || "").trim(),
      category: String(formData.get("category") || "").trim(),
      location: String(formData.get("location") || "").trim(),
      description: String(formData.get("description") || "").trim(),
      priority: String(formData.get("priority") || "medium").toLowerCase()
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
          "JPG or PNG only. Image upload to S3 is not enabled yet.";
      }

      await loadComplaints();
      showView("complaints");
      showToast("Complaint submitted successfully!");

    } catch (error) {
      console.error("Complaint submission failed:", error);
      showToast("Submission failed: " + error.message);
    }
  });
}

/* Toast */
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

/* Initial load */
render();

if (API_BASE && !DEMO_MODE) {
  refreshData();
}
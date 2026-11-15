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

const MAX_FILE_SIZE = 2 * 1024 * 1024;
const ALLOWED_FILE_TYPES = ["image/jpeg", "image/png"];

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
    created_at: item.created_at || item.createdAt || "",
    attachment_key: item.attachment_key || ""
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

/* Unwrap Lambda response body when necessary */
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

/* API request helper */
async function apiRequest(path, options = {}) {
  const base = API_BASE.endsWith("/") ? API_BASE : API_BASE + "/";

  const response = await fetch(base + path.replace(/^\/+/, ""), {
    ...options,
    headers: {
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  const result = unwrapApiData(data);

  if (!response.ok) {
    throw new Error(
      result.error ||
      result.message ||
      data.error ||
      `Request failed (${response.status})`
    );
  }

  return result;
}

/* Upload selected image to S3 using a temporary URL */
async function uploadAttachment(file) {
  if (!file) return "";

  if (!ALLOWED_FILE_TYPES.includes(file.type)) {
    throw new Error("Only JPG and PNG images are allowed.");
  }

  if (file.size > MAX_FILE_SIZE) {
    throw new Error("Image size must not exceed 2 MB.");
  }

  showToast("Preparing image upload...");

  /* Step 1: Request a presigned upload URL from Lambda */
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

  /* Step 2: Upload the actual image directly to S3 */
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

  const pending = items.filter(
    x => displayStatus(x.status) === "Pending"
  ).length;

  const progress = items.filter(
    x => displayStatus(x.status) === "In Progress"
  ).length;

  const resolved = items.filter(
    x => displayStatus(x.status) === "Resolved"
  ).length;

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
  const filter = $("statusFilter")
    ? $("statusFilter").value
    : "All";

  const filtered = filter === "All"
    ? items
    : items.filter(
        item => displayStatus(item.status) === filter
      );

  /* Individual complaint cards */
  if ($("allComplaints")) {
    $("allComplaints").innerHTML = filtered.map(item => `
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

          <div class="complaint-detail">
            <span class="detail-label">Priority</span>
            <strong class="priority ${escapeHTML(item.priority)}">
              ${escapeHTML(item.priority.toUpperCase())}
            </strong>
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
    if ($("sidebar")) {
      $("sidebar").classList.toggle("open");
    }
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
    } else {
      if ($("fileHint")) {
        $("fileHint").textContent =
          `${file.name} selected. Ready to upload.`;
      }
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
    const selectedFile = $("attachment")
      ? $("attachment").files[0]
      : null;

    const payload = {
      student_id: "student-demo-01",
      title: String(formData.get("title") || "").trim(),
      category: String(formData.get("category") || "").trim(),
      location: String(formData.get("location") || "").trim(),
      description: String(formData.get("description") || "").trim(),
      priority: String(formData.get("priority") || "medium").toLowerCase(),
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
      /* Upload image first, if the user selected one */
      if (selectedFile) {
        payload.attachment_key =
          await uploadAttachment(selectedFile);
      }

      /* Submit complaint with the S3 object key */
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
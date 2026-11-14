/*
 * CampusConnect cloud frontend
 * Configure API_BASE with your AWS Lambda Function URL in the line below.
 * Example: https://xxxxxxxx.lambda-url.ap-south-1.on.aws/
 * Do not put AWS credentials or secrets in browser code.
 */
const API_BASE = "https://t7jsqlniysev7enb3elizqhe7a0hjezy.lambda-url.us-east-1.on.aws/"; // TODO: paste your Lambda Function URL here, including trailing slash
const DEMO_MODE = false; // Set true only for local mock mode; not cloud persistence

const views = ["dashboard", "report", "complaints"];
const viewTitles = { dashboard: "Dashboard", report: "Report an Issue", complaints: "My Complaints" };
const $ = (id) => document.getElementById(id);
let complaintsCache = [];
let toastTimer;

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  }[ch]));
}
function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString(undefined, { month:"short", day:"numeric", year:"numeric" });
}
function statusClass(status) { return String(status || "Pending").toLowerCase().replace(/\s+/g, "-"); }
function statusBadge(status) { return `<span class="badge ${statusClass(status)}">${escapeHTML(status || "Pending")}</span>`; }
function complaintCell(item) {
  return `<div class="complaint-title">${escapeHTML(item.title)}</div><div class="complaint-id">${escapeHTML(item.complaint_id || item.id || "—")}</div>`;
}
function normalizeComplaint(item) {
  return {
    complaint_id: item.complaint_id || item.id || "",
    title: item.title || "",
    category: item.category || "Other",
    location: item.location || "",
    description: item.description || "",
    priority: item.priority || "medium",
    status: item.status || "submitted",
    created_at: item.created_at || item.createdAt || ""
  };
}
function displayStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "submitted" || normalized === "pending") return "Pending";
  if (normalized === "in progress" || normalized === "in_progress") return "In Progress";
  if (normalized === "resolved") return "Resolved";
  return status || "Pending";
}
function requireApiBase() {
  if (!API_BASE.trim()) throw new Error("Cloud API is not configured yet. Add your Lambda Function URL in script.js.");
}
async function apiRequest(path, options = {}) {
  requireApiBase();
  const base = API_BASE.endsWith("/") ? API_BASE : API_BASE + "/";
  const response = await fetch(base + path.replace(/^\/+/, ""), {
    ...options,
    headers: { ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
async function loadComplaints() {
  if (DEMO_MODE) {
    complaintsCache = JSON.parse(localStorage.getItem("campusconnect_demo_complaints") || "[]").map(normalizeComplaint);
    render();
    return;
  }
  const data = await apiRequest("complaints");
  complaintsCache = (data.items || []).map(normalizeComplaint);
  render();
}
function render() {
  const items = [...complaintsCache].sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
  const pending = items.filter(x => displayStatus(x.status) === "Pending").length;
  const progress = items.filter(x => displayStatus(x.status) === "In Progress").length;
  const resolved = items.filter(x => displayStatus(x.status) === "Resolved").length;
  $("totalCount").textContent = items.length;
  $("pendingCount").textContent = pending;
  $("progressCount").textContent = progress;
  $("resolvedCount").textContent = resolved;

  $("recentRows").innerHTML = items.slice(0,5).map(item =>
    `<tr><td>${complaintCell(item)}</td><td>${escapeHTML(item.category)}</td><td>${formatDate(item.created_at)}</td><td>${statusBadge(displayStatus(item.status))}</td></tr>`
  ).join("");
  $("recentEmpty").classList.toggle("show", items.length === 0);

  const filter = $("statusFilter").value;
  const filtered = filter === "All" ? items : items.filter(item => displayStatus(item.status) === filter);
  $("allRows").innerHTML = filtered.map(item =>
    `<tr><td>${complaintCell(item)}</td><td>${escapeHTML(item.category)}</td><td>${escapeHTML(item.location)}</td><td>${formatDate(item.created_at)}</td><td><span class="priority ${escapeHTML(String(item.priority).toLowerCase())}">${escapeHTML(item.priority)}</span></td><td>${statusBadge(displayStatus(item.status))}</td></tr>`
  ).join("");
  $("allEmpty").classList.toggle("show", filtered.length === 0);
}
function showView(name) {
  if (!views.includes(name)) return;
  views.forEach(view => $(view + "View").classList.toggle("active", view === name));
  document.querySelectorAll(".nav-link").forEach(btn => btn.classList.toggle("active", btn.dataset.view === name));
  $("breadcrumbTitle").textContent = viewTitles[name];
  $("sidebar").classList.remove("open");
  if (name === "dashboard" || name === "complaints") refreshData();
}
async function refreshData() {
  try { await loadComplaints(); }
  catch (error) { showToast(error.message); }
}
document.querySelectorAll("[data-view], [data-go]").forEach(button => {
  button.addEventListener("click", () => showView(button.dataset.view || button.dataset.go));
});
$("menuToggle").addEventListener("click", () => $("sidebar").classList.toggle("open"));
$("statusFilter").addEventListener("change", render);

$("attachment").addEventListener("change", event => {
  const file = event.target.files[0];
  if (!file) { $("fileHint").textContent = "JPG or PNG only. Cloud S3 upload flow is a separate next step."; return; }
  const validType = ["image/jpeg", "image/png"].includes(file.type);
  const validSize = file.size <= 2 * 1024 * 1024;
  if (!validType || !validSize) {
    event.target.value = "";
    $("fileHint").textContent = "Choose a JPG or PNG file up to 2 MB.";
    showToast("That file doesn't meet the upload requirements.");
  } else {
    $("fileHint").textContent = `${file.name} selected. This package validates it; S3 presigned upload needs to be added.`;
  }
});
$("complaintForm").addEventListener("submit", async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const payload = {
    student_id: "student-demo-01", // demo identity only; not authentication
    title: String(data.get("title") || "").trim(),
    category: String(data.get("category") || "").trim(),
    location: String(data.get("location") || "").trim(),
    description: String(data.get("description") || "").trim(),
    priority: String(data.get("priority") || "medium").toLowerCase()
  };
  if (DEMO_MODE) {
    const list = JSON.parse(localStorage.getItem("campusconnect_demo_complaints") || "[]");
    list.push({ ...payload, complaint_id: "CC-" + Date.now(), status:"submitted", created_at:new Date().toISOString() });
    localStorage.setItem("campusconnect_demo_complaints", JSON.stringify(list));
    complaintsCache = list.map(normalizeComplaint);
    form.reset(); render(); showView("complaints"); showToast("Demo complaint saved in this browser."); return;
  }
  try {
    await apiRequest("complaints", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload) });
    form.reset();
    $("fileHint").textContent = "JPG or PNG only. Cloud S3 upload flow is a separate next step.";
    await loadComplaints();
    showView("complaints");
    showToast("Complaint submitted to AWS successfully!");
  } catch (error) {
    showToast(error.message);
  }
});
function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 4000);
}
render();
if (API_BASE) refreshData();
else showToast("Configure API_BASE in script.js to connect AWS Lambda.");

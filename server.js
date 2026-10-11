// ─────────────────────────────────────────────────────────────
// WiFi Photo Transfer — Node.js Server
// Two-Way Transfer: Upload from Phone & Download to New Phone
// Features: Select All, Batch ZIP Download, Streaming on-the-fly
// ─────────────────────────────────────────────────────────────

const http     = require('http');
const fs             = require('fs');
const path           = require('path');
const os             = require('os');
const { ZipArchive } = require('archiver');

// ── Config ───────────────────────────────────────────────────
const PORT     = 8080;
const SAVE_DIR = path.join(__dirname, 'received_photos');
const MAX_SIZE = 100 * 1024 * 1024; // 100 MB per single file upload

if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });

// ── Helpers ──────────────────────────────────────────────────

function getLocalIP() {
  const nets = os.networkInterfaces();
  const skip = /vpn|hamachi|radmin|virtualbox|vmware|docker|vethernet/i;
  const prefer = /wi-fi|wifi|wlan|ethernet/i;

  let fallback = null;
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (skip.test(name)) continue;
      if (net.address.startsWith('169.254.')) continue;
      if (prefer.test(name)) return net.address;
      if (!fallback) fallback = net.address;
    }
  }
  return fallback || '127.0.0.1';
}

function parseMultipart(buffer, boundary) {
  const files = [];
  const boundaryBuf = Buffer.from('--' + boundary);
  const crlf = Buffer.from('\r\n');
  const headerEnd = Buffer.from('\r\n\r\n');

  let start = bufferIndexOf(buffer, boundaryBuf, 0);
  if (start === -1) return files;

  while (true) {
    start += boundaryBuf.length;
    if (buffer[start] === 0x2D && buffer[start + 1] === 0x2D) break;
    start += crlf.length;

    const headEnd = bufferIndexOf(buffer, headerEnd, start);
    if (headEnd === -1) break;

    const headerStr = buffer.slice(start, headEnd).toString('utf-8');
    const dataStart = headEnd + headerEnd.length;

    const nextBoundary = bufferIndexOf(buffer, boundaryBuf, dataStart);
    if (nextBoundary === -1) break;

    const dataEnd = nextBoundary - crlf.length;
    const data = buffer.slice(dataStart, dataEnd);

    const filenameMatch = headerStr.match(/filename="([^"]+)"/i)
                       || headerStr.match(/filename=([^\s;]+)/i);
    const filename = filenameMatch ? filenameMatch[1] : `photo_${Date.now()}.jpg`;

    files.push({ filename, data });
    start = nextBoundary;
  }
  return files;
}

function bufferIndexOf(haystack, needle, offset) {
  for (let i = offset; i <= haystack.length - needle.length; i++) {
    let found = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}

function safeFilename(name) {
  let clean = path.basename(name).replace(/[^a-zA-Z0-9._\-()  ]/g, '_');
  if (!clean || clean === '.' || clean === '..') clean = `photo_${Date.now()}.jpg`;
  return clean;
}

function uniquePath(dir, filename) {
  let fullPath = path.join(dir, filename);
  if (!fs.existsSync(fullPath)) return fullPath;

  const ext  = path.extname(filename);
  const base = path.basename(filename, ext);
  let i = 1;
  do {
    fullPath = path.join(dir, `${base} (${i})${ext}`);
    i++;
  } while (fs.existsSync(fullPath));
  return fullPath;
}

function listPhotos() {
  try {
    return fs.readdirSync(SAVE_DIR)
      .filter(f => /\.(jpe?g|png|gif|webp|heic|heif|bmp|mp4|mov)$/i.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(SAVE_DIR, f));
        return { name: f, size: stat.size, time: stat.mtimeMs };
      })
      .sort((a, b) => b.time - a.time);
  } catch { return []; }
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

// ── Stream ZIP helper ────────────────────────────────────────

function streamZip(res, req, fileList, zipName) {
  const archive = new ZipArchive({
    zlib: { level: 0 }, // no compression = maximum streaming speed (photos/videos are already compressed)
    forceZip64: true     // support > 4GB archives
  });

  archive.on('error', err => {
    console.error('ZIP archive error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Zip error: ' + err.message);
    }
  });

  req.on('close', () => {
    try { archive.abort(); } catch {}
  });

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${encodeURIComponent(zipName)}"`,
    'Cache-Control': 'no-cache',
  });

  archive.pipe(res);

  for (const name of fileList) {
    const safe = path.basename(name);
    const full = path.join(SAVE_DIR, safe);
    if (fs.existsSync(full)) {
      archive.file(full, { name: safe });
    }
  }

  archive.finalize().catch(err => {
    console.error('Archive finalize error:', err);
  });
}

// ── HTML ─────────────────────────────────────────────────────

function getHTML(localIP) {
  const photos = listPhotos();
  const totalBytes = photos.reduce((s, p) => s + p.size, 0);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>WiFi Photo Transfer</title>
<style>
  :root {
    --bg: #0f0f13;
    --surface: #1a1a24;
    --surface-hover: #222230;
    --surface-selected: #2a2550;
    --border: #2a2a3a;
    --accent: #6c63ff;
    --accent-glow: rgba(108,99,255,0.35);
    --green: #10b981;
    --green-glow: rgba(16,185,129,0.3);
    --text: #e4e4ec;
    --text-dim: #8c8ca4;
    --red: #ef4444;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, system-ui, sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100dvh;
    padding: 16px;
    padding-bottom: 90px;
    -webkit-font-smoothing: antialiased;
  }
  .container { max-width: 620px; margin: 0 auto; }
  header { text-align: center; padding: 18px 0 14px; }
  header h1 {
    font-size: 24px;
    font-weight: 700;
    background: linear-gradient(135deg, #6c63ff, #a78bfa);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  header p { color: var(--text-dim); font-size: 13px; margin-top: 4px; }

  /* Nav Tabs */
  .tabs {
    display: flex;
    gap: 8px;
    margin: 14px 0;
    background: var(--surface);
    padding: 4px;
    border-radius: 12px;
    border: 1px solid var(--border);
  }
  .tab-btn {
    flex: 1;
    padding: 10px;
    font-size: 14px;
    font-weight: 600;
    color: var(--text-dim);
    background: transparent;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s;
  }
  .tab-btn.active {
    background: var(--accent);
    color: #fff;
    box-shadow: 0 2px 10px var(--accent-glow);
  }

  /* Stats */
  .stats { display: flex; gap: 10px; margin-bottom: 14px; }
  .stat-card {
    flex: 1;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px;
    text-align: center;
  }
  .stat-card .value { font-size: 22px; font-weight: 700; color: var(--accent); }
  .stat-card .label { font-size: 11px; color: var(--text-dim); margin-top: 2px; text-transform: uppercase; }

  /* Tip Banner */
  .tip-box {
    background: rgba(16, 185, 129, 0.08);
    border: 1px solid rgba(16, 185, 129, 0.25);
    border-radius: 12px;
    padding: 12px 14px;
    margin-bottom: 14px;
    font-size: 13px;
    line-height: 1.45;
  }
  .tip-box strong { color: var(--green); display: block; margin-bottom: 2px; font-size: 13px; }

  /* Action Bar (Select All & Download All) */
  .action-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 10px 14px;
    margin-bottom: 12px;
  }
  .select-all-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    user-select: none;
  }
  .select-all-wrap input[type="checkbox"] {
    width: 18px;
    height: 18px;
    cursor: pointer;
    accent-color: var(--accent);
  }
  .btn-all-zip {
    background: linear-gradient(135deg, #10b981, #059669);
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 8px 14px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    box-shadow: 0 2px 8px var(--green-glow);
    text-decoration: none;
  }
  .btn-all-zip:hover { filter: brightness(1.1); }

  /* Search */
  .search-bar {
    width: 100%;
    padding: 12px 14px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text);
    font-size: 14px;
    margin-bottom: 12px;
    outline: none;
  }
  .search-bar:focus { border-color: var(--accent); }

  /* Photo list */
  .photo-list {
    background: var(--surface);
    border-radius: 12px;
    border: 1px solid var(--border);
    overflow: hidden;
  }
  .photo-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    transition: background 0.15s;
    cursor: pointer;
  }
  .photo-item:hover { background: var(--surface-hover); }
  .photo-item.selected {
    background: var(--surface-selected);
    border-left: 3px solid var(--accent);
  }
  .photo-item:last-child { border-bottom: none; }
  .item-chk {
    width: 18px;
    height: 18px;
    accent-color: var(--accent);
    cursor: pointer;
    flex-shrink: 0;
  }
  .thumb {
    width: 44px;
    height: 44px;
    border-radius: 6px;
    object-fit: cover;
    background: #000;
    flex-shrink: 0;
  }
  .photo-info { flex: 1; overflow: hidden; }
  .photo-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }
  .photo-size { font-size: 11px; color: var(--text-dim); }
  .btn-icon {
    background: #2a2a3a;
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 7px 11px;
    font-size: 12px;
    font-weight: 600;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .btn-icon:hover { background: var(--accent); }
  .empty { color: var(--text-dim); font-size: 14px; text-align: center; padding: 24px; }

  /* Pagination */
  .pager {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 12px;
    font-size: 13px;
    color: var(--text-dim);
  }
  .pager-btn {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 8px 14px;
    border-radius: 8px;
    cursor: pointer;
  }
  .pager-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  /* Sticky Bottom Bar for Selection */
  .floating-bar {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%) translateY(120px);
    background: #1e1e2d;
    border: 1px solid var(--accent);
    box-shadow: 0 10px 30px rgba(0,0,0,0.6), 0 0 20px var(--accent-glow);
    border-radius: 14px;
    padding: 10px 18px;
    display: flex;
    align-items: center;
    gap: 14px;
    z-index: 99;
    transition: transform 0.3s cubic-bezier(0.18, 0.89, 0.32, 1.28);
    max-width: 92%;
    width: 480px;
  }
  .floating-bar.active {
    transform: translateX(-50%) translateY(0);
  }
  .floating-info {
    flex: 1;
    font-size: 13px;
    font-weight: 600;
  }
  .floating-info span {
    display: block;
    font-size: 11px;
    color: var(--text-dim);
    font-weight: 400;
  }
  .btn-float-zip {
    background: linear-gradient(135deg, var(--accent), #8b5cf6);
    color: #fff;
    border: none;
    border-radius: 8px;
    padding: 9px 16px;
    font-size: 13px;
    font-weight: 700;
    cursor: pointer;
    box-shadow: 0 2px 10px var(--accent-glow);
    white-space: nowrap;
  }
  .btn-float-clear {
    background: transparent;
    color: var(--text-dim);
    border: none;
    font-size: 13px;
    cursor: pointer;
    padding: 4px;
  }
  .btn-float-clear:hover { color: var(--red); }

  /* Upload Zone */
  .upload-zone {
    border: 2px dashed var(--border);
    border-radius: 16px;
    padding: 36px 20px;
    text-align: center;
    cursor: pointer;
    background: var(--surface);
    position: relative;
    transition: all 0.2s;
  }
  .upload-zone:hover { border-color: var(--accent); background: rgba(108,99,255,0.05); }
  .upload-zone .icon { font-size: 42px; margin-bottom: 8px; }
  .upload-zone .label { font-size: 16px; font-weight: 600; }
  .upload-zone .sublabel { font-size: 13px; color: var(--text-dim); margin-top: 4px; }
  .upload-zone input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  .progress-area { margin-top: 14px; display: none; }
  .progress-area.active { display: block; }
  .progress-bar-bg { height: 6px; background: var(--border); border-radius: 3px; overflow: hidden; }
  .progress-bar-fill { height: 100%; background: linear-gradient(90deg, var(--accent), #a78bfa); width: 0%; transition: width 0.2s; }
  .progress-text { font-size: 12px; color: var(--text-dim); margin-top: 6px; text-align: center; }

  /* Toast */
  .toast {
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%) translateY(-100px);
    background: var(--green);
    color: #fff;
    padding: 10px 20px;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    box-shadow: 0 8px 24px rgba(16,185,129,0.3);
    transition: transform 0.3s;
    z-index: 1000;
  }
  .toast.error { background: var(--red); }
  .toast.show { transform: translateX(-50%) translateY(0); }
</style>
</head>
<body>

<div class="container">
  <header>
    <h1>📲 WiFi Photo Transfer</h1>
    <p>Send & receive photos between your phone and PC</p>
  </header>

  <div class="stats">
    <div class="stat-card">
      <div class="value" id="countStat">${photos.length}</div>
      <div class="label">Total Photos</div>
    </div>
    <div class="stat-card">
      <div class="value" id="sizeStat">${fmtSize(totalBytes)}</div>
      <div class="label">Total Size</div>
    </div>
  </div>

  <div class="tabs">
    <button class="tab-btn active" id="tabDownloadBtn" onclick="switchTab('download')">📥 Download to New Phone</button>
    <button class="tab-btn" id="tabUploadBtn" onclick="switchTab('upload')">📤 Upload from Old Phone</button>
  </div>

  <!-- Download Section -->
  <div id="sectionDownload">
    <div class="tip-box">
      <strong>⚡ USB Option (~${fmtSize(totalBytes)}):</strong>
      To transfer all photos in 2 minutes without downloading, plug your new phone into this PC with a USB cable, choose <b>File Transfer</b>, and copy <code>C:\\NIK\\WIFI\\received_photos</code> straight into your phone's <b>DCIM/Camera</b> folder.
    </div>

    <!-- Action Bar with SELECT ALL & ONE-CLICK DOWNLOAD ALL -->
    <div class="action-bar">
      <label class="select-all-wrap">
        <input type="checkbox" id="selectAllCheckbox" onchange="toggleSelectAll()">
        <span id="selectAllLabel">Select All (${photos.length})</span>
      </label>
      <a class="btn-all-zip" href="/download-all-zip">
        ⚡ Download All (ZIP)
      </a>
    </div>

    <input type="text" class="search-bar" id="searchBox" placeholder="🔍 Search by name..." oninput="handleSearch()">

    <div class="photo-list" id="photoList">
      <p class="empty">Loading photos...</p>
    </div>

    <div class="pager" id="pagerControls" style="display: none;">
      <button class="pager-btn" id="prevBtn" onclick="prevPage()">⬅️ Previous</button>
      <span id="pageInfo">Page 1</span>
      <button class="pager-btn" id="nextBtn" onclick="nextPage()">Next ➡️</button>
    </div>
  </div>

  <!-- Upload Section -->
  <div id="sectionUpload" style="display: none;">
    <div class="upload-zone" id="dropZone">
      <input type="file" id="fileInput" multiple accept="image/*,video/*,.heic,.heif">
      <div class="icon">📁</div>
      <div class="label">Tap to Select Photos</div>
      <div class="sublabel">or drag & drop here · images & videos</div>
    </div>
    <div class="progress-area" id="progressArea">
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" id="progressFill"></div>
      </div>
      <div class="progress-text" id="progressText">Uploading...</div>
    </div>
  </div>
</div>

<!-- Sticky Floating Download Bar (Appears when items are selected) -->
<div class="floating-bar" id="floatingBar">
  <div class="floating-info">
    <div id="selectedCountText">0 photos selected</div>
    <span id="selectedSizeText">0 MB</span>
  </div>
  <button class="btn-float-zip" onclick="downloadSelectedZip()">
    📥 Download ZIP
  </button>
  <button class="btn-float-clear" onclick="clearSelection()" title="Clear selection">✕</button>
</div>

<div class="toast" id="toast"></div>

<script>
let allPhotos = [];
let filteredPhotos = [];
let selectedFiles = new Set();
let currentPage = 1;
const PAGE_SIZE = 40;

function switchTab(tab) {
  const isDl = tab === 'download';
  document.getElementById('sectionDownload').style.display = isDl ? 'block' : 'none';
  document.getElementById('sectionUpload').style.display = isDl ? 'none' : 'block';
  document.getElementById('tabDownloadBtn').className = 'tab-btn' + (isDl ? ' active' : '');
  document.getElementById('tabUploadBtn').className = 'tab-btn' + (!isDl ? ' active' : '');
}

async function loadPhotos() {
  try {
    const res = await fetch('/api/photos');
    allPhotos = await res.json();
    filteredPhotos = allPhotos;
    updateSelectAllCheckbox();
    renderPage();
  } catch (err) {
    document.getElementById('photoList').innerHTML = '<p class="empty">Failed to load photos</p>';
  }
}

// ── Selection Logic ──

function toggleSelectAll() {
  const chk = document.getElementById('selectAllCheckbox');
  if (chk.checked) {
    // Select all currently filtered (or all photos)
    filteredPhotos.forEach(p => selectedFiles.add(p.name));
  } else {
    // Clear selection
    selectedFiles.clear();
  }
  updateSelectionUI();
  renderPage();
}

function toggleItemSelection(name, event) {
  if (event) event.stopPropagation();
  if (selectedFiles.has(name)) {
    selectedFiles.delete(name);
  } else {
    selectedFiles.add(name);
  }
  updateSelectionUI();
  renderPage();
}

function clearSelection() {
  selectedFiles.clear();
  updateSelectionUI();
  renderPage();
}

function updateSelectAllCheckbox() {
  const chk = document.getElementById('selectAllCheckbox');
  const label = document.getElementById('selectAllLabel');
  const total = filteredPhotos.length;
  label.textContent = 'Select All (' + total + ')';

  if (total === 0) {
    chk.checked = false;
    chk.indeterminate = false;
  } else {
    const selectedFilteredCount = filteredPhotos.filter(p => selectedFiles.has(p.name)).length;
    if (selectedFilteredCount === total) {
      chk.checked = true;
      chk.indeterminate = false;
    } else if (selectedFilteredCount > 0) {
      chk.checked = false;
      chk.indeterminate = true;
    } else {
      chk.checked = false;
      chk.indeterminate = false;
    }
  }
}

function updateSelectionUI() {
  updateSelectAllCheckbox();
  const floatBar = document.getElementById('floatingBar');
  const count = selectedFiles.size;

  if (count > 0) {
    floatBar.classList.add('active');
    document.getElementById('selectedCountText').textContent = count + ' photo' + (count > 1 ? 's' : '') + ' selected';

    let totalBytes = 0;
    allPhotos.forEach(p => {
      if (selectedFiles.has(p.name)) totalBytes += p.size;
    });
    document.getElementById('selectedSizeText').textContent = fmtSize(totalBytes);
  } else {
    floatBar.classList.remove('active');
  }
}

function downloadSelectedZip() {
  if (selectedFiles.size === 0) return;

  const form = document.createElement('form');
  form.method = 'POST';
  form.action = '/download-zip';

  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'files';

  // If every photo is selected, send 'ALL' flag for instant server-side handling
  if (selectedFiles.size === allPhotos.length) {
    input.value = 'ALL';
  } else {
    input.value = JSON.stringify(Array.from(selectedFiles));
  }

  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
  document.body.removeChild(form);

  showToast('📦 Starting ZIP download of ' + selectedFiles.size + ' photos...');
}

function handleSearch() {
  const q = document.getElementById('searchBox').value.trim().toLowerCase();
  filteredPhotos = q ? allPhotos.filter(p => p.name.toLowerCase().includes(q)) : allPhotos;
  currentPage = 1;
  updateSelectAllCheckbox();
  renderPage();
}

function renderPage() {
  const list = document.getElementById('photoList');
  const pager = document.getElementById('pagerControls');

  if (!filteredPhotos.length) {
    list.innerHTML = '<p class="empty">No photos found</p>';
    pager.style.display = 'none';
    return;
  }

  const totalPages = Math.ceil(filteredPhotos.length / PAGE_SIZE);
  const start = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filteredPhotos.slice(start, start + PAGE_SIZE);

  list.innerHTML = pageItems.map(p => {
    const isVid = /\\.(mp4|mov)$/i.test(p.name);
    const enc = encodeURIComponent(p.name);
    const isSelected = selectedFiles.has(p.name);

    return '<div class="photo-item' + (isSelected ? ' selected' : '') + '" onclick="toggleItemSelection(\\'' + escHtml(p.name).replace(/'/g, "\\\\'") + '\\')">' +
      '<input type="checkbox" class="item-chk" ' + (isSelected ? 'checked' : '') + ' onclick="toggleItemSelection(\\'' + escHtml(p.name).replace(/'/g, "\\\\'") + '\\', event)">' +
      (isVid ? '<span style="font-size:24px;">🎬</span>' : '<img class="thumb" loading="lazy" src="/view?file=' + enc + '" alt="">') +
      '<div class="photo-info">' +
        '<span class="photo-name" title="' + escHtml(p.name) + '">' + escHtml(p.name) + '</span>' +
        '<span class="photo-size">' + fmtSize(p.size) + '</span>' +
      '</div>' +
      '<a class="btn-icon" href="/download?file=' + enc + '" download onclick="event.stopPropagation()">⬇️ Save</a>' +
    '</div>';
  }).join('');

  pager.style.display = totalPages > 1 ? 'flex' : 'none';
  document.getElementById('pageInfo').textContent = 'Page ' + currentPage + ' of ' + totalPages + ' (' + filteredPhotos.length + ' items)';
  document.getElementById('prevBtn').disabled = currentPage <= 1;
  document.getElementById('nextBtn').disabled = currentPage >= totalPages;
}

function prevPage() {
  if (currentPage > 1) { currentPage--; renderPage(); window.scrollTo({top: 150, behavior: 'smooth'}); }
}
function nextPage() {
  const totalPages = Math.ceil(filteredPhotos.length / PAGE_SIZE);
  if (currentPage < totalPages) { currentPage++; renderPage(); window.scrollTo({top: 150, behavior: 'smooth'}); }
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg, isError) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast' + (isError ? ' error' : '');
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => toast.classList.remove('show'), 3500);
}

// ── Upload logic ──
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const progressArea = document.getElementById('progressArea');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  handleFiles(e.dataTransfer.files);
});
fileInput.addEventListener('change', () => { if (fileInput.files.length) handleFiles(fileInput.files); });

async function handleFiles(files) {
  const fileArr = Array.from(files);
  if (!fileArr.length) return;

  progressArea.classList.add('active');
  let uploaded = 0;
  for (let i = 0; i < fileArr.length; i++) {
    const file = fileArr[i];
    progressText.textContent = 'Uploading ' + (i + 1) + ' of ' + fileArr.length;
    try {
      const formData = new FormData();
      formData.append('photos', file);
      await fetch('/upload', { method: 'POST', body: formData });
      uploaded++;
    } catch (err) {}
    progressFill.style.width = Math.round(((i + 1) / fileArr.length) * 100) + '%';
  }
  progressArea.classList.remove('active');
  fileInput.value = '';
  showToast('✅ ' + uploaded + ' photo' + (uploaded > 1 ? 's' : '') + ' uploaded!');
  loadPhotos();
}

loadPhotos();
</script>

</body>
</html>`;
}

// ── Server ───────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // ── GET / ──────────────────────────────────────────────
  if (req.method === 'GET' && (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html')) {
    const html = getHTML(getLocalIP());
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
    });
    return res.end(html);
  }

  // ── GET /api/photos ────────────────────────────────────
  if (req.method === 'GET' && parsedUrl.pathname === '/api/photos') {
    const photos = listPhotos();
    const json = JSON.stringify(photos);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(json),
    });
    return res.end(json);
  }

  // ── GET /view or /download ─────────────────────────────
  if (req.method === 'GET' && (parsedUrl.pathname === '/view' || parsedUrl.pathname === '/download')) {
    const rawFile = parsedUrl.searchParams.get('file');
    if (!rawFile) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Missing file parameter');
    }

    const safeName = path.basename(rawFile);
    const filePath = path.join(SAVE_DIR, safeName);

    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('File not found');
    }

    const stat = fs.statSync(filePath);
    const ext = path.extname(safeName).toLowerCase();
    const contentType = MIME_MAP[ext] || 'application/octet-stream';
    const isDownload = parsedUrl.pathname === '/download';

    const headers = {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=86400',
    };

    if (isDownload) {
      headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(safeName)}"`;
    }

    res.writeHead(200, headers);
    return fs.createReadStream(filePath).pipe(res);
  }

  // ── GET /download-all-zip ──────────────────────────────
  if (req.method === 'GET' && parsedUrl.pathname === '/download-all-zip') {
    const photos = listPhotos();
    const fileList = photos.map(p => p.name);
    console.log(`  📦 Streaming all ${fileList.length} photos as ZIP...`);
    return streamZip(res, req, fileList, `photos_all_${Date.now()}.zip`);
  }

  // ── POST /download-zip ─────────────────────────────────
  if (req.method === 'POST' && parsedUrl.pathname === '/download-zip') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 20 * 1024 * 1024) req.destroy();
    });

    req.on('end', () => {
      try {
        let fileNames = [];
        // Support URL-encoded form data (files=...) or JSON
        if (body.startsWith('files=')) {
          const raw = decodeURIComponent(body.slice(6));
          if (raw === 'ALL') {
            fileNames = listPhotos().map(p => p.name);
          } else {
            fileNames = JSON.parse(raw);
          }
        } else {
          const parsed = JSON.parse(body);
          if (parsed.files === 'ALL') {
            fileNames = listPhotos().map(p => p.name);
          } else {
            fileNames = parsed.files || [];
          }
        }

        if (!Array.isArray(fileNames) || !fileNames.length) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          return res.end('No files specified');
        }

        console.log(`  📦 Streaming ${fileNames.length} selected photos as ZIP...`);
        return streamZip(res, req, fileNames, `photos_selected_${Date.now()}.zip`);
      } catch (err) {
        console.error('ZIP request error:', err);
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid request');
      }
    });
    return;
  }

  // ── POST /upload ───────────────────────────────────────
  if (req.method === 'POST' && parsedUrl.pathname === '/upload') {
    const contentType = req.headers['content-type'] || '';
    const match = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/i);
    if (!match) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Missing multipart boundary');
    }
    const boundary = match[1] || match[2];

    const chunks = [];
    let totalSize = 0;

    req.on('data', chunk => {
      totalSize += chunk.length;
      if (totalSize > MAX_SIZE) {
        res.writeHead(413, { 'Content-Type': 'text/plain' });
        res.end('File too large');
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const buffer = Buffer.concat(chunks);
        const files = parseMultipart(buffer, boundary);

        const saved = [];
        for (const file of files) {
          const safeName = safeFilename(file.filename);
          const savePath = uniquePath(SAVE_DIR, safeName);
          fs.writeFileSync(savePath, file.data);
          saved.push(path.basename(savePath));
        }

        const json = JSON.stringify({ ok: true, saved });
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(json),
        });
        res.end(json);
      } catch (err) {
        console.error('Upload error:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Server error');
      }
    });
    return;
  }

  // ── 404 ────────────────────────────────────────────────
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ── Start ────────────────────────────────────────────────────
const localIP = getLocalIP();

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ┌──────────────────────────────────────────────┐');
  console.log('  │                                              │');
  console.log('  │     📲  WiFi Photo Transfer is running!      │');
  console.log('  │                                              │');
  console.log(`  │     Open on your phone:                      │`);
  console.log(`  │     👉  http://${localIP}:${PORT}`.padEnd(49) + '│');
  console.log('  │                                              │');
  console.log(`  │     Folder on PC:                            │`);
  console.log(`  │     📂  ${SAVE_DIR}`.padEnd(49) + '│');
  console.log('  │                                              │');
  console.log('  │     Press Ctrl+C to stop                     │');
  console.log('  │                                              │');
  console.log('  └──────────────────────────────────────────────┘');
  console.log('');
});

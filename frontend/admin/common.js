/* Remont Admin — shared auth + API helper */
var API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';

function getToken() { return localStorage.getItem('remont_admin_token'); }
function getAdminUser() {
  try { return JSON.parse(localStorage.getItem('remont_admin_user') || '{}'); } catch(e) { return {}; }
}

function requireAuth() {
  var token = getToken();
  var user = getAdminUser();
  if (!token || ['ADMIN','SUPER_ADMIN'].indexOf(user.role) === -1) {
    window.location.replace('/admin/index.html');
    return false;
  }
  var el = document.getElementById('admin-name');
  if (el) el.textContent = user.name || user.phone || 'Admin';
  return true;
}

function logout() {
  localStorage.removeItem('remont_admin_token');
  localStorage.removeItem('remont_admin_user');
  window.location.replace('/admin/index.html');
}

function api(method, path, body) {
  var token = getToken();
  var opts = { method: method.toUpperCase(), headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(API_BASE + '/api/v1' + path, opts).then(function(r) {
    return r.json().then(function(d) {
      if (r.status === 401) { logout(); return; }
      if (!r.ok) throw new Error((d && d.message) ? (Array.isArray(d.message) ? d.message.join(', ') : d.message) : ('HTTP ' + r.status));
      return d.data !== undefined ? d.data : d;
    });
  });
}

function toast(msg, type) {
  var t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;padding:12px 20px;border-radius:8px;color:#fff;font-size:14px;font-weight:500;box-shadow:0 4px 12px rgba(0,0,0,.15);transition:opacity .3s;max-width:340px;';
  t.style.background = type === 'error' ? '#ef4444' : type === 'warning' ? '#f59e0b' : '#22c55e';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function() { t.style.opacity = '0'; setTimeout(function(){ t.remove(); }, 300); }, 3200);
}

function closeModal(id) { var el = document.getElementById(id); if (el) el.style.display = 'none'; }

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDateShort(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtCur(n) {
  if (n === null || n === undefined || n === '') return '—';
  return '₹' + Number(n).toLocaleString('en-IN');
}

function downloadCsv(rows, columns, filename) {
  if (!rows || !rows.length) { toast('No data to export', 'warning'); return; }
  var csvRows = [columns.map(function(c) { return '"' + c.label + '"'; }).join(',')];
  rows.forEach(function(row) {
    csvRows.push(columns.map(function(c) {
      var val = c.key.split('.').reduce(function(obj, k) { return obj && obj[k] != null ? obj[k] : ''; }, row);
      return '"' + String(val).replace(/"/g, '""') + '"';
    }).join(','));
  });
  var blob = new Blob(['﻿' + csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  toast('CSV downloaded (' + rows.length + ' rows)', 'success');
}

function escape(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function badge(text, color) {
  var colors = { green: '#22c55e', blue: '#3b82f6', yellow: '#f59e0b', red: '#ef4444', gray: '#6b7280', purple: '#8b5cf6', orange: '#f97316' };
  var bg = colors[color] || colors.gray;
  return '<span style="display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600;background:' + bg + '22;color:' + bg + ';white-space:nowrap">' + escape(String(text)) + '</span>';
}

var STATUS_COLORS = {
  PENDING: 'yellow', PENDING_PAYMENT: 'yellow', CONFIRMED: 'blue',
  VENDOR_ASSIGNED: 'blue', VENDOR_EN_ROUTE: 'purple', EN_ROUTE: 'purple',
  STARTED: 'purple', IN_PROGRESS: 'purple', EXTRA_WORK_ADDED: 'orange',
  COMPLETED: 'green', INVOICED: 'green', CLOSED: 'gray',
  CANCELLED: 'red', REFUNDED: 'orange',
  ACTIVE: 'green', SUSPENDED: 'red', REJECTED: 'red', PENDING_VERIFICATION: 'yellow',
  PAID: 'green', UNPAID: 'yellow', FAILED: 'red', PARTIAL: 'orange',
  NEW: 'blue', CONTACTED: 'purple', QUALIFIED: 'green', CONVERTED: 'green',
  LOST: 'red', ON_HOLD: 'yellow',
};
function statusBadge(s) { return badge(s, STATUS_COLORS[s] || 'gray'); }

var SIDEBAR_HTML = '<div class="sidebar">' +
  '<div class="sidebar-brand"><div class="logo">Remont <span>ADMIN</span></div><div class="tagline">Platform Management</div></div>' +
  '<div class="nav-group"><div class="nav-label">Overview</div>' +
    '<a class="nav-item" href="/admin/dashboard.html" data-page="dashboard"><span class="nav-icon">📊</span> Dashboard</a>' +
    '<a class="nav-item" href="/admin/reports.html" data-page="reports"><span class="nav-icon">📈</span> Reports</a>' +
  '</div>' +
  '<div class="nav-group"><div class="nav-label">People</div>' +
    '<a class="nav-item" href="/admin/customers.html" data-page="customers"><span class="nav-icon">👥</span> Customers</a>' +
    '<a class="nav-item" href="/admin/users.html" data-page="users"><span class="nav-icon">👤</span> All Users</a>' +
    '<a class="nav-item" href="/admin/vendors.html" data-page="vendors"><span class="nav-icon">🏪</span> Service Men</a>' +
    '<a class="nav-item" href="/admin/membership.html" data-page="membership"><span class="nav-icon">💎</span> Membership</a>' +
    '<a class="nav-item" href="/admin/corporate.html" data-page="corporate"><span class="nav-icon">🏢</span> Corporate</a>' +
    '<a class="nav-item" href="/admin/newsletters.html" data-page="newsletters"><span class="nav-icon">✉️</span> Newsletters</a>' +
  '</div>' +
  '<div class="nav-group"><div class="nav-label">Commerce</div>' +
    '<a class="nav-item" href="/admin/orders.html" data-page="orders"><span class="nav-icon">📦</span> Orders</a>' +
    '<a class="nav-item" href="/admin/payments.html" data-page="payments"><span class="nav-icon">💳</span> Payments</a>' +
    '<a class="nav-item" href="/admin/invoices.html" data-page="invoices"><span class="nav-icon">🧾</span> Invoices</a>' +
    '<a class="nav-item" href="/admin/wallet.html" data-page="wallet"><span class="nav-icon">💰</span> Wallet</a>' +
    '<a class="nav-item" href="/admin/amc.html" data-page="amc"><span class="nav-icon">🔒</span> AMC Plans</a>' +
    '<a class="nav-item" href="/admin/coupons.html" data-page="coupons"><span class="nav-icon">🏷</span> Coupons</a>' +
    '<a class="nav-item" href="/admin/taxes.html" data-page="taxes"><span class="nav-icon">📊</span> Taxes</a>' +
  '</div>' +
  '<div class="nav-group"><div class="nav-label">CRM</div>' +
    '<a class="nav-item" href="/admin/leads.html" data-page="leads"><span class="nav-icon">🎯</span> Leads</a>' +
    '<a class="nav-item" href="/admin/reviews.html" data-page="reviews"><span class="nav-icon">⭐</span> Reviews</a>' +
  '</div>' +
  '<div class="nav-group"><div class="nav-label">Catalog</div>' +
    '<a class="nav-item" href="/admin/services.html" data-page="services"><span class="nav-icon">🔧</span> Services</a>' +
    '<a class="nav-item" href="/admin/products.html" data-page="products"><span class="nav-icon">🛍</span> Products</a>' +
    '<a class="nav-item" href="/admin/cities.html" data-page="cities"><span class="nav-icon">🏙</span> Cities</a>' +
  '</div>' +
  '<div class="nav-group"><div class="nav-label">Content</div>' +
    '<a class="nav-item" href="/admin/banners.html" data-page="banners"><span class="nav-icon">🖼</span> Front Slider</a>' +
    '<a class="nav-item" href="/admin/ads.html" data-page="ads"><span class="nav-icon">📢</span> Seasonal Ads</a>' +
    '<a class="nav-item" href="/admin/blogs.html" data-page="blogs"><span class="nav-icon">📝</span> Blog</a>' +
    '<a class="nav-item" href="/admin/faqs.html" data-page="faqs"><span class="nav-icon">❓</span> FAQs</a>' +
  '</div>' +
  '<div class="nav-group"><div class="nav-label">Platform</div>' +
    '<a class="nav-item" href="/admin/ai-tools.html" data-page="ai-tools"><span class="nav-icon">🤖</span> AI Tools</a>' +
    '<a class="nav-item" href="/admin/integrations.html" data-page="integrations"><span class="nav-icon">🔌</span> Integrations</a>' +
    '<a class="nav-item" href="/admin/settings.html" data-page="settings"><span class="nav-icon">⚙️</span> Settings</a>' +
    '<a class="nav-item" href="/admin/staff.html" data-page="staff"><span class="nav-icon">👔</span> Staff</a>' +
  '</div>' +
  '<div class="sidebar-footer">Remont India © 2025</div>' +
'</div>';

function renderSidebar(page) {
  var el = document.getElementById('sidebar-mount');
  if (el) {
    el.innerHTML = SIDEBAR_HTML;
    document.querySelectorAll('.nav-item').forEach(function(a) {
      a.classList.toggle('active', a.getAttribute('data-page') === page);
    });
  }
}

// ── IMAGE COMPRESSION ────────────────────────────────────────────────
// Canvas-based client-side compression. Quality 0.88 = visually lossless for web.
// cb(dataUrl, origKB, compKB)
function compressImage(file, cb, maxDim, quality) {
  maxDim = maxDim || 1600;
  quality = quality || 0.88;
  var reader = new FileReader();
  reader.onload = function(e) {
    var img = new Image();
    img.onload = function() {
      var w = img.width, h = img.height;
      var scale = Math.min(1, maxDim / Math.max(w, h));
      w = Math.round(w * scale); h = Math.round(h * scale);
      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      var out = canvas.toDataURL('image/jpeg', quality);
      cb(out, Math.round(file.size / 1024), Math.round(out.length * 0.75 / 1024));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// Attach "📷 Upload" button next to any image URL text input.
// After picking a file it compresses, fills the input, and shows a preview.
// opts: { maxDim, quality, previewW, previewH }
function attachImageUpload(inputId, opts) {
  var input = document.getElementById(inputId);
  if (!input) return;
  opts = opts || {};
  var maxDim = opts.maxDim || 1600;
  var quality = opts.quality || 0.88;
  var previewW = opts.previewW || 130;
  var previewH = opts.previewH || 78;

  var fileInp = document.createElement('input');
  fileInp.type = 'file'; fileInp.accept = 'image/*'; fileInp.style.display = 'none';

  var btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'btn btn-outline btn-sm';
  btn.style.cssText = 'margin-top:6px;font-size:12px;display:inline-flex;align-items:center;gap:5px;';
  btn.innerHTML = '📷 Upload Image';
  btn.onclick = function() { fileInp.click(); };

  var info = document.createElement('span');
  info.style.cssText = 'display:none;font-size:11px;font-weight:600;color:#22c55e;margin-left:8px;vertical-align:middle';

  var thumb = document.createElement('img');
  thumb.style.cssText = 'display:none;width:' + previewW + 'px;height:' + previewH + 'px;object-fit:cover;border-radius:6px;border:1.5px solid #e5e7eb;margin-top:6px;';

  fileInp.onchange = function() {
    var file = fileInp.files[0]; if (!file) return;
    btn.disabled = true; btn.innerHTML = '⏳ Compressing…';
    compressImage(file, function(dataUrl, origKB, compKB) {
      input.value = dataUrl;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      thumb.src = dataUrl; thumb.style.display = 'block';
      info.textContent = '✓ ' + compKB + ' KB (was ' + origKB + ' KB)';
      info.style.display = 'inline';
      btn.disabled = false; btn.innerHTML = '📷 Change Image';
      fileInp.value = '';
    }, maxDim, quality);
  };

  // Hide stale preview when admin manually types a URL
  input.addEventListener('input', function() {
    if (input.value && !input.value.startsWith('data:')) {
      thumb.style.display = 'none'; info.style.display = 'none';
      btn.innerHTML = '📷 Upload Image';
    }
  });

  var row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;';
  row.appendChild(btn); row.appendChild(info);

  var p = input.parentNode;
  p.insertBefore(fileInp, input.nextSibling);
  p.insertBefore(row, fileInp.nextSibling);
  p.insertBefore(thumb, row.nextSibling);
}

// Attach a "📷" upload button for multi-image gallery/chip inputs.
// After compression it sets the input value and calls addFn() to push to the array.
function attachGalleryUpload(inputId, addFn, opts) {
  var input = document.getElementById(inputId);
  if (!input) return;
  opts = opts || {};
  var maxDim = opts.maxDim || 1200;
  var quality = opts.quality || 0.88;

  var fileInp = document.createElement('input');
  fileInp.type = 'file'; fileInp.accept = 'image/*'; fileInp.style.display = 'none';

  var btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'btn btn-outline btn-sm';
  btn.style.cssText = 'font-size:12px;white-space:nowrap;';
  btn.title = 'Upload & compress image';
  btn.innerHTML = '📷 Upload';
  btn.onclick = function() { fileInp.click(); };

  fileInp.onchange = function() {
    var file = fileInp.files[0]; if (!file) return;
    btn.disabled = true; btn.innerHTML = '⏳';
    compressImage(file, function(dataUrl, origKB, compKB) {
      input.value = dataUrl;
      addFn();
      btn.disabled = false; btn.innerHTML = '📷 Upload';
      fileInp.value = '';
      if (typeof toast === 'function') toast('Image compressed: ' + compKB + 'KB (was ' + origKB + 'KB)');
    }, maxDim, quality);
  };

  // Insert right after the existing "Add" button
  var addBtn = input.nextElementSibling;
  var ref = addBtn ? addBtn.nextSibling : input.nextSibling;
  input.parentNode.insertBefore(fileInp, ref);
  input.parentNode.insertBefore(btn, fileInp.nextSibling);
}

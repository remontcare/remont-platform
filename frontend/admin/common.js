/* Remont Admin — Shared Auth + API + Sidebar
 * Uses the same canonical token keys as every other portal (see
 * frontend/shared/remont-auth.js) — this file stays self-contained (no
 * <script> dependency added to the ~35 admin pages that include it) but
 * reads/writes the identical localStorage keys admin/index.html's OTP login
 * already writes via RemontAuth.
 */
var API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';

function getToken() { return localStorage.getItem('remont_access_token'); }
function getRefreshToken() { return localStorage.getItem('remont_refresh_token'); }
function getAdminUser() {
  try { return JSON.parse(localStorage.getItem('remont_user') || '{}'); } catch(e) { return {}; }
}
function isSuperAdmin() { return getAdminUser().role === 'SUPER_ADMIN'; }

function requireAuth() {
  var token = getToken();
  var user = getAdminUser();
  if (!token || ['ADMIN','SUPER_ADMIN'].indexOf(user.role) === -1) {
    window.location.replace('/admin/index.html');
    return false;
  }
  var el = document.getElementById('admin-name');
  if (el) el.textContent = user.name || user.phone || 'Admin';
  var el2 = document.getElementById('tb-uname');
  if (el2) el2.textContent = user.name || user.phone || 'Admin';
  var el3 = document.getElementById('tb-avatar-initial');
  if (el3) el3.textContent = (user.name || 'A').charAt(0).toUpperCase();
  return true;
}

function logout() {
  var rt = getRefreshToken();
  if (rt) {
    fetch(API_BASE + '/api/v1/auth/logout', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    }).catch(function(){});
  }
  localStorage.removeItem('remont_access_token');
  localStorage.removeItem('remont_refresh_token');
  localStorage.removeItem('remont_user');
  window.location.replace('/admin/index.html');
}

function _refreshAdminToken() {
  var rt = getRefreshToken();
  if (!rt) return Promise.reject(new Error('No refresh token'));
  return fetch(API_BASE + '/api/v1/auth/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: rt }),
  }).then(function(r){ return r.json(); }).then(function(d){
    var payload = d && d.data !== undefined ? d.data : d;
    if (!payload || !payload.accessToken) throw new Error('Refresh failed');
    localStorage.setItem('remont_access_token', payload.accessToken);
    localStorage.setItem('remont_refresh_token', payload.refreshToken);
    return payload;
  });
}

function api(method, path, body, _isRetry) {
  var token = getToken();
  var opts = { method: method.toUpperCase(), headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(API_BASE + '/api/v1' + path, opts).then(function(r) {
    if (r.status === 401 && !_isRetry && getRefreshToken()) {
      return _refreshAdminToken().then(function(){
        return api(method, path, body, true);
      }).catch(function(){ logout(); });
    }
    return r.json().then(function(d) {
      if (r.status === 401) { logout(); return; }
      if (!r.ok) throw new Error((d && d.message) ? (Array.isArray(d.message) ? d.message.join(', ') : d.message) : ('HTTP ' + r.status));
      return d.data !== undefined ? d.data : d;
    });
  });
}

// Downloads a binary response (e.g. an invoice PDF) that requires the admin's auth
// header — plain <a href> can't carry that, so this fetches as a blob and triggers the
// save via a temporary object URL, same Authorization pattern as uploadImageToServer().
function downloadAuthedFile(path, filename) {
  return fetch(API_BASE + '/api/v1' + path, { headers: { 'Authorization': 'Bearer ' + getToken() } })
    .then(function(r) {
      if (!r.ok) return r.json().then(function(d) { throw new Error((d && d.message) || ('HTTP ' + r.status)); });
      return r.blob();
    })
    .then(function(blob) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
    });
}

function toast(msg, type) {
  var t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;padding:12px 20px;border-radius:10px;color:#fff;font-size:13px;font-weight:500;box-shadow:0 4px 16px rgba(0,0,0,.2);transition:opacity .3s;max-width:340px;display:flex;align-items:center;gap:10px';
  var icons = { success: '✓', error: '✕', warning: '⚠' };
  t.style.background = type === 'error' ? '#ef4444' : type === 'warning' ? '#f59e0b' : '#22c55e';
  t.innerHTML = '<span style="font-size:16px">' + (icons[type]||'ℹ') + '</span>' + msg;
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

// Escapes ' as &#39; too, not just "  — most call sites interpolate this into
// onclick="...('...')" (a single-quoted JS string inside a double-quoted HTML
// attribute), where an unescaped apostrophe in user-controlled data (e.g. a
// partner's business name) breaks out of the JS string and can execute arbitrary
// script in the admin's browser. &#39; renders as a normal apostrophe everywhere.
function escape(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// For a value embedded as a single-quoted JS string argument inside an inline
// onclick="...('...')" attribute — NOT a substitute for escape() on plain text/attribute
// content. The browser HTML-decodes attribute values before parsing them as JS, so
// HTML-entity-escaping a quote (e.g. &#39;) decodes right back to ' before the JS parser
// ever sees it and does not prevent breaking out of the string literal. This escapes the
// backslash/quote for the JS layer first, then HTML-escapes the result for the attribute.
function escapeJsAttr(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function badge(text, color) {
  var colors = { green:'#22c55e', blue:'#3b82f6', yellow:'#f59e0b', red:'#ef4444', gray:'#6b7280', purple:'#8b5cf6', orange:'#f97316', teal:'#14b8a6' };
  var bg = colors[color] || colors.gray;
  return '<span style="display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600;background:' + bg + '22;color:' + bg + ';white-space:nowrap">' + escape(String(text)) + '</span>';
}

var STATUS_COLORS = {
  PENDING:'yellow', PENDING_PAYMENT:'yellow', CONFIRMED:'blue',
  VENDOR_ASSIGNED:'blue', VENDOR_EN_ROUTE:'purple', EN_ROUTE:'purple',
  STARTED:'purple', IN_PROGRESS:'purple', EXTRA_WORK_ADDED:'orange',
  COMPLETED:'green', INVOICED:'green', CLOSED:'gray',
  CANCELLED:'red', REFUNDED:'orange',
  ACTIVE:'green', SUSPENDED:'red', REJECTED:'red', PENDING_VERIFICATION:'yellow',
  PAID:'green', UNPAID:'yellow', FAILED:'red', PARTIAL:'orange',
  NEW:'blue', CONTACTED:'purple', QUALIFIED:'green', CONVERTED:'green',
  LOST:'red', ON_HOLD:'yellow', PROPOSAL_SENT:'orange', NEGOTIATION:'purple',
};
function statusBadge(s) { return badge(s, STATUS_COLORS[s] || 'gray'); }

// ── SIDEBAR ──────────────────────────────────────────────────────

var SIDEBAR_NAV = [
  { section: '📊 DASHBOARD', items: [
    { key:'dashboard', label:'Dashboard', icon:'🏠', href:'/admin/dashboard.html' },
  ]},
  { section: '📦 ORDERS', items: [
    { key:'orders', label:'All Orders', icon:'📋', href:'/admin/orders.html' },
    { key:'master-orders', label:'Master Orders', icon:'🧩', href:'/admin/master-orders.html' },
    { key:'orders-new', label:'New Orders', icon:'🔵', href:'/admin/orders.html?status=PENDING', badge:'new' },
    { key:'orders-active', label:'Active Orders', icon:'🟡', href:'/admin/orders.html?status=IN_PROGRESS', badge:'active' },
    { key:'orders-done', label:'Completed Orders', icon:'🟢', href:'/admin/orders.html?status=COMPLETED', badge:'completed' },
    { key:'orders-cancelled', label:'Cancelled Orders', icon:'🔴', href:'/admin/orders.html?status=CANCELLED', badge:'cancelled' },
    { key:'returns', label:'Returns & Refunds', icon:'↩️', href:'/admin/orders.html?status=REFUNDED' },
  ]},
  { section: '🛠 SERVICES', items: [
    { key:'services', label:'Service Management', icon:'🔧', href:'/admin/services.html' },
    { key:'service-pricing', label:'Service Pricing', icon:'💲', href:'/admin/service-pricing.html' },
    { key:'catalog-relations', label:'Recommendations', icon:'🔗', href:'/admin/catalog-relations.html' },
  ]},
  { section: '🛒 PRODUCTS', items: [
    { key:'products', label:'Products', icon:'📦', href:'/admin/products.html' },
    { key:'inventory', label:'Inventory', icon:'🏭', href:'/admin/inventory.html' },
    { key:'brands', label:'Brands', icon:'🏷️', href:'/admin/brands.html' },
  ]},
  { section: '👨‍🔧 PARTNERS', items: [
    { key:'vendors', label:'All Partners', icon:'👷', href:'/admin/vendors.html' },
    { key:'vendors-pending', label:'Partner Applications', icon:'📩', href:'/admin/vendors.html?tab=pending', badge:'partners' },
    { key:'product-sellers', label:'Product Sellers', icon:'🛒', href:'/admin/vendors.html?tab=sellers' },
    { key:'seller-apps', label:'Seller Applications', icon:'📋', href:'/admin/vendors.html?tab=seller-apps' },
    { key:'partner-ratings', label:'Partner Ratings', icon:'⭐', href:'/admin/reviews.html' },
    { key:'partner-earnings', label:'Partner Earnings', icon:'💰', href:'/admin/partner-earnings.html' },
    { key:'product-seller-earnings', label:'Product Seller Payouts', icon:'🧾', href:'/admin/product-seller-earnings.html' },
    { key:'agencies', label:'Agencies', icon:'🏢', href:'/admin/agencies.html' },
    { key:'partner-id-cards', label:'Partner ID Cards', icon:'🪪', href:'/admin/partner-id-cards.html' },
  ]},
  { section: '📦 LOGISTICS', items: [
    { key:'logistics', label:'Deliveries & Returns', icon:'🚚', href:'/admin/logistics.html' },
  ]},
  { section: '🚚 SUPPLIERS', items: [
    { key:'suppliers', label:'Suppliers', icon:'🏭', href:'/admin/suppliers.html' },
    { key:'purchase-orders', label:'Purchase Orders', icon:'📄', href:'/admin/purchase-orders.html' },
  ]},
  { section: '🎯 LEADS', items: [
    { key:'leads', label:'Lead Pipeline', icon:'🎯', href:'/admin/leads.html' },
  ]},
  { section: '👥 CUSTOMERS', items: [
    { key:'customers', label:'Customers', icon:'👥', href:'/admin/customers.html' },
    { key:'corporate', label:'Corporate Customers', icon:'🏢', href:'/admin/corporate.html' },
    { key:'membership', label:'Membership', icon:'💎', href:'/admin/membership.html' },
  ]},
  { section: '💰 FINANCE', items: [
    { key:'payments', label:'Payments', icon:'💳', href:'/admin/payments.html' },
    { key:'refunds', label:'Refund Requests', icon:'↩️', href:'/admin/refunds.html' },
    { key:'support-cases', label:'Help & Support', icon:'🎧', href:'/admin/support-cases.html' },
    { key:'wallet', label:'Wallet', icon:'👛', href:'/admin/wallet.html' },
    { key:'invoices', label:'Invoices', icon:'🧾', href:'/admin/invoices.html' },
    { key:'coupons', label:'Coupons', icon:'🏷', href:'/admin/coupons.html' },
    { key:'taxes', label:'Taxes', icon:'📊', href:'/admin/taxes.html' },
  ]},
  { section: '📢 MARKETING', items: [
    { key:'banners', label:'Front Slider', icon:'🖼', href:'/admin/banners.html' },
    { key:'ads', label:'Seasonal Ads', icon:'📢', href:'/admin/ads.html' },
    { key:'offers', label:'Offers', icon:'🎁', href:'/admin/offers.html' },
    { key:'blogs', label:'Blog', icon:'📝', href:'/admin/blogs.html' },
    { key:'newsletters', label:'Newsletter', icon:'✉️', href:'/admin/newsletters.html' },
    { key:'faqs', label:'FAQs', icon:'❓', href:'/admin/faqs.html' },
  ]},
  { section: '📈 REPORTS', items: [
    { key:'reports', label:'Sales Report', icon:'📈', href:'/admin/reports.html?type=sales' },
    { key:'reports-revenue', label:'Revenue Report', icon:'💹', href:'/admin/reports.html?type=revenue' },
    { key:'reports-service', label:'Service Report', icon:'🔧', href:'/admin/reports.html?type=service' },
    { key:'reports-product', label:'Product Report', icon:'📦', href:'/admin/reports.html?type=product' },
    { key:'reports-partner', label:'Partner Report', icon:'👷', href:'/admin/reports.html?type=partner' },
    { key:'reports-customer', label:'Customer Report', icon:'👥', href:'/admin/reports.html?type=customer' },
  ]},
  { section: '⚙ SETTINGS', items: [
    { key:'payment-gateways', label:'Payment Gateways', icon:'💳', href:'/admin/payment-gateways.html' },
    { key:'cities', label:'Cities', icon:'🏙', href:'/admin/cities.html' },
    { key:'users', label:'Users & Roles', icon:'👤', href:'/admin/users.html' },
    { key:'delete-requests', label:'Delete Requests', icon:'🗑️', href:'/admin/delete-requests.html', superAdminOnly:true },
    { key:'audit-logs', label:'Audit Logs', icon:'📜', href:'/admin/audit-logs.html', superAdminOnly:true },
    { key:'settings', label:'Website Settings', icon:'🌐', href:'/admin/settings.html' },
    { key:'legal-policies', label:'Legal & Policies', icon:'⚖️', href: (location.hostname === 'localhost' ? '/admin/legal-policies.html' : '/admin/settings/legal-policies') },
    { key:'ai-tools', label:'AI Chat Settings', icon:'🤖', href:'/admin/ai-tools.html' },
    { key:'staff', label:'System Settings', icon:'⚙️', href:'/admin/staff.html' },
  ]},
];

function renderSidebar(page) {
  var el = document.getElementById('sidebar-mount');
  if (!el) return;

  var html = '<div class="sidebar">';
  html += '<div class="sidebar-brand">';
  html += '<div class="sb-logo-circle">R</div>';
  html += '<div class="sb-brand-text"><div class="sb-name">REMONT INDIA</div><div class="sb-sub">Admin Panel</div></div>';
  html += '</div>';

  SIDEBAR_NAV.forEach(function(section) {
    html += '<div class="nav-section">';
    html += '<div class="nav-section-label">' + section.section + '</div>';
    section.items.forEach(function(item) {
      if (item.superAdminOnly && !isSuperAdmin()) return;
      var isActive = item.key === page;
      html += '<a class="nav-item' + (isActive ? ' active' : '') + '" href="' + item.href + '" data-page="' + item.key + '">';
      html += '<span class="nav-icon">' + item.icon + '</span>';
      html += '<span>' + item.label + '</span>';
      html += '</a>';
    });
    html += '</div>';
  });

  html += '<div class="sidebar-footer">Remont India © 2025</div>';
  html += '</div>';

  el.innerHTML = html;
}

// ── IMAGE COMPRESSION ─────────────────────────────────────────────
// Task 3 — one click, real server-side WebP + responsive sizes (thumb/card/full), via
// POST /api/v1/uploads/image, which runs the central media pipeline (security checks,
// virus scan, R2 master, Cloudinary delivery, Media Library record — see
// backend/src/modules/media). entityType (PRODUCT, SERVICE, BANNER, …) files the image in
// the right Media Library folder. There is deliberately NO client-side base64 fallback any
// more: a failed upload is reported, never silently saved as an inline data: image.
function uploadImageToServer(file, onDone, onError, entityType) {
  var fd = new FormData();
  fd.append('file', file);
  if (entityType) fd.append('entityType', entityType);
  fetch(API_BASE + '/api/v1/uploads/image', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + getToken() },
    body: fd,
  }).then(function(r) {
    return r.json().then(function(d) {
      if (!r.ok) throw new Error((d && d.message) ? (Array.isArray(d.message) ? d.message.join(', ') : d.message) : ('HTTP ' + r.status));
      return d.data !== undefined ? d.data : d;
    });
  }).then(onDone).catch(function(e) { if (onError) onError(e); });
}

function attachImageUpload(inputId, opts) {
  var input = document.getElementById(inputId);
  if (!input) return;
  opts = opts || {};
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

  function applyUploadedUrl(url, label) {
    input.value = url;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    thumb.src = url; thumb.style.display = 'block';
    info.textContent = label; info.style.display = 'inline';
    btn.disabled = false; btn.innerHTML = '📷 Change Image';
    fileInp.value = '';
  }

  fileInp.onchange = function() {
    var file = fileInp.files[0]; if (!file) return;
    btn.disabled = true; btn.innerHTML = '⏳ Uploading…';
    uploadImageToServer(file, function(urls) {
      applyUploadedUrl(urls.full, '✓ Optimized (WebP)');
    }, function(e) {
      // No base64 fallback — the field keeps its previous value and the admin can retry.
      btn.disabled = false; btn.innerHTML = '📷 Upload Image';
      fileInp.value = '';
      if (typeof toast === 'function') toast('Image upload failed: ' + e.message, 'error');
    }, opts.entityType);
  };

  input.addEventListener('input', function() {
    // '/api/uploads/' covers old pre-Cloudinary uploads still saved in the DB;
    // 'res.cloudinary.com' covers current ones — either means "already uploaded".
    var v = input.value;
    if (v && v.indexOf('data:') !== 0 && v.indexOf('/api/uploads/') === -1 && v.indexOf('res.cloudinary.com') === -1) {
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

// Task 8 — promo video upload for categories/sub-categories/services, via
// POST /api/v1/uploads/video. No client-side fallback (unlike images): a multi-MB
// video as a data: URI is impractical, so a failed upload just surfaces an error toast
// and the admin can still paste an external URL (YouTube/Vimeo/etc.) into the same field.
function uploadVideoToServer(file, onDone, onError) {
  var fd = new FormData();
  fd.append('file', file);
  fetch(API_BASE + '/api/v1/uploads/video', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + getToken() },
    body: fd,
  }).then(function(r) {
    return r.json().then(function(d) {
      if (!r.ok) throw new Error((d && d.message) ? (Array.isArray(d.message) ? d.message.join(', ') : d.message) : ('HTTP ' + r.status));
      return d.data !== undefined ? d.data : d;
    });
  }).then(onDone).catch(function(e) { if (onError) onError(e); });
}

// Attaches an "Upload video" button next to a text input that also accepts a pasted
// external URL (YouTube/Vimeo/etc.) — mirrors attachImageUpload's button-next-to-input pattern.
function attachVideoUpload(inputId) {
  var input = document.getElementById(inputId);
  if (!input) return;

  var fileInp = document.createElement('input');
  fileInp.type = 'file'; fileInp.accept = 'video/*'; fileInp.style.display = 'none';

  var btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'btn btn-outline btn-sm';
  btn.style.cssText = 'margin-top:6px;font-size:12px;display:inline-flex;align-items:center;gap:5px;';
  btn.innerHTML = '🎬 Upload Video';
  btn.onclick = function() { fileInp.click(); };

  var info = document.createElement('span');
  info.style.cssText = 'display:none;font-size:11px;font-weight:600;color:#22c55e;margin-left:8px;vertical-align:middle';

  fileInp.onchange = function() {
    var file = fileInp.files[0]; if (!file) return;
    btn.disabled = true; btn.innerHTML = '⏳ Uploading…';
    uploadVideoToServer(file, function(res) {
      input.value = res.url;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      info.textContent = '✓ Uploaded'; info.style.display = 'inline';
      btn.disabled = false; btn.innerHTML = '🎬 Change Video';
      fileInp.value = '';
    }, function(e) {
      btn.disabled = false; btn.innerHTML = '🎬 Upload Video';
      fileInp.value = '';
      if (typeof toast === 'function') toast('Video upload failed: ' + e.message, 'error');
    });
  };

  var row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;flex-wrap:wrap;';
  row.appendChild(btn); row.appendChild(info);

  var p = input.parentNode;
  p.insertBefore(fileInp, input.nextSibling);
  p.insertBefore(row, fileInp.nextSibling);
}

function attachGalleryUpload(inputId, addFn, opts) {
  var input = document.getElementById(inputId);
  if (!input) return;
  opts = opts || {};

  var fileInp = document.createElement('input');
  fileInp.type = 'file'; fileInp.accept = 'image/*'; fileInp.style.display = 'none';

  var btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'btn btn-outline btn-sm';
  btn.style.cssText = 'font-size:12px;white-space:nowrap;';
  btn.innerHTML = '📷 Upload';
  btn.onclick = function() { fileInp.click(); };

  fileInp.onchange = function() {
    var file = fileInp.files[0]; if (!file) return;
    btn.disabled = true; btn.innerHTML = '⏳';
    uploadImageToServer(file, function(urls) {
      // Default: the 600px card variant (gallery thumbnails). opts.variant: 'full' stores the
      // 1200px image instead, for galleries that feed a detail page (products).
      input.value = opts.variant === 'full' ? urls.full : urls.card;
      addFn();
      btn.disabled = false; btn.innerHTML = '📷 Upload';
      fileInp.value = '';
      if (typeof toast === 'function') toast('Image uploaded and optimized (WebP)');
    }, function(e) {
      // No base64 fallback — nothing is added and the admin can retry.
      btn.disabled = false; btn.innerHTML = '📷 Upload';
      fileInp.value = '';
      if (typeof toast === 'function') toast('Image upload failed: ' + e.message, 'error');
    }, opts.entityType);
  };

  var addBtn = input.nextElementSibling;
  var ref = addBtn ? addBtn.nextSibling : input.nextSibling;
  input.parentNode.insertBefore(fileInp, ref);
  input.parentNode.insertBefore(btn, fileInp.nextSibling);
}

// ── AI IMAGE GENERATION ───────────────────────────────────────────────
// "Generate with AI" next to any image field. The whole flow lives here so an admin never
// opens Cloudinary: the backend builds the prompt from Remont's presets, generates the
// image, runs it through the SAME media pipeline as an upload (validation, virus scan,
// sharp, Cloudinary) and returns hosted URLs. Nothing is attached to the record until the
// admin picks an image — and replacing an existing image always asks first.
var _aiPresets = null;
function loadAiImagePresets() {
  if (_aiPresets) return Promise.resolve(_aiPresets);
  return api('GET', '/admin/ai/image-presets').then(function(r) { _aiPresets = r; return r; });
}

function _aiModal() {
  var el = document.getElementById('ai-img-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'ai-img-overlay'; el.className = 'overlay'; el.style.display = 'none';
  el.innerHTML =
    '<div class="modal" style="max-width:720px">' +
      '<div class="modal-header">' +
        '<span class="modal-title" id="ai-img-title">Generate with AI</span>' +
        '<button class="modal-close" type="button" onclick="closeAiImageModal()">&times;</button>' +
      '</div>' +
      '<div id="ai-img-body">' +
        '<div class="form-group" id="ai-img-mode-wrap" style="display:none"><label class="form-label">What to generate</label>' +
          '<select id="ai-img-mode" class="form-control"></select></div>' +
        '<div class="form-group"><label class="form-label">Subject</label>' +
          '<input id="ai-img-name" class="form-control" placeholder="e.g. AC Repair"></div>' +
        '<div class="form-group" id="ai-img-context" style="font-size:12px;color:#6b7280"></div>' +
        '<div class="form-group" id="ai-img-ref-wrap" style="display:none">' +
          '<label class="form-label">Reference image <small style="color:#9ca3af">(keeps the real product\'s shape, colour and details)</small></label>' +
          '<div id="ai-img-refs" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px"></div>' +
          '<input type="file" accept="image/*" id="ai-img-ref-file" style="display:none">' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
            '<button type="button" class="btn btn-outline btn-xs" id="ai-img-find">🔎 Find product photo</button>' +
            '<button type="button" class="btn btn-outline btn-xs" id="ai-img-ref-upload">⬆ Upload reference image</button>' +
          '</div>' +
          '<div id="ai-img-found" style="display:none;margin-top:8px">' +
            '<div style="font-size:12px;color:#6b7280;margin-bottom:6px">Pick the correct product — it is imported into Remont media and used as the reference:</div>' +
            '<div id="ai-img-found-list" style="display:flex;gap:8px;flex-wrap:wrap"></div>' +
          '</div>' +
        '</div>' +
        '<div class="form-group"><label class="form-label">Image style</label>' +
          '<div id="ai-img-styles" style="display:flex;flex-wrap:wrap;gap:6px"></div></div>' +
        '<div class="form-row" style="gap:12px">' +
          '<div class="form-group" id="ai-img-count-wrap" style="flex:0 0 150px"><label class="form-label">How many</label>' +
            '<select id="ai-img-count" class="form-control"></select></div>' +
          '<div class="form-group" style="flex:1"><label class="form-label">Aspect ratio</label>' +
            '<input id="ai-img-aspect" class="form-control" readonly style="background:#f9fafb"></div>' +
        '</div>' +
        // Advanced, collapsed by default: the admin normally only sets Subject / Style /
        // How many. The Remont house style, brand and negative-quality rules are applied
        // server-side and are deliberately NOT shown here as editable text.
        '<details id="ai-img-advanced" style="margin-bottom:12px">' +
          '<summary style="cursor:pointer;font-size:12px;color:#6b7280">Advanced — edit prompt</summary>' +
          '<div class="form-group" style="margin-top:8px">' +
            '<textarea id="ai-img-prompt" class="form-control" rows="3" maxlength="1200" style="resize:vertical"></textarea>' +
            '<div style="display:flex;align-items:center;gap:10px;margin-top:6px">' +
              '<button type="button" class="btn btn-outline btn-xs" onclick="resetAiPrompt()">↺ Reset</button>' +
              '<small style="color:#9ca3af">Remont style &amp; quality rules are added automatically.</small>' +
            '</div>' +
          '</div>' +
        '</details>' +
        '<div id="ai-img-status" style="display:none;font-size:13px;color:#6b7280;padding:10px 0"></div>' +
        '<div id="ai-img-error" style="display:none;font-size:13px;color:#dc2626;padding:8px 0"></div>' +
        '<div id="ai-img-results" style="display:none;gap:12px;flex-wrap:wrap;margin-top:6px"></div>' +
      '</div>' +
      '<div class="modal-footer" style="display:flex;gap:8px;justify-content:flex-end">' +
        '<button type="button" class="btn btn-outline" onclick="closeAiImageModal()">Cancel</button>' +
        '<button type="button" class="btn btn-primary" id="ai-img-go" onclick="runAiImageGeneration()">✨ Generate</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(el);
  return el;
}

var _aiState = { opts: null, preset: null, busy: false };

function closeAiImageModal() {
  if (_aiState.busy) return; // never cancel mid-generation — the image is already being paid for
  var el = document.getElementById('ai-img-overlay');
  if (el) el.style.display = 'none';
}

function _aiSelectedStyles() {
  return Array.prototype.slice.call(document.querySelectorAll('#ai-img-styles input:checked')).map(function(c) { return c.value; });
}

function _aiSelectedRefs() {
  return Array.prototype.slice.call(document.querySelectorAll('#ai-img-refs .ai-ref.on')).map(function(el) { return el.getAttribute('data-url'); });
}

/** Imports a found web photo through the media pipeline (validation, virus scan, Cloudinary)
 *  and adds the stored asset as the selected reference. The raw web URL is never used
 *  directly for generation. */
function _aiImportReference(url, thumbEl) {
  if (thumbEl) { thumbEl.style.opacity = '0.4'; thumbEl.style.borderColor = '#f97316'; }
  _aiError(''); _aiStatus('Importing the selected product photo…');
  api('POST', '/admin/ai/product-photos/import', { url: url })
    .then(function(media) {
      var stored = (media.variants && media.variants.full) || media.deliveryUrl;
      var existing = _aiSelectedRefs();
      var opts = _aiState.opts;
      _aiRenderRefs(((opts.references && opts.references()) || []).concat(existing).concat([stored]), false);
      Array.prototype.slice.call(document.querySelectorAll('#ai-img-refs .ai-ref')).forEach(function(el) {
        if (el.getAttribute('data-url') === stored) { el.className = 'ai-ref on'; el.style.borderColor = '#f97316'; }
      });
      _aiStatus('');
      if (typeof toast === 'function') toast('Product photo imported — it will guide the generation', 'success');
    })
    .catch(function(e) { _aiStatus(''); _aiError(e.message); })
    .then(function() { if (thumbEl) thumbEl.style.opacity = ''; });
}

/** Reference thumbnails: the entity's existing images plus any the admin uploads now.
 *  Click to toggle; Cloudinary accepts up to 4. Uploading goes through the normal media
 *  endpoint, so a reference is itself a validated, virus-scanned, stored image. */
function _aiRenderRefs(urls, selectFirst) {
  var wrap = document.getElementById('ai-img-refs');
  wrap.innerHTML = '';
  (urls || []).forEach(function(url, i) {
    var t = document.createElement('img');
    t.className = 'ai-ref' + (selectFirst && i === 0 ? ' on' : '');
    t.setAttribute('data-url', url);
    t.src = url;
    t.style.cssText = 'width:64px;height:48px;object-fit:cover;border-radius:6px;cursor:pointer;border:2px solid ' + (selectFirst && i === 0 ? '#f97316' : '#e5e7eb');
    t.onclick = function() {
      var on = t.className.indexOf('on') !== -1;
      if (!on && _aiSelectedRefs().length >= 4) { _aiError('At most 4 reference images'); return; }
      t.className = on ? 'ai-ref' : 'ai-ref on';
      t.style.borderColor = on ? '#e5e7eb' : '#f97316';
      _aiError('');
    };
    wrap.appendChild(t);
  });
  if (!wrap.children.length) wrap.innerHTML = '<small style="color:#9ca3af">No existing image — upload one to guide the generation.</small>';
}

/** Loads the short, editable SUBJECT sentence (never the internal style/quality rules —
 *  those stay server-side and are appended when the image is generated). */
function resetAiPrompt() {
  var ctx = _aiState.opts.context ? (_aiState.opts.context() || {}) : {};
  ctx.name = document.getElementById('ai-img-name').value.trim();
  var box = document.getElementById('ai-img-prompt');
  box.value = 'Loading…';
  api('POST', '/admin/ai/image-prompt', {
    entity: _aiState.entity, name: ctx.name, category: ctx.category, subCategory: ctx.subCategory,
    brand: ctx.brand, styles: _aiSelectedStyles(),
  }).then(function(r) {
    box.value = r.subject || '';
    _aiState.suggestedSubject = box.value; // used to tell "untouched" from "admin edited"
  }).catch(function(e) { box.value = ''; _aiError(e.message); });
}

function _aiError(msg) {
  var el = document.getElementById('ai-img-error');
  el.textContent = msg || ''; el.style.display = msg ? 'block' : 'none';
}
function _aiStatus(msg) {
  var el = document.getElementById('ai-img-status');
  el.textContent = msg || ''; el.style.display = msg ? 'block' : 'none';
}

/** Renders the style chips + count for whichever preset the current mode selects. */
function _aiRenderPreset(preselect) {
  var preset = _aiState.preset;
  var wanted = preselect && preselect.length ? preselect : preset.defaultStyles;
  document.getElementById('ai-img-aspect').value = preset.aspect + '  (website standard)';

  var styles = document.getElementById('ai-img-styles');
  styles.innerHTML = '';
  preset.styles.forEach(function(s) {
    var on = wanted.indexOf(s.key) !== -1;
    var lbl = document.createElement('label');
    lbl.className = 'badge ' + (on ? 'badge-orange' : 'badge-gray');
    lbl.style.cssText = 'cursor:pointer;display:inline-flex;align-items:center;gap:5px;padding:6px 10px;font-size:12px';
    lbl.innerHTML = '<input type="checkbox" value="' + escape(s.key) + '"' + (on ? ' checked' : '') + ' style="margin:0">' + escape(s.label);
    lbl.querySelector('input').onchange = function() {
      lbl.className = 'badge ' + (this.checked ? 'badge-orange' : 'badge-gray');
      resetAiPrompt();
    };
    styles.appendChild(lbl);
  });

  var count = document.getElementById('ai-img-count');
  count.innerHTML = '';
  for (var i = 1; i <= preset.maxCount; i++) count.innerHTML += '<option value="' + i + '">' + i + (i === 1 ? ' image' : ' images') + '</option>';
  document.getElementById('ai-img-count-wrap').style.display = preset.maxCount > 1 ? '' : 'none';
}

function openAiImageModal(opts) {
  _aiModal();
  _aiState.opts = opts;
  loadAiImagePresets().then(function(res) {
    if (!res.available) { toast('AI image generation is not configured on the server', 'error'); return; }
    var modes = opts.modes || null;
    var startEntity = modes ? modes[0].entity : opts.entity;
    var presetFor = function(entity) { return res.presets.filter(function(p) { return p.entity === entity; })[0]; };
    if (!presetFor(startEntity)) { toast('No AI preset for ' + startEntity, 'error'); return; }

    var ctx = opts.context ? (opts.context() || {}) : {};
    document.getElementById('ai-img-name').value = ctx.name || '';
    // The entity's own record supplies the rest of the context automatically — the admin
    // never re-types the category/sub-category/brand it is already editing.
    var known = [ctx.category ? 'Category: ' + ctx.category : '', ctx.subCategory ? 'Sub-category: ' + ctx.subCategory : '', ctx.brand ? 'Brand: ' + ctx.brand : ''].filter(Boolean);
    document.getElementById('ai-img-context').textContent = known.length ? 'Using ' + known.join('  ·  ') : '';

    // Reference images (products): the entity's existing images are offered straight away,
    // and the admin can upload another one without leaving the modal.
    var refWrap = document.getElementById('ai-img-ref-wrap');
    if (opts.references) {
      refWrap.style.display = '';
      _aiRenderRefs(opts.references() || [], false);
      // "Find product photo": Tavily search for the REAL product, then the picked candidate
      // is imported through the media pipeline and becomes the generation reference.
      var findBtn = document.getElementById('ai-img-find');
      var foundWrap = document.getElementById('ai-img-found');
      var foundList = document.getElementById('ai-img-found-list');
      findBtn.style.display = (res.search && res.search.available) ? '' : 'none';
      foundWrap.style.display = 'none'; foundList.innerHTML = '';
      findBtn.onclick = function() {
        var c = opts.context ? (opts.context() || {}) : {};
        var subject = document.getElementById('ai-img-name').value.trim();
        if (!subject) { _aiError('Enter the product name first'); return; }
        findBtn.disabled = true; findBtn.textContent = '🔎 Searching…'; _aiError('');
        api('POST', '/admin/ai/product-photos', {
          entity: _aiState.entity, name: subject, brand: c.brand, model: c.model, category: c.category, subCategory: c.subCategory,
        }).then(function(r) {
          foundWrap.style.display = ''; foundList.innerHTML = '';
          r.images.forEach(function(url) {
            var t = document.createElement('img');
            t.src = url; t.title = 'Use this product photo as the reference';
            t.style.cssText = 'width:76px;height:57px;object-fit:cover;border-radius:6px;cursor:pointer;border:2px solid #e5e7eb;background:#f9fafb';
            t.onerror = function() { t.remove(); };
            t.onclick = function() { _aiImportReference(url, t); };
            foundList.appendChild(t);
          });
        }).catch(function(e) { _aiError(e.message); })
          .then(function() { findBtn.disabled = false; findBtn.textContent = '🔎 Find product photo'; });
      };

      var refFile = document.getElementById('ai-img-ref-file');
      var refBtn = document.getElementById('ai-img-ref-upload');
      refBtn.onclick = function() { refFile.click(); };
      refFile.onchange = function() {
        var file = refFile.files[0]; if (!file) return;
        refBtn.disabled = true; refBtn.textContent = '⏳ Uploading…';
        uploadImageToServer(file, function(urls) {
          var current = _aiSelectedRefs().concat([urls.full]);
          _aiRenderRefs((opts.references() || []).concat([urls.full]), false);
          Array.prototype.slice.call(document.querySelectorAll('#ai-img-refs .ai-ref')).forEach(function(el) {
            if (current.indexOf(el.getAttribute('data-url')) !== -1) { el.className = 'ai-ref on'; el.style.borderColor = '#f97316'; }
          });
          refBtn.disabled = false; refBtn.textContent = '⬆ Upload reference image'; refFile.value = '';
        }, function(e) {
          refBtn.disabled = false; refBtn.textContent = '⬆ Upload reference image'; refFile.value = '';
          _aiError('Reference upload failed: ' + e.message);
        }, 'PRODUCT');
      };
    } else {
      refWrap.style.display = 'none';
    }

    var modeWrap = document.getElementById('ai-img-mode-wrap');
    var modeSel = document.getElementById('ai-img-mode');
    if (modes) {
      modeSel.innerHTML = modes.map(function(m, i) { return '<option value="' + i + '">' + escape(m.label) + '</option>'; }).join('');
      modeWrap.style.display = '';
      modeSel.onchange = function() {
        var m = modes[Number(this.value)];
        _aiState.entity = m.entity; _aiState.preset = presetFor(m.entity);
        document.getElementById('ai-img-title').textContent = 'Generate ' + m.label + ' with AI';
        _aiRenderPreset(m.styles);
        resetAiPrompt();
      };
      modeSel.value = '0';
    } else {
      modeWrap.style.display = 'none';
    }

    var mode = modes ? modes[0] : null;
    _aiState.entity = startEntity;
    _aiState.preset = presetFor(startEntity);
    document.getElementById('ai-img-title').textContent = 'Generate ' + (mode ? mode.label : _aiState.preset.label + ' image') + ' with AI';
    _aiRenderPreset(mode && mode.styles);

    document.getElementById('ai-img-results').style.display = 'none';
    document.getElementById('ai-img-results').innerHTML = '';
    _aiError(''); _aiStatus('');
    document.getElementById('ai-img-go').textContent = '✨ Generate';
    document.getElementById('ai-img-overlay').style.display = 'flex';
    resetAiPrompt();
  }).catch(function(e) { toast(e.message, 'error'); });
}

function runAiImageGeneration() {
  if (_aiState.busy) return; // guards double clicks; the server also rejects parallel runs
  var opts = _aiState.opts;
  var ctx = opts.context ? (opts.context() || {}) : {};
  var name = document.getElementById('ai-img-name').value.trim();
  // Only send the prompt when the admin actually edited it under Advanced; otherwise the
  // server builds it from the subject + styles, so nothing internal round-trips.
  var typed = document.getElementById('ai-img-prompt').value.trim();
  var prompt = (typed && typed !== (_aiState.suggestedSubject || '').trim()) ? typed : undefined;
  if (!name && !prompt) { _aiError('Enter a subject, or write a prompt'); return; }

  var go = document.getElementById('ai-img-go');
  _aiState.busy = true; go.disabled = true; go.textContent = '⏳ Generating…';
  _aiError(''); _aiStatus('Generating your professional image… this usually takes 15–40 seconds.');

  api('POST', '/admin/ai/image', {
    entity: _aiState.entity, name: name, category: ctx.category, subCategory: ctx.subCategory, brand: ctx.brand,
    styles: _aiSelectedStyles(), prompt: prompt, count: Number(document.getElementById('ai-img-count').value || 1),
    referenceImages: _aiSelectedRefs(),
  }).then(function(res) {
    _aiStatus(''); go.textContent = '↻ Regenerate';
    var wrap = document.getElementById('ai-img-results');
    wrap.style.display = 'flex'; wrap.innerHTML = '';
    res.images.forEach(function(img) {
      var card = document.createElement('div');
      card.style.cssText = 'border:1px solid #e5e7eb;border-radius:10px;padding:8px;width:210px;max-width:100%';
      card.innerHTML =
        '<img src="' + escape(img.thumb || img.url) + '" style="width:100%;border-radius:6px;display:block">' +
        '<div style="font-size:11px;color:#9ca3af;margin:6px 0 8px">' + escape(img.width + '×' + img.height) + '</div>';
      var use = document.createElement('button');
      use.type = 'button'; use.className = 'btn btn-primary btn-sm'; use.style.width = '100%';
      use.textContent = 'Use this image';
      use.onclick = function() { _aiUseImage(img); };
      card.appendChild(use);
      wrap.appendChild(card);
    });
  }).catch(function(e) {
    _aiStatus(''); _aiError(e.message || 'Generation failed');
    go.textContent = '✨ Generate';
  }).then(function() {
    _aiState.busy = false; go.disabled = false;
  });
}

function _aiUseImage(img) {
  var opts = _aiState.opts;
  if (opts.confirmReplace !== false) {
    var current = opts.currentValue ? opts.currentValue() : '';
    if (current && !confirm('Replace the existing image with this AI-generated one?')) return;
  }
  opts.onUse(img.url, img);
  toast('Image added — remember to save the record', 'success');
  _aiState.busy = false;
  closeAiImageModal();
}

/**
 * Adds a "Generate with AI" button next to an image field.
 *   attachAiImageGenerator('svc-img', { entity: 'SERVICE', context: function(){...} })
 * opts.onUse defaults to writing the URL into the input (same as a manual upload).
 */
function attachAiImageGenerator(inputId, opts) {
  var input = document.getElementById(inputId);
  if (!input) return;
  opts = opts || {};

  var btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'btn btn-outline btn-sm';
  btn.style.cssText = 'font-size:12px;white-space:nowrap;margin-left:6px;';
  btn.innerHTML = '✨ Generate with AI';
  btn.onclick = function() {
    openAiImageModal({
      entity: opts.entity,
      modes: opts.modes,
      context: opts.context,
      references: opts.references,
      currentValue: opts.currentValue || function() { return input.value; },
      confirmReplace: opts.confirmReplace,
      onUse: opts.onUse || function(url) {
        input.value = url;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      },
    });
  };

  // Sits AFTER the field's existing Upload button (the last small outline button in the
  // group), so the media row reads "… Upload | ✨ Generate with AI" in the admin's normal
  // button style — no separate page, no duplicate upload control.
  var groupBtns = input.parentNode.querySelectorAll('.btn-outline.btn-sm');
  var lastBtn = groupBtns.length ? groupBtns[groupBtns.length - 1] : null;
  if (lastBtn && lastBtn.parentNode) lastBtn.parentNode.insertBefore(btn, lastBtn.nextSibling);
  else input.parentNode.insertBefore(btn, input.nextSibling);
}

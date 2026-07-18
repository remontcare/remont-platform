/* Remont Admin — Shared Auth + API + Sidebar */
var API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';

function getToken() { return localStorage.getItem('remont_admin_token'); }
function getAdminUser() {
  try { return JSON.parse(localStorage.getItem('remont_admin_user') || '{}'); } catch(e) { return {}; }
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

function escape(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
  LOST:'red', ON_HOLD:'yellow',
};
function statusBadge(s) { return badge(s, STATUS_COLORS[s] || 'gray'); }

// ── SIDEBAR ──────────────────────────────────────────────────────

var SIDEBAR_NAV = [
  { section: '📊 DASHBOARD', items: [
    { key:'dashboard', label:'Dashboard', icon:'🏠', href:'/admin/dashboard.html' },
  ]},
  { section: '📦 ORDERS', items: [
    { key:'orders', label:'All Orders', icon:'📋', href:'/admin/orders.html' },
    { key:'orders-new', label:'New Orders', icon:'🔵', href:'/admin/orders.html?status=PENDING', badge:'new' },
    { key:'orders-active', label:'Active Orders', icon:'🟡', href:'/admin/orders.html?status=IN_PROGRESS', badge:'active' },
    { key:'orders-done', label:'Completed Orders', icon:'🟢', href:'/admin/orders.html?status=COMPLETED', badge:'completed' },
    { key:'orders-cancelled', label:'Cancelled Orders', icon:'🔴', href:'/admin/orders.html?status=CANCELLED', badge:'cancelled' },
    { key:'returns', label:'Returns & Refunds', icon:'↩️', href:'/admin/orders.html?status=REFUNDED' },
  ]},
  { section: '🛠 SERVICES', items: [
    { key:'services', label:'Service Management', icon:'🔧', href:'/admin/services.html' },
    { key:'service-pricing', label:'Service Pricing', icon:'💲', href:'/admin/service-pricing.html' },
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
    { key:'partner-id-cards', label:'Partner ID Cards', icon:'🪪', href:'/admin/partner-id-cards.html' },
  ]},
  { section: '🚚 SUPPLIERS', items: [
    { key:'suppliers', label:'Suppliers', icon:'🏭', href:'/admin/suppliers.html' },
    { key:'purchase-orders', label:'Purchase Orders', icon:'📄', href:'/admin/purchase-orders.html' },
  ]},
  { section: '👥 CUSTOMERS', items: [
    { key:'customers', label:'Customers', icon:'👥', href:'/admin/customers.html' },
    { key:'corporate', label:'Corporate Customers', icon:'🏢', href:'/admin/corporate.html' },
    { key:'membership', label:'Membership', icon:'💎', href:'/admin/membership.html' },
  ]},
  { section: '💰 FINANCE', items: [
    { key:'payments', label:'Payments', icon:'💳', href:'/admin/payments.html' },
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
    { key:'settings', label:'Website Settings', icon:'🌐', href:'/admin/settings.html' },
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

  var addBtn = input.nextElementSibling;
  var ref = addBtn ? addBtn.nextSibling : input.nextSibling;
  input.parentNode.insertBefore(fileInp, ref);
  input.parentNode.insertBefore(btn, fileInp.nextSibling);
}

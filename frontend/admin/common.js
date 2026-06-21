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

function escape(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function badge(text, color) {
  var colors = { green: '#22c55e', blue: '#3b82f6', yellow: '#f59e0b', red: '#ef4444', gray: '#6b7280', purple: '#8b5cf6', orange: '#f97316' };
  var bg = colors[color] || colors.gray;
  return '<span style="display:inline-block;padding:2px 9px;border-radius:20px;font-size:11px;font-weight:600;background:' + bg + '22;color:' + bg + ';white-space:nowrap">' + escape(String(text)) + '</span>';
}

var STATUS_COLORS = {
  PENDING: 'yellow', CONFIRMED: 'blue', VENDOR_ASSIGNED: 'blue', EN_ROUTE: 'purple',
  IN_PROGRESS: 'purple', COMPLETED: 'green', CANCELLED: 'red', REFUNDED: 'orange',
  ACTIVE: 'green', SUSPENDED: 'red', REJECTED: 'red', PENDING_VERIFICATION: 'yellow',
  PAID: 'green', UNPAID: 'yellow', FAILED: 'red', PENDING: 'yellow',
};
function statusBadge(s) { return badge(s, STATUS_COLORS[s] || 'gray'); }

var SIDEBAR_HTML = '<div class="sidebar">' +
  '<div class="sidebar-brand"><div class="logo">Remont <span>ADMIN</span></div><div class="tagline">Platform Management</div></div>' +
  '<div class="nav-group"><div class="nav-label">Overview</div>' +
    '<a class="nav-item" href="/admin/dashboard.html" data-page="dashboard"><span class="nav-icon">📊</span> Dashboard</a>' +
    '<a class="nav-item" href="/admin/staff.html" data-page="staff"><span class="nav-icon">👔</span> Staff</a>' +
  '</div>' +
  '<div class="nav-group"><div class="nav-label">People</div>' +
    '<a class="nav-item" href="/admin/users.html" data-page="users"><span class="nav-icon">👥</span> Customers</a>' +
    '<a class="nav-item" href="/admin/vendors.html" data-page="vendors"><span class="nav-icon">🏪</span> Service Men</a>' +
    '<a class="nav-item" href="/admin/membership.html" data-page="membership"><span class="nav-icon">💎</span> Membership</a>' +
    '<a class="nav-item" href="/admin/corporate.html" data-page="corporate"><span class="nav-icon">🏢</span> Corporate</a>' +
    '<a class="nav-item" href="/admin/newsletters.html" data-page="newsletters"><span class="nav-icon">✉️</span> Newsletters</a>' +
  '</div>' +
  '<div class="nav-group"><div class="nav-label">Commerce</div>' +
    '<a class="nav-item" href="/admin/orders.html" data-page="orders"><span class="nav-icon">📦</span> Customer Orders</a>' +
    '<a class="nav-item" href="/admin/invoices.html" data-page="invoices"><span class="nav-icon">🧾</span> Invoices</a>' +
    '<a class="nav-item" href="/admin/wallet.html" data-page="wallet"><span class="nav-icon">💰</span> Wallet</a>' +
    '<a class="nav-item" href="/admin/amc.html" data-page="amc"><span class="nav-icon">🔒</span> AMC Plans</a>' +
    '<a class="nav-item" href="/admin/coupons.html" data-page="coupons"><span class="nav-icon">🏷</span> Coupons</a>' +
    '<a class="nav-item" href="/admin/taxes.html" data-page="taxes"><span class="nav-icon">📊</span> Taxes</a>' +
  '</div>' +
  '<div class="nav-group"><div class="nav-label">CRM</div>' +
    '<a class="nav-item" href="/admin/leads.html" data-page="leads"><span class="nav-icon">📈</span> Leads</a>' +
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
  '<div class="nav-group"><div class="nav-label">Settings</div>' +
    '<a class="nav-item" href="/admin/settings.html" data-page="settings"><span class="nav-icon">⚙️</span> General Setting</a>' +
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

/* Remont Admin — shared auth + API helper */
var API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';

function getToken() { return localStorage.getItem('remont_admin_token'); }
function getAdminUser() {
  try { return JSON.parse(localStorage.getItem('remont_admin_user') || '{}'); }
  catch(e) { return {}; }
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
  var opts = {
    method: method.toUpperCase(),
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  return fetch(API_BASE + '/api/v1' + path, opts).then(function(r) {
    return r.json().then(function(d) {
      if (r.status === 401) { logout(); return; }
      if (!r.ok) throw new Error((d && d.message) ? d.message : ('HTTP ' + r.status));
      return d.data !== undefined ? d.data : d;
    });
  });
}

function toast(msg, type) {
  var t = document.createElement('div');
  t.className = 'toast';
  t.style.background = type === 'error' ? '#ef4444' : type === 'warning' ? '#f59e0b' : '#22c55e';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(function() { t.style.opacity='0'; t.style.transition='opacity .3s'; setTimeout(function(){t.remove();},300); }, 3000);
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', {day:'2-digit',month:'short',year:'numeric'});
}

function fmtCur(n) {
  if (n === null || n === undefined) return '—';
  return '₹' + Number(n).toLocaleString('en-IN');
}

function escape(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function highlightNav(page) {
  document.querySelectorAll('.nav-item').forEach(function(el) {
    el.classList.toggle('active', el.getAttribute('data-page') === page);
  });
}

var SIDEBAR_HTML = '<div class="sidebar">' +
  '<div class="sidebar-brand">' +
    '<div class="logo">Remont <span>ADMIN</span></div>' +
    '<div class="tagline">Platform Management</div>' +
  '</div>' +
  '<div class="nav-group">' +
    '<div class="nav-label">Overview</div>' +
    '<a class="nav-item" href="/admin/dashboard.html" data-page="dashboard"><span class="nav-icon">📊</span> Dashboard</a>' +
  '</div>' +
  '<div class="nav-group">' +
    '<div class="nav-label">People</div>' +
    '<a class="nav-item" href="/admin/users.html" data-page="users"><span class="nav-icon">👥</span> Users</a>' +
    '<a class="nav-item" href="/admin/vendors.html" data-page="vendors"><span class="nav-icon">🏪</span> Vendors</a>' +
  '</div>' +
  '<div class="nav-group">' +
    '<div class="nav-label">Commerce</div>' +
    '<a class="nav-item" href="/admin/orders.html" data-page="orders"><span class="nav-icon">📦</span> Orders</a>' +
    '<a class="nav-item" href="/admin/services.html" data-page="services"><span class="nav-icon">🔧</span> Services</a>' +
    '<a class="nav-item" href="/admin/products.html" data-page="products"><span class="nav-icon">🛍</span> Products</a>' +
  '</div>' +
  '<div class="nav-group">' +
    '<div class="nav-label">Config</div>' +
    '<a class="nav-item" href="/admin/cities.html" data-page="cities"><span class="nav-icon">🏙</span> Cities</a>' +
  '</div>' +
  '<div class="sidebar-footer">Remont India © 2024</div>' +
'</div>';

function renderSidebar(page) {
  var el = document.getElementById('sidebar-mount');
  if (el) { el.innerHTML = SIDEBAR_HTML; highlightNav(page); }
}

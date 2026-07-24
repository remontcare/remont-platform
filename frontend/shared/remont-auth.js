/* Remont — Shared Auth Client
 * One OTP-based login flow, one token/session model, used by every portal
 * (customer site, vendor.html, seller.html, admin, delivery, corporate, crm).
 * Replaces the old per-portal localStorage keys (remont_token, remont_admin_token,
 * pr_token, vendorAccessToken/vendorRefreshToken, sellerAccessToken).
 */
(function (global) {
  var API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';
  var KEY_ACCESS = 'remont_access_token';
  var KEY_REFRESH = 'remont_refresh_token';
  var KEY_USER = 'remont_user';

  var PORTAL_BY_ROLE = {
    CUSTOMER: '/',
    SERVICE_VENDOR: '/vendor.html',
    PRODUCT_VENDOR: '/seller.html',
    DELIVERY_PARTNER: '/delivery.html',
    CORPORATE_USER: '/corporate.html',
    CRM_AGENT: '/crm.html',
    ADMIN: '/admin/dashboard.html',
    SUPER_ADMIN: '/admin/dashboard.html',
  };

  function getToken() { return localStorage.getItem(KEY_ACCESS); }
  function getRefreshToken() { return localStorage.getItem(KEY_REFRESH); }
  function getUser() {
    try { return JSON.parse(localStorage.getItem(KEY_USER) || 'null'); } catch (e) { return null; }
  }
  function isLoggedIn() { return !!getToken(); }

  function storeSession(data) {
    if (data.accessToken) localStorage.setItem(KEY_ACCESS, data.accessToken);
    if (data.refreshToken) localStorage.setItem(KEY_REFRESH, data.refreshToken);
    if (data.user) localStorage.setItem(KEY_USER, JSON.stringify(data.user));
  }

  function clearSession() {
    localStorage.removeItem(KEY_ACCESS);
    localStorage.removeItem(KEY_REFRESH);
    localStorage.removeItem(KEY_USER);
  }

  function unwrap(res) {
    return res.json().then(function (d) {
      if (!res.ok) {
        var msg = (d && d.message) ? (Array.isArray(d.message) ? d.message.join(', ') : d.message) : ('HTTP ' + res.status);
        var err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      return d.data !== undefined ? d.data : d;
    });
  }

  function sendOtp(phone, role) {
    return fetch(API_BASE + '/api/v1/auth/send-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone, role: role || undefined, platform: 'WEB' }),
    }).then(unwrap);
  }

  function verifyOtp(phone, otp, extra) {
    var body = Object.assign({ phone: phone, otp: otp, platform: 'WEB' }, extra || {});
    return fetch(API_BASE + '/api/v1/auth/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(unwrap).then(function (data) {
      storeSession(data);
      return data;
    });
  }

  function refresh() {
    var rt = getRefreshToken();
    if (!rt) return Promise.reject(new Error('No refresh token'));
    return fetch(API_BASE + '/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    }).then(unwrap).then(function (data) {
      storeSession(data);
      return data;
    });
  }

  function logout() {
    var rt = getRefreshToken();
    clearSession();
    if (rt) {
      fetch(API_BASE + '/api/v1/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      }).catch(function () {});
    }
    window.location.replace('/');
  }

  function logoutAllDevices() {
    var token = getToken();
    var req = token
      ? fetch(API_BASE + '/api/v1/auth/logout-all', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
      }).catch(function () {})
      : Promise.resolve();
    return req.then(function () {
      clearSession();
      window.location.replace('/');
    });
  }

  // Attaches the bearer token; on a 401 refreshes once and retries, otherwise
  // clears the session. This is the refresh-retry loop the backend has always
  // supported (POST /auth/refresh) but no client previously called.
  function apiFetch(path, opts, _isRetry) {
    opts = opts || {};
    var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    var token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(API_BASE + '/api/v1' + path, Object.assign({}, opts, { headers: headers }))
      .then(function (res) {
        if (res.status === 401 && !_isRetry && getRefreshToken()) {
          return refresh().then(function () {
            return apiFetch(path, opts, true);
          }).catch(function () {
            clearSession();
            throw new Error('Session expired');
          });
        }
        return unwrap(res);
      });
  }

  function redirectToPortal(role) {
    window.location.href = PORTAL_BY_ROLE[role] || '/';
  }

  global.RemontAuth = {
    getToken: getToken,
    getRefreshToken: getRefreshToken,
    getUser: getUser,
    isLoggedIn: isLoggedIn,
    sendOtp: sendOtp,
    verifyOtp: verifyOtp,
    refresh: refresh,
    logout: logout,
    logoutAllDevices: logoutAllDevices,
    apiFetch: apiFetch,
    redirectToPortal: redirectToPortal,
    storeSession: storeSession,
    clearSession: clearSession,
    PORTAL_BY_ROLE: PORTAL_BY_ROLE,
  };
})(window);

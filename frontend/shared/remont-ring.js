/* Remont — Partner full-screen incoming-job ring (Task 7).
 * Loaded only by vendor.html. Purely a renderer: it never runs its own retry
 * timer or decides when to stop ringing on its own — the server (retry-sweep
 * .service.ts) decides the re-ring cadence and fires this via a fresh
 * WebSocket 'notification' event or FCM message each time (see
 * remont-notifications.js's dispatchIncoming()). This intentionally replaces
 * the old client-only, server-unenforced 30s countdown (ioTimer/openIncomingJob
 * in this same file's <script> block) for real dispatched jobs — that legacy
 * overlay is left untouched for the manual "Check for Job Requests"/demo flows.
 */
(function (global) {
  var overlay = null;
  var audioCtx = null;
  var ringIntervalId = null;
  var vibrateIntervalId = null;
  var current = null; // { id (notificationId), orderId, title, body }

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'remont-ring-overlay';
    overlay.style.cssText = 'display:none;position:fixed;inset:0;z-index:99999;background:linear-gradient(160deg,#1a1410,#2b1d10);color:#fff;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center;font-family:inherit';
    overlay.innerHTML =
      '<div style="font-size:52px;margin-bottom:6px;animation:remont-ring-pulse 1s infinite">🔔</div>' +
      '<div style="font-size:13px;letter-spacing:1px;opacity:.7;text-transform:uppercase;margin-bottom:14px">Incoming Job</div>' +
      '<div id="rr-title" style="font-size:22px;font-weight:700;margin-bottom:8px"></div>' +
      '<div id="rr-body" style="font-size:15px;opacity:.85;margin-bottom:36px;max-width:320px"></div>' +
      '<div style="display:flex;gap:14px;width:100%;max-width:320px">' +
        '<button id="rr-reject" style="flex:1;padding:16px;border:1.5px solid rgba(255,255,255,.3);background:none;color:#fff;border-radius:12px;font-size:15px;font-weight:600">✕ Reject</button>' +
        '<button id="rr-accept" style="flex:1;padding:16px;border:none;background:#5B8C5A;color:#fff;border-radius:12px;font-size:15px;font-weight:600">✓ Accept</button>' +
      '</div>' +
      '<button id="rr-details" style="margin-top:16px;background:none;border:none;color:rgba(255,255,255,.7);font-size:13px;text-decoration:underline">View Details</button>' +
      '<style>@keyframes remont-ring-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}</style>';
    document.body.appendChild(overlay);
    overlay.querySelector('#rr-accept').onclick = onAccept;
    overlay.querySelector('#rr-reject').onclick = onReject;
    overlay.querySelector('#rr-details').onclick = onDetails;
    return overlay;
  }

  // No ringtone.mp3 asset shipped with this repo — synthesized via Web Audio so the
  // ring works out of the box; swap for a branded audio file later if desired.
  function startRingtone() {
    stopRingtone();
    try {
      audioCtx = new (global.AudioContext || global.webkitAudioContext)();
      var ring = function () {
        if (!audioCtx) return;
        [880, 660].forEach(function (freq, i) {
          var osc = audioCtx.createOscillator();
          var gain = audioCtx.createGain();
          osc.frequency.value = freq;
          osc.type = 'sine';
          var start = audioCtx.currentTime + i * 0.28;
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.25);
          osc.connect(gain).connect(audioCtx.destination);
          osc.start(start);
          osc.stop(start + 0.3);
        });
      };
      ring();
      ringIntervalId = setInterval(ring, 1200);
    } catch (e) { /* Web Audio unavailable — vibration still runs */ }
  }

  function stopRingtone() {
    if (ringIntervalId) { clearInterval(ringIntervalId); ringIntervalId = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
  }

  function startVibration() {
    if (!navigator.vibrate) return;
    navigator.vibrate([400, 200, 400, 200]);
    vibrateIntervalId = setInterval(function () { navigator.vibrate([400, 200, 400, 200]); }, 1200);
  }

  function stopVibration() {
    if (vibrateIntervalId) { clearInterval(vibrateIntervalId); vibrateIntervalId = null; }
    if (navigator.vibrate) navigator.vibrate(0);
  }

  function show(payload) {
    var el = ensureOverlay();
    current = {
      id: payload.id, orderId: (payload.data && payload.data.orderId) || payload.orderId,
      title: payload.title || 'New Job Available', body: payload.body || '',
    };
    el.querySelector('#rr-title').textContent = current.title;
    el.querySelector('#rr-body').textContent = current.body;
    el.style.display = 'flex';
    startRingtone();
    startVibration();
    if (global.RemontNotifications && current.id) global.RemontNotifications.ack(current.id, 'DELIVERED');
  }

  function hide() {
    if (overlay) overlay.style.display = 'none';
    stopRingtone();
    stopVibration();
    current = null;
  }

  function onAccept() {
    if (!current || !current.orderId) { hide(); return; }
    var orderId = current.orderId, notifId = current.id;
    hide();
    global.RemontAuth.apiFetch('/vendors/service/me/jobs/' + orderId + '/accept', { method: 'POST' })
      .then(function (order) {
        if (notifId) global.RemontNotifications.ack(notifId, 'OPENED');
        if (typeof global.startJobFlow === 'function') global.startJobFlow(order, false);
        else if (typeof global.loadJobs === 'function') global.loadJobs();
      })
      .catch(function (e) { alert('Could not accept job: ' + (e && e.message ? e.message : 'it may have already been taken.')); });
  }

  function onReject() {
    if (!current || !current.orderId) { hide(); return; }
    var orderId = current.orderId, notifId = current.id;
    hide();
    global.RemontAuth.apiFetch('/vendors/service/me/jobs/' + orderId + '/reject', { method: 'POST' })
      .then(function () { if (notifId) global.RemontNotifications.ack(notifId, 'OPENED'); })
      .catch(function () {});
  }

  function onDetails() {
    if (current && current.orderId && typeof global.resumeJob === 'function') {
      hide();
      global.resumeJob(current.orderId);
    }
  }

  global.RemontRing = { show: show, hide: hide };
})(window);

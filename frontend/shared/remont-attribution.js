/* ══════════════════════════════════════════════════════════════════════
   REMONT ATTRIBUTION — where an enquiry came from (first-party, no cookies).

   On the first page a visitor opens in this browser tab, remember:
     - utm_source / utm_medium / utm_campaign from the link (if present);
     - otherwise the referring site (search engine -> "organic", social site
       -> "social", any other site -> "referral"); nothing for direct visits;
     - the landing page path (no query string, so no personal data).
   Kept in sessionStorage only (gone when the tab closes), never sent anywhere
   except together with the visitor's OWN enquiry, when they submit a form.
   No third-party script, no cookie, no fingerprinting, no personal data.

   Lead forms add RemontAttribution.fields() to POST /api/v1/crm/leads/capture.
   Keyword-level data is NOT available here (search engines don't pass it).
   ══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var KEY = 'remont_attribution_v1';
  var SEARCH = /(^|\.)(google|bing|yahoo|duckduckgo|yandex|baidu|ecosia)\./i;
  var SOCIAL = /(^|\.)(facebook|fb|instagram|linkedin|t|twitter|x|youtube|whatsapp|pinterest)\.(com|co|me)$/i;
  var SAFE = /[^A-Za-z0-9 ._\-\/+:]/g;

  function clean(v, max) {
    if (typeof v !== 'string') return undefined;
    var out = v.replace(SAFE, '').trim().slice(0, max);
    return out || undefined;
  }

  function read() {
    try { return JSON.parse(window.sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }

  function capture(loc, referrer) {
    var params;
    try { params = new URLSearchParams(loc.search || ''); } catch (e) { params = null; }
    var data = { landingPage: clean(loc.pathname || '/', 200) || '/' };
    var src = params && clean(params.get('utm_source'), 100);
    if (src) {
      data.utmSource = src;
      data.utmMedium = clean(params.get('utm_medium'), 100);
      data.utmCampaign = clean(params.get('utm_campaign'), 100);
      data.basis = 'utm';
    } else if (referrer) {
      var host = '';
      try { host = new URL(referrer).hostname.replace(/^www\./, ''); } catch (e) { host = ''; }
      if (host && host !== (loc.hostname || '').replace(/^www\./, '')) {
        data.utmSource = clean(host, 100);
        data.utmMedium = SEARCH.test(host) ? 'organic' : SOCIAL.test(host) ? 'social' : 'referral';
        data.basis = 'referrer';
      }
    }
    return data;
  }

  /** First touch of this tab wins; a later link WITH utm_* replaces a non-utm first touch. */
  function init(loc, referrer) {
    var current = read();
    var fresh = capture(loc, referrer);
    if (!current || (fresh.basis === 'utm' && current.basis !== 'utm')) {
      try { window.sessionStorage.setItem(KEY, JSON.stringify(fresh)); } catch (e) { /* storage off: no attribution */ }
      return fresh;
    }
    return current;
  }

  var state = init(window.location, document.referrer);

  window.RemontAttribution = {
    /** Fields for the lead-capture body; empty object when nothing is known. */
    fields: function () {
      var s = read() || state || {};
      var out = {};
      ['utmSource', 'utmMedium', 'utmCampaign', 'landingPage'].forEach(function (k) { if (s[k]) out[k] = s[k]; });
      return out;
    },
    _capture: capture,
    _init: init,
  };
})();

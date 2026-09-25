/**
 * Public policy page renderer (Legal & Policies CMS).
 *
 * Each policy route (/privacy, /terms, /partner-policy, … and /policy/<slug>)
 * is a static HTML page with a real <head> (title, description, canonical,
 * Open Graph) so it works without JavaScript and without the API. This script
 * replaces the body with the admin-PUBLISHED version from
 * GET /api/v1/legal/policies/<key> when one exists:
 *
 *   <body data-policy="privacy" data-fallback="static">
 *
 * data-fallback="static" → keep the page's built-in text if nothing is
 * published (legacy /privacy, /terms, /refund-policy); otherwise a short
 * "not yet published" notice is shown. Section HTML is sanitised server-side
 * (allow-list) before it is ever sent; titles are set as text, never HTML.
 */
(function () {
  var API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';
  var body = document.body;
  var key = body.getAttribute('data-policy');
  if (!key) {
    var m = location.pathname.match(/^\/policy\/([a-z0-9-]+)\/?$/);
    key = m ? m[1] : new URLSearchParams(location.search).get('slug');
  }
  var keepStatic = body.getAttribute('data-fallback') === 'static';

  var css = document.createElement('style');
  css.textContent =
    '.legal-toc{background:var(--cream,#F5F0E8);border:1px solid var(--mist,#E8E3DA);border-radius:12px;padding:14px 18px;margin:0 0 26px;font-size:14px}' +
    '.legal-toc strong{display:block;margin-bottom:6px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:var(--txt-muted,#6E6860)}' +
    '.legal-toc ol{padding-left:20px;margin:0;columns:2;column-gap:28px}.legal-toc li{margin-bottom:4px;break-inside:avoid}' +
    '.legal-body section{scroll-margin-top:16px}.legal-body h3{font-size:16px;margin:16px 0 6px}.legal-body h4{font-size:14.5px;margin:12px 0 4px}' +
    '.legal-body ol{padding-left:20px;margin-bottom:10px}.legal-body table{border-collapse:collapse;width:100%;margin:10px 0;font-size:14px}' +
    '.legal-body th,.legal-body td{border:1px solid var(--mist,#E8E3DA);padding:6px 10px;text-align:left}.legal-body blockquote{border-left:3px solid var(--amber,#E8A650);padding-left:12px;color:var(--graphite,#2D2D2D)}' +
    '.legal-body a{word-break:break-word}' +
    '@media (max-width:640px){.legal-toc ol{columns:1}}';
  document.head.appendChild(css);

  function setMeta(selector, attr, value) {
    if (!value) return;
    var el = document.head.querySelector(selector);
    if (!el) {
      el = document.createElement(selector.indexOf('link') === 0 ? 'link' : 'meta');
      var m = selector.match(/\[(name|property|rel)="([^"]+)"\]/);
      if (m) el.setAttribute(m[1], m[2]);
      document.head.appendChild(el);
    }
    el.setAttribute(attr, value);
  }

  function notPublished() {
    if (keepStatic) return;
    var wrap = document.querySelector('.legal-body .wrap');
    if (wrap) wrap.innerHTML = '<p>This policy is being prepared and has not been published yet. For questions, please visit our <a href="/contact">Contact</a> page.</p>';
    var upd = document.querySelector('.legal-hero .updated');
    if (upd) upd.textContent = 'Not yet published';
    setMeta('meta[name="robots"]', 'content', 'noindex, follow');
  }

  if (!key) { notPublished(); return; }

  fetch(API_BASE + '/api/v1/legal/policies/' + encodeURIComponent(key), { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (res) {
      var d = res && (res.data !== undefined ? res.data : res);
      if (!d || !d.sections) { notPublished(); return; }

      var h1 = document.querySelector('.legal-hero h1');
      if (h1) h1.textContent = d.title;
      var upd = document.querySelector('.legal-hero .updated');
      if (upd) {
        var parts = ['Version ' + d.version];
        if (d.lastUpdatedLabel) parts.push('Last updated: ' + d.lastUpdatedLabel);
        if (d.effectiveDate) {
          var eff = new Date(d.effectiveDate);
          if (!isNaN(eff)) parts.push('Effective: ' + eff.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }));
        }
        upd.textContent = parts.join(' · ');
      }
      var crumb = document.querySelector('nav.crumbs .wrap');
      if (crumb) { crumb.innerHTML = '<a href="/">Home</a> / '; crumb.appendChild(document.createTextNode(d.title)); }

      var wrap = document.querySelector('.legal-body .wrap');
      if (wrap) {
        wrap.innerHTML = '';
        if (d.sections.length > 3) {
          var toc = document.createElement('nav');
          toc.className = 'legal-toc';
          toc.setAttribute('aria-label', 'Contents');
          toc.innerHTML = '<strong>Contents</strong><ol></ol>';
          d.sections.forEach(function (s) {
            var li = document.createElement('li'); var a = document.createElement('a');
            a.href = '#' + s.id; a.textContent = s.title; li.appendChild(a); toc.querySelector('ol').appendChild(li);
          });
          wrap.appendChild(toc);
        }
        d.sections.forEach(function (s, i) {
          var sec = document.createElement('section'); sec.id = s.id;
          var h2 = document.createElement('h2'); h2.textContent = (i + 1) + '. ' + s.title;
          var div = document.createElement('div'); div.innerHTML = s.html; // server-sanitised
          sec.appendChild(h2); sec.appendChild(div); wrap.appendChild(sec);
        });
        if (location.hash) { var t = document.getElementById(location.hash.slice(1)); if (t) t.scrollIntoView(); }
      }

      if (d.seoTitle) document.title = d.seoTitle;
      setMeta('meta[name="description"]', 'content', d.seoDescription);
      setMeta('meta[property="og:title"]', 'content', d.seoTitle);
      setMeta('meta[property="og:description"]', 'content', d.seoDescription);
      setMeta('meta[property="og:url"]', 'content', d.canonical);
      setMeta('link[rel="canonical"]', 'href', d.canonical);
      setMeta('meta[name="robots"]', 'content', 'index, follow');
    })
    .catch(function () { notPublished(); });
})();

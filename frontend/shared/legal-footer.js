/**
 * Footer policy links (Legal & Policies CMS).
 *
 * Any element with [data-legal-footer] keeps its static links (so the footer
 * works without JS/API) and gains a link for every PUBLISHED main policy the
 * admin marked "show in footer" that isn't already linked. Unpublished
 * policies never appear.
 */
(function () {
  var containers = document.querySelectorAll('[data-legal-footer]');
  if (!containers.length) return;
  var API_BASE = window.location.hostname === 'localhost' ? 'http://localhost:3001' : '';
  fetch(API_BASE + '/api/v1/legal/policies', { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (res) {
      var list = res && (res.data !== undefined ? res.data : res);
      if (!Array.isArray(list)) return;
      containers.forEach(function (c) {
        var have = {};
        c.querySelectorAll('a[href]').forEach(function (a) { have[a.getAttribute('href').replace(/\/$/, '')] = true; });
        list.forEach(function (p) {
          if (!p.showInFooter || !/^\/[a-z0-9\/-]+$/.test(p.publicPath) || have[p.publicPath]) return;
          var a = document.createElement('a');
          a.href = p.publicPath;
          a.textContent = p.title;
          c.appendChild(document.createTextNode(c.getAttribute('data-legal-footer') === 'dot' ? ' · ' : ' '));
          c.appendChild(a);
          have[p.publicPath] = true;
        });
      });
    })
    .catch(function () { /* keep static links */ });
})();

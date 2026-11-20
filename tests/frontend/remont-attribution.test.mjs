// node --test tests/frontend   (no dependencies; runs the real browser script in a VM)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../../frontend/shared/remont-attribution.js', import.meta.url), 'utf8');

function page(url, referrer = '', storage = new Map()) {
  const u = new URL(url);
  const window = {
    location: { pathname: u.pathname, search: u.search, hostname: u.hostname },
    sessionStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
  };
  vm.runInNewContext(SRC, { window, document: { referrer }, URL, URLSearchParams });
  const R = window.RemontAttribution;          // plain copies: objects from the VM have another prototype
  return { A: { fields: () => JSON.parse(JSON.stringify(R.fields())) }, storage };
}

test('utm link: source, medium, campaign and landing path (no query string)', () => {
  const { A } = page('https://remontindia.com/cities/bhopal?utm_source=facebook&utm_medium=paid_social&utm_campaign=Diwali%20Interiors&phone=987');
  assert.deepEqual(A.fields(), { utmSource: 'facebook', utmMedium: 'paid_social', utmCampaign: 'Diwali Interiors', landingPage: '/cities/bhopal' });
});

test('search engine / social / other referrers, direct visit has no source', () => {
  assert.deepEqual(page('https://remontindia.com/services/plumbing', 'https://www.google.co.in/').A.fields(),
    { utmSource: 'google.co.in', utmMedium: 'organic', landingPage: '/services/plumbing' });
  assert.equal(page('https://remontindia.com/', 'https://l.facebook.com/l.php?u=x').A.fields().utmMedium, 'social');
  assert.equal(page('https://remontindia.com/', 'https://blog.example.org/post').A.fields().utmMedium, 'referral');
  assert.deepEqual(page('https://remontindia.com/about', '').A.fields(), { landingPage: '/about' });
  assert.deepEqual(page('https://remontindia.com/about', 'https://remontindia.com/').A.fields(), { landingPage: '/about' });
});

test('first touch of the tab is kept; a later utm link replaces a non-utm first touch', () => {
  const storage = new Map();
  page('https://remontindia.com/cities/indore', 'https://www.bing.com/', storage);
  let A = page('https://remontindia.com/contact', '', storage).A;                     // internal navigation
  assert.equal(A.fields().landingPage, '/cities/indore');
  A = page('https://remontindia.com/interior?utm_source=newsletter&utm_medium=email', '', storage).A;
  assert.deepEqual(A.fields(), { utmSource: 'newsletter', utmMedium: 'email', landingPage: '/interior' });
  A = page('https://remontindia.com/?utm_source=other', '', storage).A;                // utm never overwrites utm
  assert.equal(A.fields().utmSource, 'newsletter');
});

test('unsafe characters are stripped and values are capped', () => {
  const { A } = page('https://remontindia.com/?utm_source=%3Cscript%3Ealert(1)%3C/script%3E&utm_campaign=' + 'x'.repeat(300));
  assert.equal(A.fields().utmSource, 'scriptalert1/script');
  assert.equal(A.fields().utmCampaign.length, 100);
});

test('blocked storage never breaks the page', () => {
  const window = { location: { pathname: '/', search: '?utm_source=x', hostname: 'remontindia.com' },
    sessionStorage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } };
  vm.runInNewContext(SRC, { window, document: { referrer: '' }, URL, URLSearchParams });
  assert.equal(window.RemontAttribution.fields().utmSource, 'x');
});

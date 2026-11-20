/* Service size/option variants — display-only grouping, shared by the desktop catalog
 * (index.html svcCardsHtml) and the mobile catalog (shared/m-catalog.js).
 *
 * The catalog stores each size as its own service row, e.g.
 *   "General Pest Control (1BHK)" ₹799, "(2BHK)" ₹999, "(3BHK)" ₹1,299 …
 * Customers should see ONE card "General Pest Control" from the lowest price, with size
 * chips that switch the price. Nothing about the rows changes: every chip is still the
 * real service (its own id/price), so cart, booking, checkout and orders are untouched.
 *
 * Also: unit qualifiers such as "(Per Sqft)" are taken out of the name and shown as the
 * unit instead ("₹9 per sqft"), since the name is not the place for the unit.
 */
(function () {
  // A trailing "(Per …)" / " - Per …" is a unit, not part of the name.
  var UNIT_PAREN = /\s*\(\s*(per\s+[^)]+?)\s*\)\s*$/i;
  var UNIT_DASH = /\s+[-–—]\s+(per\s+.+?)\s*$/i;
  var PAREN = /^(.*\S)\s*\(\s*([^()]+?)\s*\)\s*$/;
  var DASH = /^(.*\S)\s+[-–—]\s+([^()]+?)\s*$/;
  // Labels that are clearly a size, so even a lone service shows it as a chip, not in the name.
  var SIZE = /(\d+(?:\.\d+)?)\s*(?:bhk|rk|ton|tr\b|inch|in\b|"|ltr|litre|liter|l\b|kg|cameras?|fans?|seater|door)|\b(?:pack of|up to|above|below)\b|\d[\d,]*\s*[-–]\s*\d[\d,]*\s*sq|studio|villa|bungalow/i;
  var SIZE_NUM = /(\d+(?:\.\d+)?)\s*(?:bhk|rk|ton|tr\b|inch|in\b|"|ltr|litre|liter|l\b|kg|cameras?|fans?|seater|door)/i;

  function norm(s) { return String(s || '').toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim(); }

  // "Termite Treatment – Post-Construction (Per Sqft)"
  //   → { base: "Termite Treatment", label: "Post-Construction", unit: "per sqft" }
  function parse(name) {
    var n = String(name || '').trim();
    var unit = null, m;
    if ((m = n.match(UNIT_PAREN)) || (m = n.match(UNIT_DASH))) {
      unit = m[1].replace(/\s+/g, ' ').toLowerCase();
      n = n.slice(0, m.index).trim();
    }
    var base = n, label = null;
    if ((m = n.match(PAREN)) || (m = n.match(DASH))) {
      if (m[1].replace(/[^A-Za-z0-9]/g, '').length >= 3) { base = m[1].replace(/\s+[-–—]$/, '').trim(); label = m[2].trim(); }
    }
    return { name: n, base: base, label: label, unit: unit };
  }

  // Name without a "(Per …)" unit — for products and anywhere a single name is shown.
  function cleanName(name) { return parse(name).name; }

  function sizeOf(label) { var m = String(label || '').match(SIZE_NUM); return m ? parseFloat(m[1]) : null; }

  /* group(list, getName, getPrice) → render items, list order kept (a group sits where its
   * first member was):
   *   { kind: 'one',   item, name, unit }                 a plain service
   *   { kind: 'group', key, name, variants: [{ item, label, unit }], sel }   one card + chips
   * `unit` is the unit taken out of the name (or null → use the service's own unit). */
  function group(list, getName, getPrice) {
    var rows = (list || []).map(function (item) { var p = parse(getName(item)); p.item = item; p.price = Number(getPrice(item)) || 0; return p; });
    var byBase = {};
    rows.forEach(function (r) { if (r.label) { var k = norm(r.base); (byBase[k] = byBase[k] || []).push(r); } });
    var out = [], done = {};
    rows.forEach(function (r) {
      var k = r.label ? norm(r.base) : null;
      var members = k ? byBase[k] : null;
      var asGroup = members && (members.length > 1 || SIZE.test(r.label));
      if (!asGroup) { out.push({ kind: 'one', item: r.item, name: r.name, unit: r.unit }); return; }
      if (done[k]) return;
      done[k] = 1;
      var vs = members.slice();
      var allSized = vs.every(function (v) { return sizeOf(v.label) != null; });
      vs.sort(function (a, b) {
        if (allSized && sizeOf(a.label) !== sizeOf(b.label)) return sizeOf(a.label) - sizeOf(b.label);
        return a.price - b.price;
      });
      // Opens on the lowest price ("from ₹799").
      var sel = 0;
      vs.forEach(function (v, i) { if (v.price > 0 && (vs[sel].price <= 0 || v.price < vs[sel].price)) sel = i; });
      out.push({ kind: 'group', key: k, name: r.base, sel: sel,
        variants: vs.map(function (v) { return { item: v.item, label: v.label, unit: v.unit, price: v.price }; }) });
    });
    return out;
  }

  // Every variant group a service belongs to, among `list` (for a detail view's size chips).
  function siblings(list, item, getName, getPrice) {
    var gs = group(list, getName, getPrice);
    for (var i = 0; i < gs.length; i++) {
      if (gs[i].kind !== 'group') continue;
      for (var j = 0; j < gs[i].variants.length; j++) if (gs[i].variants[j].item === item) return { group: gs[i], index: j };
    }
    return null;
  }

  /* ───────────────── Products: Amazon/Flipkart-style variant families ─────────────────
   * Products that are the same item in another size and/or colour are separate product
   * rows (own id, slug, price, stock). A family is ≥2 rows with the same brand, category
   * and name once size/colour words are taken out, e.g.
   *   "Asian Paints Apcolite Enamel Gloss White 4L" / "… Gloss Black 1L"
   *     → family "Asian Paints Apcolite Enamel Gloss", Size 1L/4L, Colour Black/White.
   * A product's specifications "Colour"/"Color"/"Shade" and "Size"/"Capacity"/"Pack" win
   * over what the name says. Listing shows one card per family; the product page shows
   * Size/Colour selectors that open the chosen row. Nothing is merged in the data. */
  var COLOURS = ['off white', 'rose gold', 'matte black', 'matt black', 'sky blue', 'navy blue', 'dark grey', 'light grey',
    'white', 'black', 'grey', 'gray', 'silver', 'golden', 'gold', 'brown', 'red', 'maroon', 'pink', 'orange', 'yellow',
    'green', 'olive', 'blue', 'navy', 'teal', 'purple', 'violet', 'beige', 'cream', 'ivory', 'chrome', 'brass', 'copper',
    'bronze', 'walnut', 'teak', 'oak', 'wenge', 'transparent'];
  var COLOUR_RE = new RegExp('\\b(' + COLOURS.map(function (c) { return c.replace(/ /g, '\\s+'); }).join('|') + ')\\b', 'ig');
  var PSIZE_RE = /\b(?:\d+\s)?\d+\/\d+\s?(?:inch|in|")|\b\d+(?:\.\d+)?\s?(?:x|×)\s?\d+(?:\.\d+)?(?:\s?(?:x|×)\s?\d+(?:\.\d+)?)?\s?(?:mm|cm|ft|feet|in|inch)?\b|\b\d+(?:\.\d+)?\s?(?:sq\.?\s?mm|ltr|litre|liter|ml|kg|gm|g|l|ton|tr|mm|cm|mtr|m|ft|inch|in|watt|w|amp|a|ah|v|seater|door|pcs|pc)\b(?:\s?coil)?|\bpack\s+of\s+\d+\b|\b\d+\s?(?:pc|pcs|piece|pieces)\b|\bpair\b/ig;
  var SPEC_COLOUR = /^(colou?r|shade|finish colou?r)$/i;
  var SPEC_SIZE = /^(size|capacity|pack(\s*size)?|tonnage|volume|weight|length|dimensions?|variant)$/i;

  function titleCase(s) { return String(s).toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }); }
  function specOf(specs, re) {
    if (!specs || typeof specs !== 'object') return null;
    for (var k in specs) if (re.test(k) && specs[k] != null && String(specs[k]).trim()) return String(specs[k]).trim();
    return null;
  }

  // → { base, size, colour } for one product (size/colour null when it has none)
  function productTraits(p) {
    var name = cleanName(p.name || '');
    var colours = [], sizes = [];
    var base = name.replace(COLOUR_RE, function (m) { colours.push(titleCase(m.replace(/\s+/g, ' '))); return ' '; });
    base = base.replace(PSIZE_RE, function (m) { sizes.push(m.replace(/\s+/g, ' ').trim()); return ' '; });
    base = base.replace(/\(\s*[,·|/-]*\s*\)/g, ' ').replace(/\s*[,·|/]\s*(?=\))/g, '').replace(/\(\s+/g, '(')
      .replace(/\s+[-–—|,]\s*$/g, '').replace(/\s{2,}/g, ' ').trim();
    var specs = p.specifications || p.specs;
    var sColour = specOf(specs, SPEC_COLOUR), sSize = specOf(specs, SPEC_SIZE);
    return {
      base: base || name,
      colour: sColour || (colours.length ? colours.join(' / ') : null),
      size: sSize || (sizes.length ? sizes.join(' · ') : null),
    };
  }

  /* productFamilies(list, opts) → list order kept (a family sits where its first member was):
   *   { kind: 'one', item }
   *   { kind: 'family', key, name, items: [...], rep, sizes: [...], colours: [...], minPrice }
   * opts: { brand(p), category(p), price(p), inStock(p) } — accessors, since the pages keep
   * products in slightly different shapes. */
  function productFamilies(list, opts) {
    opts = opts || {};
    var brandOf = opts.brand || function (p) { return p.brand; };
    var catOf = opts.category || function (p) { return p.category && (p.category.key || p.category.id) || p.categoryId; };
    var priceOf = opts.price || function (p) { return Number(p.price) || 0; };
    var stockOf = opts.inStock || function (p) { return p.stock == null || Number(p.stock) > 0; };
    var rows = (list || []).map(function (p) { var t = productTraits(p); t.item = p;
      t.key = norm(brandOf(p)) + '|' + norm(catOf(p)) + '|' + norm(t.base); return t; });
    var byKey = {};
    rows.forEach(function (r) { if (r.size || r.colour) (byKey[r.key] = byKey[r.key] || []).push(r); });
    // A real family: 2+ rows, and no two rows with the same size+colour (else they differ
    // in something else, and merging them would hide a product).
    Object.keys(byKey).forEach(function (k) {
      var seen = {}, ok = byKey[k].length > 1;
      byKey[k].forEach(function (r) { var c = norm(r.size) + '#' + norm(r.colour); if (seen[c]) ok = false; seen[c] = 1; });
      if (!ok) delete byKey[k];
    });
    var out = [], done = {};
    rows.forEach(function (r) {
      var fam = byKey[r.key];
      if (!fam) { out.push({ kind: 'one', item: r.item }); return; }
      if (done[r.key]) return;
      done[r.key] = 1;
      var items = fam.map(function (x) { return x.item; });
      var inStock = fam.filter(function (x) { return stockOf(x.item); });
      var pool = inStock.length ? inStock : fam;
      var rep = pool.slice().sort(function (a, b) { return priceOf(a.item) - priceOf(b.item); })[0];
      var uniq = function (arr) { var s = {}; return arr.filter(function (v) { if (!v || s[norm(v)]) return false; s[norm(v)] = 1; return true; }); };
      out.push({ kind: 'family', key: r.key, name: r.base, items: items, rep: rep.item,
        minPrice: priceOf(rep.item),
        sizes: uniq(fam.map(function (x) { return x.size; })), colours: uniq(fam.map(function (x) { return x.colour; })) });
    });
    return out;
  }

  // The family `p` belongs to within `list`, with each member's size/colour — for the product page.
  function productFamilyOf(p, list, opts) {
    var fams = productFamilies(list, opts);
    for (var i = 0; i < fams.length; i++) {
      var f = fams[i];
      if (f.kind !== 'family') continue;
      for (var j = 0; j < f.items.length; j++) {
        if (f.items[j].id === p.id) {
          f.members = f.items.map(function (x) { var t = productTraits(x); return { item: x, size: t.size, colour: t.colour }; });
          return f;
        }
      }
    }
    return null;
  }

  // "3 sizes · 2 colours"
  function familySummary(f) {
    var parts = [];
    if (f.sizes.length > 1) parts.push(f.sizes.length + ' sizes');
    if (f.colours.length > 1) parts.push(f.colours.length + ' colours');
    if (!parts.length) parts.push(f.items.length + ' options');
    return parts.join(' · ');
  }

  window.RemontVariants = { parse: parse, cleanName: cleanName, group: group, siblings: siblings,
    productTraits: productTraits, productFamilies: productFamilies, productFamilyOf: productFamilyOf, familySummary: familySummary };
})();

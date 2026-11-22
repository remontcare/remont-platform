/* Catalog variants: shows the rows of one admin-defined variant group (Admin → Variants) as a
 * single listing with option chips (Size 1BHK/2BHK…, Colour, Capacity…). Every option is still
 * its own service/product row with its own id and price, so cart, checkout and orders use the
 * selected row exactly as before. Rows with no active group render exactly as they always did.
 * Shared by the homepage (desktop cards + mobile catalog), the shop and the product page.
 */
(function () {
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  function optionsOf(row) {
    var o = row && row.variantOptions;
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  }
  function groupOf(row) {
    var g = row && row.variantGroup;
    return g && g.isActive !== false && row.variantGroupId && Array.isArray(g.optionNames) && g.optionNames.length ? g : null;
  }
  function same(a, b) { return String(a == null ? '' : a).trim().toLowerCase() === String(b == null ? '' : b).trim().toLowerCase(); }

  // Members of each listing seen by group() on this page, so a detail view of one option can
  // still find its siblings' photos (listingImage).
  var membersByGroup = {};
  function ownImages(r) {
    var out = [];
    if (!r) return out;
    [r.imageUrl, r.img].concat(Array.isArray(r.images) ? r.images : []).forEach(function (u) {
      if (typeof u === 'string' && u.trim() && out.indexOf(u) === -1) out.push(u);
    });
    return out;
  }
  function isIcon(u) { return /^data:image\/svg|\.svg(\?|$)/i.test(String(u || '')); }
  /* The picture for one option of a listing — never blank while ANY option has one: the listing's
   * common image (Admin → Variants), else this option's own photo, else a sibling option's photo
   * (2 BHK with no photo shows the 1 BHK one), else an icon. Real photos win over drawn icons.
   * '' when nothing at all has an image. Works for any row (no listing → its own image). */
  function listingImage(row, members) {
    var common = commonContent(row);
    if (common && common.images.length) return common.images[0];
    var g = groupOf(row);
    var siblings = (members || (g && membersByGroup[row.variantGroupId]) || []).filter(function (m) { return m !== row; });
    var pools = [ownImages(row)].concat(siblings.map(ownImages));
    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < pools.length; i++) {
        for (var j = 0; j < pools[i].length; j++) if (pass === 1 || !isIcon(pools[i][j])) return pools[i][j];
      }
    }
    return '';
  }

  /* rows → entries, list order kept (a group sits where its first member was):
   *   { kind: 'one', item }
   *   { kind: 'group', key, group, members: [row…], sel }   only for 2+ members of an active group
   * opts.price(row) → number (lowest positive price is selected first),
   * opts.available(row) → bool (unavailable members are kept but not preferred). */
  function group(rows, opts) {
    opts = opts || {};
    var priceOf = opts.price || function (r) { return Number(r.price != null ? r.price : r.basePrice) || 0; };
    var avail = opts.available || function () { return true; };
    var byGroup = {};
    (rows || []).forEach(function (r) {
      var g = groupOf(r);
      if (g && optionsOf(r)) (byGroup[r.variantGroupId] = byGroup[r.variantGroupId] || []).push(r);
    });
    var out = [], done = {};
    (rows || []).forEach(function (r) {
      var members = byGroup[r.variantGroupId];
      if (!groupOf(r) || !members || members.length < 2) { out.push({ kind: 'one', item: r }); return; }
      if (done[r.variantGroupId]) return;
      done[r.variantGroupId] = 1;
      var list = members.slice().sort(function (a, b) {
        return (Number(a.variantSortOrder) || 0) - (Number(b.variantSortOrder) || 0) || priceOf(a) - priceOf(b);
      });
      membersByGroup[r.variantGroupId] = list;
      var sel = -1;
      list.forEach(function (m, i) {
        var p = priceOf(m);
        if (p <= 0 || !avail(m)) return;
        if (sel < 0 || p < priceOf(list[sel])) sel = i;
      });
      out.push({ kind: 'group', key: r.variantGroupId, group: groupOf(r), members: list, sel: sel < 0 ? 0 : sel, price: priceOf });
    });
    return out;
  }

  // The distinct values of each option, in member order.
  function values(entry, name) {
    var seen = {}, out = [];
    entry.members.forEach(function (m) {
      var v = optionsOf(m)[name];
      if (v == null || seen[String(v).toLowerCase()]) return;
      seen[String(v).toLowerCase()] = 1;
      out.push(String(v));
    });
    return out;
  }

  /* The member to show when `name` is set to `value` from the member at index `from`: the one
   * keeping every other current option if it exists, else the closest match. -1 if none. */
  function pick(entry, from, name, value) {
    var cur = optionsOf(entry.members[from]) || {};
    var names = entry.group.optionNames;
    var best = -1, bestScore = -1;
    entry.members.forEach(function (m, i) {
      var o = optionsOf(m);
      if (!same(o[name], value)) return;
      var score = names.filter(function (n) { return n !== name && same(o[n], cur[n]); }).length;
      if (score > bestScore) { best = i; bestScore = score; }
    });
    return best;
  }
  // Whether value exists together with every other currently selected option (exact combination).
  function exact(entry, from, name, value) {
    var cur = optionsOf(entry.members[from]) || {};
    return entry.members.some(function (m) {
      var o = optionsOf(m);
      return entry.group.optionNames.every(function (n) { return n === name ? same(o[n], value) : same(o[n], cur[n]); });
    });
  }

  function label(optionNames, options) {
    if (!options) return '';
    var names = optionNames && optionNames.length ? optionNames : Object.keys(options);
    return names.filter(function (n) { return options[n] != null && String(options[n]).trim(); })
      .map(function (n) { return n + ': ' + options[n]; }).join(' · ');
  }
  function memberLabel(entry, i) { return label(entry.group.optionNames, optionsOf(entry.members[i])); }

  /* Option chips for the member at index `sel`. Each chip carries data-variant-key, data-variant-opt
   * and data-variant-val; the page handles the click and calls pick(). A value that only exists in a
   * different combination is still offered (choosing it switches the other option) but marked. */
  function chipsHtml(entry, sel, cls) {
    cls = cls || 'rv';
    var cur = optionsOf(entry.members[sel]) || {};
    return entry.group.optionNames.map(function (name) {
      var vals = values(entry, name);
      if (vals.length < 2 && entry.group.optionNames.length > 1) {
        return '<div class="' + cls + '-row"><span class="' + cls + '-lbl">' + esc(name) + ':</span> <b>' + esc(vals[0] || '') + '</b></div>';
      }
      return '<div class="' + cls + '-row" role="radiogroup" aria-label="' + esc(name) + '"><span class="' + cls + '-lbl">' + esc(name) + '</span>' +
        '<span class="' + cls + '-chips">' + vals.map(function (v) {
          var on = same(cur[name], v);
          var ok = on || exact(entry, sel, name, v);
          return '<button type="button" role="radio" aria-checked="' + on + '" class="' + cls + '-chip' + (on ? ' on' : '') + (ok ? '' : ' alt') + '"' +
            ' data-variant-key="' + esc(entry.key) + '" data-variant-opt="' + esc(name) + '" data-variant-val="' + esc(v) + '"' +
            (ok ? '' : ' title="Available with a different ' + esc(entry.group.optionNames.filter(function (n) { return n !== name; }).join(' / ')) + '"') +
            '>' + esc(v) + '</button>';
        }).join('') + '</span></div>';
    }).join('');
  }

  // "From ₹799" applies when the members' prices differ.
  function hasPriceRange(entry) {
    var ps = entry.members.map(entry.price).filter(function (p) { return p > 0; });
    return ps.length > 1 && Math.min.apply(null, ps) !== Math.max.apply(null, ps);
  }

  // The variant line under a cart/checkout item name — hidden when the name already says it.
  function cartVariantLine(item) {
    var v = item && item.variant ? String(item.variant) : '';
    if (!v) return '';
    var name = String(item.name || '').toLowerCase();
    var vals = v.split(' · ').map(function (p) { return p.split(': ').slice(1).join(': ').trim().toLowerCase(); }).filter(Boolean);
    if (vals.length && vals.every(function (x) { return name.indexOf(x) !== -1; })) return '';
    return v;
  }

  // "3 size · 2 colour options" — counts only options that actually vary.
  function summary(entry) {
    var parts = entry.group.optionNames.map(function (n) {
      var c = values(entry, n).length;
      return c > 1 ? c + ' ' + n.toLowerCase() : null;
    }).filter(Boolean);
    return (parts.length ? parts.join(' · ') : entry.members.length) + ' options';
  }

  /* Product grids (shop + homepage All Products): one card per listing. A group's card is its
   * cheapest available member, marked with .vg = { name, summary, range }; it links to that
   * member's product page, where the Size/Colour selectors are. Singles are returned as-is. */
  function productListings(items, opts) {
    return group(items, opts).map(function (e) {
      if (e.kind === 'one') return e.item;
      var rep = e.members[e.sel];
      var pic = listingImage(rep, e.members);
      return Object.assign({}, rep, pic && ownImages(rep)[0] !== pic ? { img: pic } : {},
        { vg: { name: e.group.name, summary: summary(e), range: hasPriceRange(e) } });
    });
  }

  /* The listing's ONE common description and gallery (up to 5 images), set in Admin → Variants.
   * Null when the row has no active listing; empty parts mean "use the row's own". */
  function commonContent(row) {
    var g = groupOf(row);
    if (!g) return null;
    var images = Array.isArray(g.images) ? g.images.filter(Boolean).slice(0, 5) : [];
    var description = g.description && String(g.description).trim() ? String(g.description).trim() : '';
    return (images.length || description) ? { images: images, description: description } : null;
  }

  // An order line as recorded at order time: snapshot name (+ chosen options); older lines → live name.
  function orderLine(line, liveName) {
    var o = line && line.variantOptions;
    var variant = Array.isArray(o) ? o.filter(function (x) { return x && x.value; }).map(function (x) { return x.name + ': ' + x.value; }).join(' · ') : '';
    return { name: (line && line.itemName) || liveName || '', variant: variant };
  }

  window.RemontCatalogVariants = {
    orderLine: orderLine, commonContent: commonContent, listingImage: listingImage,
    group: group, values: values, pick: pick, exact: exact, label: label, memberLabel: memberLabel,
    chipsHtml: chipsHtml, hasPriceRange: hasPriceRange, cartVariantLine: cartVariantLine, optionsOf: optionsOf,
    summary: summary, productListings: productListings,
  };
})();

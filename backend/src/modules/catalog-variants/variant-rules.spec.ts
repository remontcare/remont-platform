import {
  normalizeOptionNames, normalizeMemberOptions, validateMembers, suggestVariantGroups, splitVariantName,
  orderLineSnapshot, describeOptions, snapshotLabel,
} from './variant-rules';

const row = (id: string, name: string, categoryId = 'cat-pest', variantGroupId: string | null = null) => ({ id, name, categoryId, variantGroupId });

describe('normalizeOptionNames', () => {
  it('trims and keeps admin order', () => {
    expect(normalizeOptionNames([' Gas type ', 'Capacity'])).toEqual(['Gas type', 'Capacity']);
  });
  it('rejects empty, repeated (case-insensitive) and too many options', () => {
    expect(() => normalizeOptionNames([])).toThrow(/at least one option/);
    expect(() => normalizeOptionNames(['Size', ' '])).toThrow(/cannot be empty/);
    expect(() => normalizeOptionNames(['Size', 'size'])).toThrow(/repeated/);
    expect(() => normalizeOptionNames(['A', 'B', 'C', 'D'])).toThrow(/at most 3/);
    expect(() => normalizeOptionNames('Size' as any)).toThrow(/must be a list/);
  });
});

describe('normalizeMemberOptions', () => {
  it('keys values by the group option names, matching case-insensitively', () => {
    expect(normalizeMemberOptions(['Size'], { size: ' 2BHK ' }, 'x')).toEqual({ Size: '2BHK' });
  });
  it('requires every option and rejects unknown ones', () => {
    expect(() => normalizeMemberOptions(['Gas type', 'Capacity'], { 'Gas type': 'R22' }, '"AC"')).toThrow(/"Capacity" needs a value/);
    expect(() => normalizeMemberOptions(['Size'], { Size: '1BHK', Colour: 'Red' }, '"AC"')).toThrow(/unknown option "Colour"/);
    expect(() => normalizeMemberOptions(['Size'], null, '"AC"')).toThrow(/option values are required/);
  });
});

describe('validateMembers', () => {
  const rows = [row('s1', 'Pest (1BHK)'), row('s2', 'Pest (2BHK)'), row('s3', 'Pest (3BHK)')];

  it('returns cleaned assignments with sort order defaulting to list position', () => {
    const out = validateMembers('g1', ['Size'], [{ id: 's2', options: { Size: '2BHK' } }, { id: 's1', options: { Size: '1BHK' }, sortOrder: 7 }], rows);
    expect(out).toEqual([
      { id: 's2', options: { Size: '2BHK' }, sortOrder: 0 },
      { id: 's1', options: { Size: '1BHK' }, sortOrder: 7 },
    ]);
  });

  it('blocks an ambiguous duplicate combination', () => {
    expect(() => validateMembers('g1', ['Size'], [{ id: 's1', options: { Size: '1BHK' } }, { id: 's2', options: { Size: '1bhk' } }], rows))
      .toThrow(/same options \(Size: 1bhk\)/);
  });

  it('blocks rows from different categories', () => {
    const mixed = [row('s1', 'Pest (1BHK)'), row('a1', 'AC (1 Ton)', 'cat-ac')];
    expect(() => validateMembers(null, ['Size'], [{ id: 's1', options: { Size: '1BHK' } }, { id: 'a1', options: { Size: '1 Ton' } }], mixed))
      .toThrow(/different category/);
  });

  it('blocks a row that already belongs to another group, but allows its own group', () => {
    const owned = [row('s1', 'Pest (1BHK)', 'cat-pest', 'other-group')];
    expect(() => validateMembers('g1', ['Size'], [{ id: 's1', options: { Size: '1BHK' } }], owned)).toThrow(/already belongs to another variant group/);
    expect(validateMembers('other-group', ['Size'], [{ id: 's1', options: { Size: '1BHK' } }], owned)).toHaveLength(1);
  });

  it('rejects unknown and repeated rows', () => {
    expect(() => validateMembers(null, ['Size'], [{ id: 'nope', options: { Size: 'x' } }], rows)).toThrow(/was not found/);
    expect(() => validateMembers(null, ['Size'], [{ id: 's1', options: { Size: '1BHK' } }, { id: 's1', options: { Size: '2BHK' } }], rows)).toThrow(/listed twice/);
  });
});

describe('splitVariantName', () => {
  it('splits a trailing (label) or – label, and drops a (Per …) unit', () => {
    expect(splitVariantName('General Pest Control (2BHK)')).toEqual({ base: 'General Pest Control', label: '2BHK' });
    expect(splitVariantName('Bathroom Deep Cleaning – Pack of 2')).toEqual({ base: 'Bathroom Deep Cleaning', label: 'Pack of 2' });
    expect(splitVariantName('Termite Treatment – Post-Construction (Per Sqft)')).toEqual({ base: 'Termite Treatment', label: 'Post-Construction' });
    expect(splitVariantName('AC Repair')).toEqual({ base: 'AC Repair', label: null });
  });
});

describe('suggestVariantGroups (real catalog names)', () => {
  const svc = (id: string, name: string, price: number, categoryId = 'pest') => ({ id, name, price, categoryId });

  it('groups sizes of one service, cheapest first, with a guessed option name', () => {
    const out = suggestVariantGroups([
      svc('3', 'General Pest Control (3BHK)', 1299), svc('1', 'General Pest Control (1BHK)', 799),
      svc('2', 'General Pest Control (2BHK)', 999), svc('x', 'Termite Inspection', 0),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('General Pest Control');
    expect(out[0].optionNames).toEqual(['Size']);
    expect(out[0].members.map((m) => m.options.Size)).toEqual(['1BHK', '2BHK', '3BHK']);
  });

  it('splits a two-part label into two options', () => {
    const out = suggestVariantGroups([
      svc('a', 'AC Gas Filling / Top-Up (R22, 1.5 Ton)', 2199, 'ac'), svc('b', 'AC Gas Filling / Top-Up (R22, 1 Ton)', 1399, 'ac'),
      svc('c', 'AC Gas Filling / Top-Up (R32/R410, 1 Ton)', 2500, 'ac'),
    ]);
    expect(out[0].optionNames).toEqual(['Option', 'Capacity']);
    expect(out[0].members[0].options).toEqual({ Option: 'R22', Capacity: '1 Ton' });
  });

  it('never proposes across categories, already-grouped rows, singles or duplicate combinations', () => {
    expect(suggestVariantGroups([svc('1', 'CCTV Installation (2 Cameras)', 1499, 'a'), svc('2', 'CCTV Installation (4 Cameras)', 2499, 'b')])).toEqual([]);
    expect(suggestVariantGroups([{ ...svc('1', 'Tank (Up to 1000L)', 599), variantGroupId: 'g' }, svc('2', 'Tank (Up to 2000L)', 899)])).toEqual([]);
    expect(suggestVariantGroups([svc('1', 'X Service (1BHK)', 1), svc('2', 'X Service (1BHK)', 2)])).toEqual([]);
  });
});

describe('orderLineSnapshot', () => {
  it('freezes the name and ordered options of a variant', () => {
    expect(orderLineSnapshot({
      name: 'AC Gas (R22, 1 Ton)', variantGroupId: 'g1',
      variantOptions: { Capacity: '1 Ton', 'Gas type': 'R22' }, variantGroup: { optionNames: ['Gas type', 'Capacity'] },
    })).toEqual({
      itemName: 'AC Gas (R22, 1 Ton)', variantGroupId: 'g1',
      variantOptions: [{ name: 'Gas type', value: 'R22' }, { name: 'Capacity', value: '1 Ton' }],
    });
  });
  it('keeps just the name for a standalone row', () => {
    const s = orderLineSnapshot({ name: 'AC Repair', variantGroupId: null, variantOptions: null });
    expect(s.itemName).toBe('AC Repair');
    expect(s.variantGroupId).toBeUndefined();
    expect(s.variantOptions).toBeUndefined();
  });
});

describe('snapshotLabel', () => {
  it('formats an order-line snapshot and ignores older lines', () => {
    expect(snapshotLabel([{ name: 'Size', value: '2BHK' }, { name: 'Colour', value: 'White' }])).toBe('Size: 2BHK · Colour: White');
    expect(snapshotLabel(null)).toBe('');
    expect(snapshotLabel({ Size: '2BHK' })).toBe('');
  });
});

describe('describeOptions', () => {
  it('formats in option order', () => {
    expect(describeOptions(['Gas type', 'Capacity'], { Capacity: '1 Ton', 'Gas type': 'R22' })).toBe('Gas type: R22 · Capacity: 1 Ton');
    expect(describeOptions(['Size'], null)).toBe('');
  });
});

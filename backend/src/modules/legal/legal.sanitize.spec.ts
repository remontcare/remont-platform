import { sanitizeHtml, safeHref, sanitizeText, renderVariables, findUnresolved } from './legal.sanitize';

describe('sanitizeHtml — XSS', () => {
  const cases: Array<[string, string]> = [
    ['<script>alert(1)</script><p>ok</p>', '<p>ok</p>'],
    ['<SCRIPT SRC=//x.js></SCRIPT>hi', 'hi'],
    ['<img src=x onerror=alert(1)>text', 'text'],
    ['<p onclick="alert(1)" style="color:red" class="x">p</p>', '<p>p</p>'],
    ['<iframe src="https://evil"></iframe>after', 'after'],
    ['<svg><script>alert(1)</script></svg>x', 'x'],
    ['<style>body{display:none}</style>y', 'y'],
    ['<!-- <script>alert(1)</script> -->z', 'z'],
    ['<a href="javascript:alert(1)">l</a>', '<a>l</a>'],
    ['<a href="JaVaScRiPt:alert(1)">l</a>', '<a>l</a>'],
    ['<a href="java&#115;cript:alert(1)">l</a>', '<a>l</a>'],
    ['<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">l</a>', '<a>l</a>'],
    ['<a href="java\tscript:alert(1)">l</a>', '<a>l</a>'],
    ['<a href=" javascript:alert(1)">l</a>', '<a>l</a>'],
    ['<a href="data:text/html;base64,PHNjcmlwdD4=">l</a>', '<a>l</a>'],
    ['<a href="vbscript:msgbox(1)">l</a>', '<a>l</a>'],
    ['<a href="//evil.com">l</a>', '<a>l</a>'],
    ['<form action="x"><input name="p"></form>t', 't'],
    ['<scr<script>ipt>alert(1)</script>', 'ipt&gt;alert(1)'],
    ['a < b and c > d', 'a &lt; b and c &gt; d'],
  ];
  it.each(cases)('%s', (input, expected) => {
    expect(sanitizeHtml(input)).toBe(expected);
  });

  it('never emits an executable construct for a battery of payloads', () => {
    const payloads = [
      '<body onload=alert(1)>', '<details open ontoggle=alert(1)>', '<math><mtext></mtext></math>',
      '<object data="x"></object>', '<embed src=x>', '<base href="//evil">', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
      '<a href="javascript&colon;alert(1)">x</a>', '<a href="jav&#x09;ascript:alert(1)">x</a>', '<p style="background:url(javascript:alert(1))">x</p>',
    ];
    for (const p of payloads) {
      const out = sanitizeHtml(p).toLowerCase();
      expect(out).not.toMatch(/<(script|iframe|object|embed|base|meta|body|details|math|svg|img|form)/);
      expect(out).not.toMatch(/\son\w+=/);
      expect(out).not.toContain('javascript:');
      expect(out).not.toContain('style=');
    }
  });

  it('keeps the allowed formatting vocabulary', () => {
    const html = '<h2>T</h2><p><strong>b</strong> <em>i</em> <u>u</u></p><ul><li>a</li></ul><ol><li>b</li></ol><blockquote>q</blockquote><table><tr><td colspan="2">c</td></tr></table><br><hr>';
    expect(sanitizeHtml(html)).toBe(html);
  });

  it('keeps safe links and marks external ones rel=noopener', () => {
    expect(sanitizeHtml('<a href="/terms">t</a>')).toBe('<a href="/terms">t</a>');
    expect(sanitizeHtml('<a href="mailto:a@b.com">m</a>')).toBe('<a href="mailto:a@b.com">m</a>');
    expect(sanitizeHtml('<a href="https://x.com/a?b=1&c=2">x</a>')).toBe('<a href="https://x.com/a?b=1&amp;c=2" rel="noopener noreferrer nofollow" target="_blank">x</a>');
  });

  it('preserves {{VARIABLES}} and [[placeholders]] as text', () => {
    expect(sanitizeHtml('<p>{{SUPPORT_EMAIL}} [[commission rate]]</p>')).toBe('<p>{{SUPPORT_EMAIL}} [[commission rate]]</p>');
  });
});

describe('safeHref', () => {
  it('allows http(s)/mailto/tel/relative/fragment', () => {
    for (const h of ['https://a.com', 'http://a.com', 'mailto:x@y.z', 'tel:+911234', '/privacy', '#top', 'privacy']) expect(safeHref(h)).toBe(h);
  });
  it('rejects scripts and data', () => {
    for (const h of ['javascript:x', 'data:x', 'vbscript:x', '//evil.com', 'file:///etc/passwd']) expect(safeHref(h)).toBeNull();
  });
});

describe('sanitizeText', () => {
  it('strips tags and control characters', () => {
    expect(sanitizeText('<b>Privacy</b>\n<script>x</script> Policy')).toBe('Privacy x Policy');
  });
});

describe('renderVariables', () => {
  it('substitutes and HTML-escapes values', () => {
    const r = renderVariables('<p>{{COMPANY_NAME}} — {{SUPPORT_EMAIL}}</p>', { COMPANY_NAME: 'A & <B>', SUPPORT_EMAIL: 'x@y.z' });
    expect(r.html).toBe('<p>A &amp; &lt;B&gt; — x@y.z</p>');
    expect(r.missing).toEqual([]);
  });
  it('shows a visible marker for unset variables and reports them', () => {
    const r = renderVariables('{{GRIEVANCE_OFFICER}}', {});
    expect(r.html).toBe('[grievance officer not set]');
    expect(r.missing).toEqual(['GRIEVANCE_OFFICER']);
  });
  it('leaves unknown {{TOKENS}} alone', () => {
    expect(renderVariables('{{NOT_A_VAR}}', {}).html).toBe('{{NOT_A_VAR}}');
  });
  it('findUnresolved lists placeholders and missing variables', () => {
    const r = findUnresolved('<p>[[commission]] {{SUPPORT_EMAIL}} {{COMPANY_NAME}}</p>', { COMPANY_NAME: 'R' });
    expect(r.placeholders).toEqual(['commission']);
    expect(r.missingVariables).toEqual(['SUPPORT_EMAIL']);
  });
});

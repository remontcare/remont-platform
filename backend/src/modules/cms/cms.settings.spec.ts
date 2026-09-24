import { CmsService, PUBLIC_SETTING_GROUPS } from './cms.module';

// The public GET /cms/settings used to return every SiteSetting row, including
// group "payment" (razorpay_key_secret, razorpay_webhook_secret). These tests
// pin the allowlist so that can't come back.
const ROWS = [
  { key: 'site_name', value: 'Remont India', group: 'general' },
  { key: 'support_phone', value: '+91 00000 00000', group: 'contact' },
  { key: 'social_instagram', value: 'https://instagram.com/x', group: 'social' },
  { key: 'total_cities', value: '2', group: 'stats' },
  { key: 'otp_regen_max_attempts', value: '3', group: 'operations' },
  { key: 'razorpay_key_id', value: 'rzp_test_x', group: 'payment' },
  { key: 'razorpay_key_secret', value: 'SECRET', group: 'payment' },
  { key: 'razorpay_webhook_secret', value: 'SECRET2', group: 'payment' },
  { key: 'ai_web_search_cost', value: '1', group: 'ai' },
  { key: 'some_api_key', value: 'SECRET3', group: 'contact' },
];

function makeService() {
  const findMany = jest.fn(async (args: any) => {
    const g = args.where.group;
    return ROWS.filter((r) => (typeof g === 'string' ? r.group === g : g.in.includes(r.group)));
  });
  return { svc: new CmsService({ siteSetting: { findMany } } as any), findMany };
}

describe('CmsService.getSettings() — public allowlist', () => {
  it('never returns payment or ai settings when called without a group', async () => {
    const { svc } = makeService();
    const out = await svc.getSettings();
    expect(Object.keys(out).sort()).toEqual(
      ['otp_regen_max_attempts', 'site_name', 'social_instagram', 'support_phone', 'total_cities'],
    );
    expect(JSON.stringify(out)).not.toContain('SECRET');
  });

  it('asking for the payment group directly returns nothing and never queries it', async () => {
    const { svc, findMany } = makeService();
    expect(await svc.getSettings('payment')).toEqual({});
    expect(findMany).not.toHaveBeenCalled();
  });

  it('drops secret-looking keys even inside an allowed group', async () => {
    const { svc } = makeService();
    expect(await svc.getSettings('contact')).toEqual({ support_phone: '+91 00000 00000' });
  });

  it('still serves every group the public site reads', async () => {
    const { svc } = makeService();
    for (const g of ['general', 'contact', 'social', 'stats', 'operations']) {
      expect(PUBLIC_SETTING_GROUPS).toContain(g);
      expect(Object.keys(await svc.getSettings(g)).length).toBeGreaterThan(0);
    }
  });
});

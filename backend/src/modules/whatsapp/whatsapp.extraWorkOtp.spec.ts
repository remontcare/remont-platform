import { WhatsappService } from './whatsapp.module';

/**
 * sendExtraWorkOtp() must report whether MSG91 actually accepted the message (the caller tells
 * the partner otherwise), never store the code in WhatsappLog, and — when a dedicated DLT
 * template is configured — send the code as a named variable rather than free text.
 */
const ENV_KEYS = ['MSG91_AUTH_KEY', 'MSG91_OTP_TEMPLATE_ID', 'MSG91_TEMPLATE_ID', 'MSG91_EXTRA_WORK_OTP_TEMPLATE_ID', 'NODE_ENV'];

describe('WhatsappService.sendExtraWorkOtp', () => {
  const saved: Record<string, string | undefined> = {};
  let fetchMock: jest.Mock;

  beforeEach(() => {
    ENV_KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });
  afterEach(() => {
    ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  });

  function makeService() {
    const prisma: any = {
      user: { findUnique: jest.fn().mockResolvedValue({ language: 'EN' }) },
      whatsappLog: {
        create: jest.fn(async ({ data }) => ({ id: 'log1', ...data })),
        update: jest.fn(async () => ({})),
      },
    };
    return { prisma, wa: new WhatsappService(prisma) };
  }

  it('masks the code in WhatsappLog and reports delivered when MSG91 accepts', async () => {
    process.env.MSG91_AUTH_KEY = 'k';
    process.env.MSG91_OTP_TEMPLATE_ID = 'shared-tpl';
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ type: 'success' }) });
    const { prisma, wa } = makeService();

    const res = await wa.sendExtraWorkOtp('+919000000001', 'RI-1001', '4821', 300);

    expect(res.delivered).toBe(true);
    const stored = prisma.whatsappLog.create.mock.calls[0][0].data.messageBody;
    expect(stored).not.toContain('4821');
    expect(stored).toContain('****');
    expect(stored).toContain('₹300');
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.template_id).toBe('shared-tpl');
    expect(sentBody.recipients[0].mobiles).toBe('919000000001');
    expect(sentBody.recipients[0].message).toContain('4821'); // the customer's SMS does carry it
  });

  it('reports not delivered (and marks the log FAILED) when MSG91 rejects', async () => {
    process.env.MSG91_AUTH_KEY = 'k';
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ type: 'error', message: 'template not approved' }) });
    const { prisma, wa } = makeService();
    const res = await wa.sendExtraWorkOtp('+919000000001', 'RI-1001', '4821', 300);
    expect(res.delivered).toBe(false);
    expect(prisma.whatsappLog.update).toHaveBeenCalledWith({ where: { id: 'log1' }, data: { status: 'FAILED' } });
  });

  it('reports not delivered when MSG91 is unreachable', async () => {
    process.env.MSG91_AUTH_KEY = 'k';
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    const { wa } = makeService();
    expect((await wa.sendExtraWorkOtp('+919000000001', 'RI-1001', '4821')).delivered).toBe(false);
  });

  it('in production without MSG91_AUTH_KEY nothing is sent — reported as not delivered, logged FAILED', async () => {
    process.env.NODE_ENV = 'production';
    const { prisma, wa } = makeService();
    const res = await wa.sendExtraWorkOtp('+919000000001', 'RI-1001', '4821');
    expect(res.delivered).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.whatsappLog.update).toHaveBeenCalledWith({ where: { id: 'log1' }, data: { status: 'FAILED' } });
  });

  it('uses the dedicated DLT template with named variables when MSG91_EXTRA_WORK_OTP_TEMPLATE_ID is set', async () => {
    process.env.MSG91_AUTH_KEY = 'k';
    process.env.MSG91_OTP_TEMPLATE_ID = 'shared-tpl';
    process.env.MSG91_EXTRA_WORK_OTP_TEMPLATE_ID = 'extra-tpl';
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ type: 'success' }) });
    const { wa } = makeService();
    await wa.sendExtraWorkOtp('+919000000001', 'RI-1001', '4821', 300);
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sentBody.template_id).toBe('extra-tpl');
    expect(sentBody.recipients[0]).toEqual({ mobiles: '919000000001', otp: '4821', order: 'RI-1001', amount: '300' });
  });
});

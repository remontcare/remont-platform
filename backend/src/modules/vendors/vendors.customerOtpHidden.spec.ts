import { ServiceVendorsController } from './vendors.module';
import { withoutCustomerOtps } from '../../common/customer-otp';

/**
 * The start/completion OTPs and an extra-work approval code belong to the customer: the
 * technician must get them FROM the customer. Partner job endpoints returned the raw Order row
 * (startOtp/endOtp included) — on offered jobs too — so a partner could start and complete a
 * job without the customer.
 */
const job = () => ({
  id: 'o1', orderNumber: 'REM-1', status: 'VENDOR_ASSIGNED', startOtp: '4821', endOtp: '9034',
  startOtpVerified: false, address: { fullAddress: 'House 1' },
  extraWorkItems: [{ id: 'x1', description: 'Pipe', amount: 200, otp: '5512', otpVerified: false }],
});

describe('withoutCustomerOtps', () => {
  it('removes startOtp, endOtp and extra-work codes and keeps everything else', () => {
    const out: any = withoutCustomerOtps(job());
    expect(out.startOtp).toBeUndefined();
    expect(out.endOtp).toBeUndefined();
    expect(out.extraWorkItems[0].otp).toBeUndefined();
    expect(out).toMatchObject({ id: 'o1', orderNumber: 'REM-1', startOtpVerified: false, address: { fullAddress: 'House 1' } });
    expect(out.extraWorkItems[0]).toMatchObject({ id: 'x1', amount: 200, otpVerified: false });
  });

  it('handles lists, null and rows without extra work', () => {
    expect(withoutCustomerOtps(null)).toBeNull();
    const list: any[] = withoutCustomerOtps([job(), { id: 'o2', startOtp: '1111' }]);
    expect(list.map((o) => o.startOtp)).toEqual([undefined, undefined]);
    expect(list[1]).toEqual({ id: 'o2' });
  });
});

describe('ServiceVendorsController — no customer OTP in any partner job response', () => {
  const vs: any = {
    myJobs: jest.fn(async () => [job()]),
    availableJobs: jest.fn(async () => [job()]),
    getJobDetail: jest.fn(async () => job()),
    acceptJob: jest.fn(async () => job()),
    rejectJob: jest.fn(async () => job()),
  };
  const c = new ServiceVendorsController(vs);
  const u: any = { sub: 'partner-user' };
  const leaks = (x: any) => /"(startOtp|endOtp|otp)":/.test(JSON.stringify(x));

  it.each([
    ['My Jobs', () => c.jobs(u)],
    ['available jobs', () => c.availJobs(u)],
    ['job detail', () => c.jobDetail(u, 'o1')],
    ['accept', () => c.accept(u, 'o1')],
    ['reject', () => c.reject(u, 'o1')],
  ])('%s', async (_name, run) => {
    const res = await run();
    expect(leaks(res)).toBe(false);
  });
});

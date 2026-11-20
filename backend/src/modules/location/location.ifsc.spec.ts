import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { LocationService } from './location.module';

/** GET /location/ifsc/:code — seller registration fills bank name + branch from the IFSC. */
describe('LocationService.lookupIfsc', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  function mockFetch(status: number, body: any) {
    const fn = jest.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, json: async () => body });
    global.fetch = fn as any;
    return fn;
  }

  it('returns bank + branch for a valid IFSC (case-insensitive) and caches it', async () => {
    const fetchFn = mockFetch(200, { BANK: 'HDFC Bank', BRANCH: 'MP Nagar', ADDRESS: 'Zone 1', CITY: 'Bhopal', STATE: 'Madhya Pradesh' });
    const svc = new LocationService();
    await expect(svc.lookupIfsc('hdfc0001234')).resolves.toEqual({
      ifsc: 'HDFC0001234', bank: 'HDFC Bank', branch: 'MP Nagar', address: 'Zone 1', city: 'Bhopal', state: 'Madhya Pradesh',
    });
    await svc.lookupIfsc('HDFC0001234');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][0]).toBe('https://ifsc.razorpay.com/HDFC0001234');
  });

  it('rejects a malformed IFSC without calling out', async () => {
    const fetchFn = mockFetch(200, {});
    await expect(new LocationService().lookupIfsc('HDFC123')).rejects.toBeInstanceOf(BadRequestException);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('unknown IFSC → 404', async () => {
    mockFetch(404, 'Not Found');
    await expect(new LocationService().lookupIfsc('ABCD0123456')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('upstream down → 503 so the app falls back to manual entry', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('timeout')) as any;
    await expect(new LocationService().lookupIfsc('HDFC0001234')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

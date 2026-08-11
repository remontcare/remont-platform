import { LeadSource } from '@prisma/client';
import { AiToolExecutor, SUPPORT_WHATSAPP } from './ai-tools';

function makeDeps() {
  return {
    servicesSvc: { search: jest.fn(async (): Promise<any> => []) },
    productsSvc: { list: jest.fn(async (): Promise<any> => []) },
    citiesSvc: { getByName: jest.fn(async (): Promise<any> => null), getActiveServicesForCity: jest.fn(async (): Promise<any> => []) },
    crm: { captureLead: jest.fn(async (data: any) => ({ id: 'lead-1', ...data })) },
    estimatesSvc: { estimate: jest.fn(async (): Promise<any> => ({ estimateId: 'est-1' })) },
    partnerReg: { initRegistration: jest.fn(async (): Promise<any> => ({ registrationId: 'PR-1', isNew: true })), saveStep: jest.fn(async (): Promise<any> => ({ saved: true })) },
    sellerReg: { initRegistration: jest.fn(async (): Promise<any> => ({ registrationId: 'SR-1', isNew: true })), saveStep: jest.fn(async (): Promise<any> => ({ saved: true })) },
  };
}
function makeExecutor(deps = makeDeps()) {
  return { exec: new AiToolExecutor(deps.servicesSvc as any, deps.productsSvc as any, deps.citiesSvc as any, deps.crm as any, deps.estimatesSvc as any, deps.partnerReg as any, deps.sellerReg as any), deps };
}

describe('AiToolExecutor — every tool reuses a real existing service, never invents data', () => {
  it('search_services maps real service rows to id/name/price/unit — no invented prices', async () => {
    const deps = makeDeps();
    deps.servicesSvc.search = jest.fn(async () => [
      { id: 'svc-1', name: 'AC Service & Repair', category: { key: 'ac', name: 'AC' }, basePrice: 499, originalPrice: 699, unit: 'per visit', durationMinutes: 60 },
    ]);
    const { exec } = makeExecutor(deps);
    const { result } = await exec.execute('search_services', { query: 'AC cooling' }, {});
    expect(deps.servicesSvc.search).toHaveBeenCalledWith('AC cooling');
    expect(result).toEqual([{ id: 'svc-1', name: 'AC Service & Repair', categoryKey: 'ac', categoryName: 'AC', basePrice: 499, originalPrice: 699, unit: 'per visit', durationMinutes: 60 }]);
  });

  it('search_products calls the real product catalog with the customer city', async () => {
    const { exec, deps } = makeExecutor();
    await exec.execute('search_products', { query: 'bathroom mixer' }, { city: 'Bhopal' });
    expect(deps.productsSvc.list).toHaveBeenCalledWith({ q: 'bathroom mixer', city: 'Bhopal', limit: 8 });
  });

  it('check_city_availability reads City.activeServiceKeys — the same field the live homepage city modal uses — not the sparser CityService join table', async () => {
    const deps = makeDeps();
    deps.citiesSvc.getByName = jest.fn(async () => ({ id: 'city-1', isActive: true, priceMultiplier: 1, activeServiceKeys: ['ac', 'plumbing'] }) as any);
    const { exec } = makeExecutor(deps);
    const { result } = await exec.execute('check_city_availability', { city: 'Bhopal' }, {});
    expect(result).toEqual({ city: 'Bhopal', isKnownCity: true, activeCategoryKeys: ['ac', 'plumbing'] });
    expect(deps.citiesSvc.getActiveServicesForCity).not.toHaveBeenCalled();
  });

  it('check_city_availability on an unknown city reports isKnownCity: false, not a silent yes', async () => {
    const { exec } = makeExecutor(); // default mocks: getByName -> null
    const { result } = await exec.execute('check_city_availability', { city: 'Nowhereville' }, {});
    expect((result as any).isKnownCity).toBe(false);
  });

  it('get_estimate delegates to the real Estimate Engine, falling back to context city', async () => {
    const { exec, deps } = makeExecutor();
    await exec.execute('get_estimate', { serviceId: 'svc-1', sqft: 120 }, { city: 'Indore' });
    expect(deps.estimatesSvc.estimate).toHaveBeenCalledWith({ serviceId: 'svc-1', city: 'Indore', sqft: 120 });
  });

  it('add_service_to_cart makes no DB call — returns a FrontendAction for the browser\'s existing addToCart()', async () => {
    const { exec, deps } = makeExecutor();
    const { result, action } = await exec.execute('add_service_to_cart', { serviceId: 'svc-1', name: 'AC Service', price: 499, unit: 'per visit', categoryKey: 'ac' }, {});
    expect(result).toEqual({ added: true, item: { id: 'svc-1', name: 'AC Service', price: 499, type: 'service', unit: 'per visit', categoryKey: 'ac' } });
    expect(action).toEqual({ type: 'ADD_SERVICE_TO_CART', payload: { id: 'svc-1', name: 'AC Service', price: 499, type: 'service', unit: 'per visit', categoryKey: 'ac' } });
    expect(deps.crm.captureLead).not.toHaveBeenCalled();
  });

  it('add_product_to_cart returns the matching product FrontendAction', async () => {
    const { exec } = makeExecutor();
    const { action } = await exec.execute('add_product_to_cart', { productId: 'p-1', name: 'Bathroom Mixer', price: 1200 }, {});
    expect(action).toEqual({ type: 'ADD_PRODUCT_TO_CART', payload: { id: 'p-1', name: 'Bathroom Mixer', price: 1200, type: 'product', unit: 'piece' } });
  });

  it('create_lead calls the real public CRM capture endpoint with AI_CHAT source', async () => {
    const { exec, deps } = makeExecutor();
    const { result } = await exec.execute('create_lead', {
      customerName: 'Anjali', customerPhone: '9876543210', serviceInterested: '2BHK Complete Interior', notes: 'Bhopal, 900 sqft, budget 4-5L',
    }, { city: 'Bhopal', sessionId: 'sess-1' });
    expect(deps.crm.captureLead).toHaveBeenCalledWith(expect.objectContaining({
      customerName: 'Anjali', customerPhone: '9876543210', cityName: 'Bhopal',
      source: LeadSource.AI_CHAT, serviceInterested: '2BHK Complete Interior', aiSessionId: 'sess-1',
    }));
    expect(result).toEqual({ leadId: 'lead-1', created: true });
  });

  it('create_lead falls back to conversation context when the model omits name/phone args', async () => {
    const { exec, deps } = makeExecutor();
    await exec.execute('create_lead', { serviceInterested: 'Plumbing' }, { customerName: 'Rohit', customerPhone: '9998887777' });
    expect(deps.crm.captureLead).toHaveBeenCalledWith(expect.objectContaining({ customerName: 'Rohit', customerPhone: '9998887777' }));
  });

  it('create_site_visit_request prefixes the notes so CRM agents can tell it apart from a generic lead', async () => {
    const { exec, deps } = makeExecutor();
    await exec.execute('create_site_visit_request', { customerName: 'Rohit', customerPhone: '9998887777', city: 'Bhopal', serviceInterested: 'Kitchen Renovation', notes: 'Wants tiles + plumbing' }, {});
    const call = deps.crm.captureLead.mock.calls[0][0];
    expect(call.notes).toMatch(/^Site visit requested\./);
    expect(call.notes).toContain('Wants tiles + plumbing');
  });

  it('start_partner_registration(SERVICE) creates a real draft and returns a hand-off action', async () => {
    const { exec, deps } = makeExecutor();
    const { result, action } = await exec.execute('start_partner_registration', {
      partnerType: 'SERVICE', fullName: 'Suresh Kumar', phone: '9876500000', city: 'Bhopal', category: 'plumber', experienceYears: '5',
    }, {});
    expect(deps.partnerReg.initRegistration).toHaveBeenCalledWith('+919876500000', 'EN');
    expect(deps.partnerReg.saveStep).toHaveBeenCalledWith('PR-1', 1, { fullName: 'Suresh Kumar', city: 'Bhopal', categories: ['plumber'], experienceYears: '5' });
    expect((result as any).registrationId).toBe('PR-1');
    expect(action).toEqual({ type: 'CONTINUE_PARTNER_REGISTRATION', payload: { registrationId: 'PR-1', continueUrl: '/partner-register.html' } });
  });

  it('start_partner_registration(SELLER) routes to the seller registration flow instead', async () => {
    const { exec, deps } = makeExecutor();
    const { action } = await exec.execute('start_partner_registration', {
      partnerType: 'SELLER', fullName: 'Meena Traders', phone: '9876511111', city: 'Indore', category: 'AC accessories',
    }, {});
    expect(deps.sellerReg.initRegistration).toHaveBeenCalledWith('9876511111');
    expect(deps.partnerReg.initRegistration).not.toHaveBeenCalled();
    expect(action).toEqual({ type: 'CONTINUE_SELLER_REGISTRATION', payload: { registrationId: 'SR-1', continueUrl: '/seller-register.html' } });
  });

  it('start_partner_registration rejects an invalid phone WITHOUT touching the registration draft tables', async () => {
    const { exec, deps } = makeExecutor();
    const { result, action } = await exec.execute('start_partner_registration', { partnerType: 'SERVICE', fullName: 'X', phone: '123' }, {});
    expect((result as any).error).toBeDefined();
    expect(action).toBeUndefined();
    expect(deps.partnerReg.initRegistration).not.toHaveBeenCalled();
  });

  it('handover_to_human returns the real, existing support WhatsApp number and captures a follow-up lead when phone is known', async () => {
    const { exec, deps } = makeExecutor();
    const { result, action } = await exec.execute('handover_to_human', { reason: 'Structural crack, needs an engineer' }, { customerPhone: '9876543210', customerName: 'Amit', city: 'Bhopal' });
    expect(result).toEqual({ handedOver: true, whatsapp: SUPPORT_WHATSAPP, phone: '+919876543210' });
    expect(action).toEqual({ type: 'OPEN_WHATSAPP', payload: { number: SUPPORT_WHATSAPP, reason: 'Structural crack, needs an engineer' } });
    expect(deps.crm.captureLead).toHaveBeenCalledWith(expect.objectContaining({ serviceInterested: 'Human handover', notes: 'Structural crack, needs an engineer' }));
  });

  it('handover_to_human never blocks on a missing phone — still hands over, just skips lead capture', async () => {
    const { exec, deps } = makeExecutor();
    const { action } = await exec.execute('handover_to_human', { reason: 'Customer asked for a person' }, {});
    expect(action?.type).toBe('OPEN_WHATSAPP');
    expect(deps.crm.captureLead).not.toHaveBeenCalled();
  });

  it('present_options is a pure UI signal — no service call, echoes back trimmed/capped options', async () => {
    const { exec, deps } = makeExecutor();
    const { result, action } = await exec.execute('present_options', { options: ['House', 'Flat', 'Commercial'] }, {});
    expect(result).toEqual({ presented: true, options: ['House', 'Flat', 'Commercial'] });
    expect(action).toBeUndefined();
    expect(deps.crm.captureLead).not.toHaveBeenCalled();
  });

  it('present_options drops non-string/empty entries and caps at 6', async () => {
    const { exec } = makeExecutor();
    const { result } = await exec.execute('present_options', { options: ['1 BHK', '', '2 BHK', 42, '3 BHK', '4 BHK', '5 BHK', '6 BHK'] }, {});
    expect((result as any).options).toEqual(['1 BHK', '2 BHK', '3 BHK', '4 BHK', '5 BHK', '6 BHK']);
  });

  it('an unknown tool name returns a clean error instead of throwing', async () => {
    const { exec } = makeExecutor();
    const { result } = await exec.execute('delete_all_orders', {}, {});
    expect((result as any).error).toMatch(/Unknown tool/);
  });

  it('a tool that throws internally is caught — execute() never propagates', async () => {
    const deps = makeDeps();
    deps.servicesSvc.search = jest.fn(async () => { throw new Error('DB unreachable'); });
    const { exec } = makeExecutor(deps);
    const { result } = await exec.execute('search_services', { query: 'AC' }, {});
    expect((result as any).error).toBe('DB unreachable');
  });
});

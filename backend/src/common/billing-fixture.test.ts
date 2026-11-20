// Test fixture (excluded from the build; not itself a suite): the saved billing settings an invoice
// now requires (getBillingCompanyConfig no longer falls back to hard-coded company details).
import { GST_STATE_CODES } from './billing-engine';

export function billingSettingRows(state = 'Madhya Pradesh') {
  const code = Object.keys(GST_STATE_CODES).find((k) => GST_STATE_CODES[k] === state) || '23';
  return [
    { key: 'company_legal_name', value: 'Remont India Private Limited' },
    { key: 'company_gstin', value: `${code}AAKCR9036L1ZY` },
    { key: 'company_address', value: '5/6 Amer Complex, MP Nagar Zone-2, Bhopal' },
    { key: 'company_mobile', value: '9425330195' },
    { key: 'company_email', value: 'contact@remontindia.com' },
  ];
}

/** siteSetting.findMany stand-in: billing rows for the 'billing' group, nothing for any other query. */
export function billingFindMany(state?: string) {
  return async (args?: any) => (args?.where?.group === 'billing' ? billingSettingRows(state) : []);
}

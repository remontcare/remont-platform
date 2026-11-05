/**
 * The start/completion OTPs and an extra-work item's approval code are what the CUSTOMER gives
 * the technician to prove they are there and agree. They must never be in a partner-facing
 * response, or a technician could start and complete a job (and be paid for it) without the
 * customer. Neither the Partner App nor vendor.html reads these fields; they only send the code
 * the customer tells them. Customer-facing order responses keep them.
 */
export function withoutCustomerOtps<T>(data: T): T {
  const strip = (o: any) => {
    if (!o || typeof o !== 'object') return o;
    const { startOtp, endOtp, ...rest } = o;
    if (Array.isArray(rest.extraWorkItems)) rest.extraWorkItems = rest.extraWorkItems.map(({ otp, ...item }: any) => item);
    return rest;
  };
  return (Array.isArray(data) ? data.map(strip) : strip(data)) as T;
}

/**
 * True when two phone numbers are the same subscriber — compares the last 10 digits, since
 * registration rows store "+91XXXXXXXXXX" while clients may send "XXXXXXXXXX" or "91…".
 * Used to tie a self-service registration to the phone in the caller's OTP-issued JWT.
 */
export function samePhone(a?: string | null, b?: string | null): boolean {
  const norm = (p?: string | null) => (p || '').replace(/\D/g, '').slice(-10);
  return !!norm(a) && norm(a) === norm(b);
}

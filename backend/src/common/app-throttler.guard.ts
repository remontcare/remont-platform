import { ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerGuard } from '@nestjs/throttler';

/** Requests per minute, per route, per signed-in user (the ThrottlerModule default). */
export const DEFAULT_THROTTLE_LIMIT = 200;
/**
 * Per IP without a login. Higher than the per-user limit because one IP can be many people:
 * every website visitor arrives through Vercel's proxy, and mobile networks share IPs (CGNAT).
 */
export const ANONYMOUS_THROTTLE_LIMIT = 3000;
/** OTP requests per IP, on top of the per-phone limit from the route's @Throttle. */
export const OTP_IP_THROTTLE_LIMIT = 100;

const OTP_ROUTE = /\/auth\/(send-otp|verify-otp)$/;
const jwt = new JwtService({});

/**
 * Counts each signed-in user separately and each phone number separately on the OTP routes.
 * Counting only by IP blocked real users who share one (all of the website, behind Vercel).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  private subject(req: Record<string, any>): string | null {
    if (req.throttleSubject !== undefined) return req.throttleSubject;
    const header = req.headers?.authorization;
    let sub: string | null = null;
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      try {
        sub = jwt.verify(header.slice(7), { secret: process.env.JWT_SECRET })?.sub ?? null;
      } catch {
        sub = null; // an invalid token counts against the IP, never as a user
      }
    }
    req.throttleSubject = sub;
    return sub;
  }

  protected async getTracker(req: Record<string, any>): Promise<string> {
    const sub = this.subject(req);
    return sub ? `u:${sub}` : `ip:${req.ip}`;
  }

  protected async handleRequest(
    context: ExecutionContext, limit: number, ttl: number,
    throttler: Parameters<ThrottlerGuard['handleRequest']>[3],
    getTracker: Parameters<ThrottlerGuard['handleRequest']>[4],
    generateKey: Parameters<ThrottlerGuard['handleRequest']>[5],
  ): Promise<boolean> {
    const { req } = this.getRequestResponse(context);
    const route = String(req.originalUrl || req.url || '').split('?')[0];
    if (OTP_ROUTE.test(route)) {
      await super.handleRequest(context, OTP_IP_THROTTLE_LIMIT, ttl, throttler, async (r) => `otp-ip:${r.ip}`, generateKey);
      // Last 10 digits, so +91… and 91… count as the same number.
      const phone = String(req.body?.phone ?? '').replace(/\D/g, '').slice(-10);
      if (phone) return super.handleRequest(context, limit, ttl, throttler, async () => `otp-phone:${phone}`, generateKey);
      return super.handleRequest(context, limit, ttl, throttler, getTracker, generateKey);
    }
    const effective = limit === DEFAULT_THROTTLE_LIMIT && !this.subject(req) ? ANONYMOUS_THROTTLE_LIMIT : limit;
    return super.handleRequest(context, effective, ttl, throttler, getTracker, generateKey);
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { initializeApp, cert, App } from 'firebase-admin/app';
import { getMessaging, Messaging } from 'firebase-admin/messaging';

// Same "read creds from env, no-op with a logged warning until they exist" pattern
// already used by WhatsappService (MSG91_AUTH_KEY) and PaymentsService (Razorpay) —
// lets this ship now and go live the moment Firebase env vars are set, no code change.
@Injectable()
export class FcmService {
  private readonly logger = new Logger(FcmService.name);
  private app: App | null = null;

  constructor() {
    // Catches the easy-to-hit mistake of pasting the 3 Railway vars in one at a time and
    // missing one — isConfigured() treats that identically to "none set" (safe no-op), so
    // without this it fails silently instead of telling the admin what's missing.
    const vars = { FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY };
    const present = Object.values(vars).filter(Boolean).length;
    if (present > 0 && present < 3) {
      const missing = Object.entries(vars).filter(([, v]) => !v).map(([k]) => k);
      this.logger.warn(`FCM push partially configured — missing ${missing.join(', ')}. All three must be set together or push stays disabled.`);
    }
  }

  isConfigured(): boolean {
    return !!(process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY);
  }

  private getMessagingClient(): Messaging | null {
    if (!this.isConfigured()) return null;
    if (!this.app) {
      this.app = initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          // Railway/Vercel-style env vars store literal "\n" — restore real newlines.
          privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
        }),
      });
    }
    return getMessaging(this.app);
  }

  /**
   * Sends to a batch of device tokens. Returns which tokens are dead so callers can prune them.
   *
   * [dataOnly] skips the `notification` block entirely — required for JOB_OFFER, where the
   * Flutter app needs to render its own full-screen incoming-call UI (flutter_callkit_incoming)
   * instead of the OS auto-displaying a plain tray notification. A `notification` block would
   * make Android show that default notification AND skip invoking the app's background message
   * handler in some states, so the client never gets a chance to take over. `android.priority:
   * 'high'` is also required for data-only messages so Doze/App-Standby still deliver it promptly.
   */
  async sendToTokens(
    tokens: string[],
    payload: { title: string; body: string; data?: Record<string, string>; imageUrl?: string; dataOnly?: boolean },
  ): Promise<{ successCount: number; failureCount: number; deadTokens: string[] }> {
    if (!tokens.length) return { successCount: 0, failureCount: 0, deadTokens: [] };
    const messaging = this.getMessagingClient();
    if (!messaging) {
      this.logger.debug(`📵 [DEV] FCM not configured — would send to ${tokens.length} token(s): ${payload.title}`);
      return { successCount: 0, failureCount: tokens.length, deadTokens: [] };
    }

    try {
      const res = await messaging.sendEachForMulticast({
        tokens,
        ...(payload.dataOnly ? {} : { notification: { title: payload.title, body: payload.body, imageUrl: payload.imageUrl } }),
        data: payload.data || {},
        ...(payload.dataOnly ? { android: { priority: 'high' as const } } : {}),
        webpush: { fcmOptions: {}, notification: { icon: '/favicon.ico' } },
      });
      const deadTokens: string[] = [];
      res.responses.forEach((r, i) => {
        if (!r.success) {
          const code = r.error?.code;
          if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
            deadTokens.push(tokens[i]);
          } else {
            this.logger.warn(`FCM send failed for token ${tokens[i].slice(0, 12)}...: ${code}`);
          }
        }
      });
      return { successCount: res.successCount, failureCount: res.failureCount, deadTokens };
    } catch (e) {
      this.logger.error(`FCM multicast send error: ${e.message}`);
      return { successCount: 0, failureCount: tokens.length, deadTokens: [] };
    }
  }

  async sendToTopic(topic: string, payload: { title: string; body: string; data?: Record<string, string> }) {
    const messaging = this.getMessagingClient();
    if (!messaging) {
      this.logger.debug(`📵 [DEV] FCM not configured — would broadcast to topic "${topic}": ${payload.title}`);
      return { sent: false };
    }
    try {
      await messaging.send({
        topic,
        notification: { title: payload.title, body: payload.body },
        data: payload.data || {},
      });
      return { sent: true };
    } catch (e) {
      this.logger.error(`FCM topic send error (${topic}): ${e.message}`);
      return { sent: false };
    }
  }

  async subscribeToTopic(tokens: string[], topic: string) {
    const messaging = this.getMessagingClient();
    if (!messaging || !tokens.length) return;
    try { await messaging.subscribeToTopic(tokens, topic); }
    catch (e) { this.logger.warn(`Topic subscribe failed (${topic}): ${e.message}`); }
  }

  async unsubscribeFromTopic(tokens: string[], topic: string) {
    const messaging = this.getMessagingClient();
    if (!messaging || !tokens.length) return;
    try { await messaging.unsubscribeFromTopic(tokens, topic); }
    catch (e) { this.logger.warn(`Topic unsubscribe failed (${topic}): ${e.message}`); }
  }
}

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

  /** Sends to a batch of device tokens. Returns which tokens are dead so callers can prune them. */
  async sendToTokens(
    tokens: string[],
    payload: { title: string; body: string; data?: Record<string, string>; imageUrl?: string },
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
        notification: { title: payload.title, body: payload.body, imageUrl: payload.imageUrl },
        data: payload.data || {},
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

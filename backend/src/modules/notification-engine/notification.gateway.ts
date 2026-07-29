import { Logger } from '@nestjs/common';
import {
  WebSocketGateway, WebSocketServer, OnGatewayConnection, OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';

// Foreground/open-tab delivery path — instant, no FCM round-trip. Built on socket.io,
// which was already an installed dependency (@nestjs/websockets + @nestjs/platform-socket.io
// + socket.io in package.json) but had zero @WebSocketGateway anywhere before this.
// Single Railway instance today, so room-based delivery works with no extra wiring;
// if this ever scales horizontally, @socket.io/redis-adapter (ioredis already installed)
// is the follow-on — not needed yet.
@WebSocketGateway({
  namespace: '/ws/notifications',
  cors: { origin: true, credentials: true },
})
export class NotificationGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(NotificationGateway.name);

  @WebSocketServer() server: Server;

  constructor(private jwt: JwtService) {}

  handleConnection(client: Socket) {
    const token = (client.handshake.query?.token as string) || client.handshake.auth?.token;
    if (!token) { client.disconnect(true); return; }
    try {
      const payload = this.jwt.verify(token, { secret: process.env.JWT_SECRET! });
      client.data.userId = payload.sub;
      client.join(`user:${payload.sub}`);
    } catch (e) {
      client.disconnect(true);
    }
  }

  handleDisconnect(_client: Socket) {
    // Room membership is cleaned up automatically by socket.io on disconnect.
  }

  emitToUser(userId: string, event: string, payload: any) {
    this.server?.to(`user:${userId}`).emit(event, payload);
  }
}

import { Logger } from '@nestjs/common';
import {
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { BookingStatus, SeatStatus } from '@prisma/client';
import { Server, Socket } from 'socket.io';
import { TokenService } from '../auth/token.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Downstream-only realtime channel (ARCHITECTURE.md §6): clients never send
 * state-changing messages — writes go through HTTP; the socket carries
 * seat-updated / capacity-updated / booking-status pushes. Same process,
 * same port as the HTTP server.
 */
@WebSocketGateway({
  // dev default; Phase 5 hardening pins this to WEB_ORIGIN
  cors: { origin: true, credentials: true },
})
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private readonly server!: Server;

  constructor(private readonly tokens: TokenService) {}

  afterInit(server: Server): void {
    // Handshake middleware: a valid access JWT binds the socket to its user;
    // unauthenticated sockets are allowed (public availability data) but can
    // only ever join event rooms, never user rooms.
    server.use((socket, next) => {
      const token = (socket.handshake.auth as { token?: string } | undefined)?.token;
      if (token) {
        const payload = this.tokens.verifyAccessToken(token);
        if (payload) socket.data.userId = payload.sub;
      }
      next();
    });
  }

  handleConnection(socket: Socket): void {
    const userId = socket.data.userId as string | undefined;
    if (userId) void socket.join(`user:${userId}`);
  }

  @SubscribeMessage('join-event')
  onJoinEvent(@ConnectedSocket() socket: Socket, @MessageBody() eventId: unknown): void {
    if (typeof eventId === 'string' && UUID_RE.test(eventId)) {
      void socket.join(`event:${eventId}`);
    }
  }

  @SubscribeMessage('leave-event')
  onLeaveEvent(@ConnectedSocket() socket: Socket, @MessageBody() eventId: unknown): void {
    if (typeof eventId === 'string' && UUID_RE.test(eventId)) {
      void socket.leave(`event:${eventId}`);
    }
  }

  emitSeatUpdated(eventId: string, seatId: string, status: SeatStatus): void {
    this.server.to(`event:${eventId}`).emit('seat-updated', { seatId, status });
  }

  emitCapacityUpdated(eventId: string, remaining: number): void {
    this.server.to(`event:${eventId}`).emit('capacity-updated', { eventId, remaining });
  }

  emitBookingStatus(userId: string, payload: {
    bookingId: string;
    status: BookingStatus;
    failReason?: string;
  }): void {
    this.server.to(`user:${userId}`).emit('booking-status', payload);
  }
}

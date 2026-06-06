import {
  Module, Injectable, Controller, Get, Post, Body, Param, UseGuards, NotFoundException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { BookingChannel, LeadSource } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';
import { JwtAuthGuard, Public, CurrentUser, JwtPayload } from '../../common';
import { CrmService, CrmModule } from '../crm/crm.module';
import { detectIntent, detectLanguage, getReply, getSuggestions, Intent } from './intent-engine';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

@Injectable()
export class AiAgentService {
  private readonly logger = new Logger(AiAgentService.name);
  constructor(private prisma: PrismaService, private crm: CrmService) {}

  async chat(input: {
    sessionId?: string;
    userId?: string;
    message: string;
    channel?: BookingChannel;
    customerPhone?: string;
    customerName?: string;
    city?: string;
  }) {
    const lang = detectLanguage(input.message);
    const { intent, confidence } = detectIntent(input.message);
    const replyText = getReply(intent, lang);
    const suggestions = getSuggestions(intent);

    // Build messages array
    const userMsg: ChatMessage = {
      role: 'user', content: input.message, timestamp: new Date().toISOString(),
    };
    const assistantMsg: ChatMessage = {
      role: 'assistant', content: replyText, timestamp: new Date().toISOString(),
    };

    // Upsert session
    let session;
    if (input.sessionId) {
      session = await this.prisma.aiSession.findUnique({ where: { id: input.sessionId } });
    }

    if (!session) {
      session = await this.prisma.aiSession.create({
        data: {
          userId: input.userId,
          channel: input.channel || BookingChannel.AI_CHAT,
          messages: [userMsg, assistantMsg] as any[],
          resolvedIntent: intent !== 'UNKNOWN' ? intent : null,
          languageDetected: lang,
        },
      });
    } else {
      const existingMessages = Array.isArray(session.messages)
        ? (session.messages as any[])
        : [];
      session = await this.prisma.aiSession.update({
        where: { id: session.id },
        data: {
          messages: [...existingMessages, userMsg, assistantMsg],
          resolvedIntent: intent !== 'UNKNOWN' ? intent : session.resolvedIntent,
          languageDetected: lang,
        },
      });
    }

    // Capture lead if customer info present and intent is actionable
    let lead;
    if (
      input.customerPhone &&
      ['AC', 'PLUMBING', 'ELECTRICAL', 'APPLIANCE', 'INTERIOR', 'RENOVATION',
       'CONSTRUCTION', 'CLEANING', 'AMC', 'CORPORATE'].includes(intent) &&
      !session.resultLeadId
    ) {
      try {
        lead = await this.crm.captureLead({
          customerName: input.customerName || 'AI Chat User',
          customerPhone: input.customerPhone,
          cityName: input.city,
          source: input.channel === BookingChannel.WHATSAPP
            ? LeadSource.WHATSAPP : LeadSource.AI_CHAT,
          serviceInterested: intent,
          aiSessionId: session.id,
        });
        await this.prisma.aiSession.update({
          where: { id: session.id },
          data: { resultLeadId: lead.id },
        });
      } catch (e) {
        this.logger.warn(`Lead capture failed: ${e.message}`);
      }
    }

    return {
      sessionId: session.id,
      reply: replyText,
      intent,
      confidence,
      language: lang,
      suggestions,
      leadId: lead?.id,
    };
  }

  async endSession(sessionId: string, convertedOrderId?: string) {
    return this.prisma.aiSession.update({
      where: { id: sessionId },
      data: {
        endedAt: new Date(),
        ...(convertedOrderId
          ? { convertedToBooking: true, resultOrderId: convertedOrderId }
          : {}),
      },
    });
  }

  async mySessions(userId: string) {
    return this.prisma.aiSession.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  async getSession(sessionId: string) {
    const session = await this.prisma.aiSession.findUnique({ where: { id: sessionId } });
    if (!session) throw new NotFoundException();
    return session;
  }
}

@ApiTags('AI Agent')
@Controller('ai')
export class AiAgentController {
  constructor(private ai: AiAgentService) {}

  @Public() @Post('chat')
  chat(@Body() body: any) { return this.ai.chat(body); }

  @Public() @Post('session/end')
  end(@Body() b: { sessionId: string; orderId?: string }) {
    return this.ai.endSession(b.sessionId, b.orderId);
  }

  @UseGuards(JwtAuthGuard) @ApiBearerAuth() @Get('sessions/mine')
  mine(@CurrentUser() u: JwtPayload) { return this.ai.mySessions(u.sub); }

  @Public() @Get('sessions/:id')
  one(@Param('id') id: string) { return this.ai.getSession(id); }
}

@Module({
  imports: [CrmModule],
  controllers: [AiAgentController],
  providers: [AiAgentService],
  exports: [AiAgentService],
})
export class AiAgentModule {}

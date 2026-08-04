/**
 * Notification abstraction.
 *
 * The architecture is here; no transport credentials are. Each channel implements one
 * interface and registers itself, so adding Slack later means writing one class — not
 * touching the code that decides *when* to notify.
 *
 * Nothing is enabled by default: sending messages to 250 students is not something a
 * platform should start doing because a container was deployed.
 */

import { Body, Controller, Get, Injectable, Logger, Module, Patch, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';
import { NOTIFICATION_CHANNELS, type NotificationChannel, type NotificationEvent } from '@dsa/shared';

import { Roles } from '../../common/decorators';
import { PrismaService } from '../../infra/prisma/prisma.service';

export interface NotificationPayload {
  event: NotificationEvent;
  studentId?: string;
  recipient?: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/** One transport. Implement this and register it to add a channel. */
export interface NotificationTransport {
  readonly channel: NotificationChannel;
  isConfigured(config: Record<string, unknown> | null): boolean;
  send(payload: NotificationPayload, config: Record<string, unknown>): Promise<void>;
}

/**
 * Generic webhook transport, sufficient for Slack and Discord as-is: both accept a
 * JSON POST to an incoming-webhook URL.
 */
class WebhookTransport implements NotificationTransport {
  constructor(readonly channel: NotificationChannel) {}

  isConfigured(config: Record<string, unknown> | null): boolean {
    return typeof config?.webhookUrl === 'string' && config.webhookUrl.length > 0;
  }

  async send(payload: NotificationPayload, config: Record<string, unknown>): Promise<void> {
    const url = String(config.webhookUrl);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `*${payload.title}*\n${payload.body}` }),
    });
    if (!response.ok) {
      throw new Error(`Webhook responded ${response.status}`);
    }
  }
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  private readonly transports = new Map<NotificationChannel, NotificationTransport>([
    ['SLACK', new WebhookTransport('SLACK')],
    ['DISCORD', new WebhookTransport('DISCORD')],
  ]);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Dispatch to every channel configured for this event.
   *
   * Every attempt is logged whether or not it succeeds, and a transport failure never
   * propagates: a broken Slack webhook must not fail the sync that triggered it.
   */
  async dispatch(payload: NotificationPayload): Promise<void> {
    const configs = await this.prisma.notificationChannelConfig.findMany({
      where: { isEnabled: true, events: { has: payload.event } },
    });

    for (const config of configs) {
      const transport = this.transports.get(config.channel);
      const settings = (config.config ?? {}) as Record<string, unknown>;

      if (!transport || !transport.isConfigured(settings)) {
        await this.record(config.channel, payload, 'SKIPPED', 'Channel is not configured');
        continue;
      }

      try {
        await transport.send(payload, settings);
        await this.record(config.channel, payload, 'SENT', null);
      } catch (error) {
        this.logger.warn(
          `Notification via ${config.channel} failed: ${(error as Error).message}`,
        );
        await this.record(config.channel, payload, 'FAILED', (error as Error).message);
      }
    }
  }

  listChannels() {
    return this.prisma.notificationChannelConfig.findMany();
  }

  updateChannel(
    channel: NotificationChannel,
    input: { isEnabled?: boolean; config?: Record<string, unknown>; events?: NotificationEvent[] },
  ) {
    return this.prisma.notificationChannelConfig.upsert({
      where: { channel },
      create: {
        channel,
        isEnabled: input.isEnabled ?? false,
        config: (input.config ?? {}) as Prisma.InputJsonValue,
        events: input.events ?? [],
      },
      update: {
        ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
        ...(input.config !== undefined ? { config: input.config as Prisma.InputJsonValue } : {}),
        ...(input.events !== undefined ? { events: input.events } : {}),
      },
    });
  }

  private async record(
    channel: NotificationChannel,
    payload: NotificationPayload,
    status: 'SENT' | 'FAILED' | 'SKIPPED',
    error: string | null,
  ): Promise<void> {
    await this.prisma.notificationLog.create({
      data: {
        channel,
        event: payload.event,
        status,
        studentId: payload.studentId ?? null,
        recipient: payload.recipient ?? null,
        payload: { title: payload.title, body: payload.body } as Prisma.InputJsonValue,
        error,
        sentAt: status === 'SENT' ? new Date() : null,
      },
    });
  }
}

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
@Roles('ADMIN')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('channels')
  @ApiOperation({ summary: 'Configured notification channels' })
  async channels() {
    return {
      available: NOTIFICATION_CHANNELS,
      // Slack and Discord work today via the generic webhook transport; the rest need
      // a transport class before they can be enabled.
      implemented: ['SLACK', 'DISCORD'],
      configured: await this.notifications.listChannels(),
    };
  }

  @Patch('channels/:channel')
  @ApiOperation({ summary: 'Enable, disable or configure a channel' })
  update(
    @Param('channel') channel: NotificationChannel,
    @Body()
    body: { isEnabled?: boolean; config?: Record<string, unknown>; events?: NotificationEvent[] },
  ) {
    return this.notifications.updateChannel(channel, body);
  }
}

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}

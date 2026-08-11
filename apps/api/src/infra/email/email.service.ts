import { Inject, Injectable, Logger } from '@nestjs/common';

import { CONFIG_TOKEN, type AppConfig } from '../../config/configuration';
import { ResendTransport } from './resend.transport';
import {
  EmailProviderNotConfiguredError,
  type EmailSendResult,
  type EmailTransport,
  type OutboundEmail,
} from './email.types';

/**
 * The one place the rest of the app calls to send an email.
 *
 * Resolves the configured transport lazily (not at module-init) so a deployment with no
 * `EMAIL_API_KEY` boots fine and every read-only part of the daily-report feature
 * (preview, draft, approve) keeps working — only `sendEmail` itself fails, and with an
 * error that says exactly what to set.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transport: EmailTransport | null = null;

  constructor(@Inject(CONFIG_TOKEN) private readonly config: AppConfig) {}

  isConfigured(): boolean {
    return this.config.email.provider !== 'none' && Boolean(this.config.email.apiKey);
  }

  async sendEmail(email: OutboundEmail): Promise<EmailSendResult> {
    const transport = this.resolveTransport();
    this.logger.log(
      `Sending email via ${transport.provider}: "${email.subject}" to ${email.toRecipients.length} recipient(s)`,
    );
    return transport.send(email);
  }

  private resolveTransport(): EmailTransport {
    if (this.transport) return this.transport;

    if (this.config.email.provider === 'resend' && this.config.email.apiKey) {
      this.transport = new ResendTransport(this.config.email.apiKey);
      return this.transport;
    }

    throw new EmailProviderNotConfiguredError();
  }
}

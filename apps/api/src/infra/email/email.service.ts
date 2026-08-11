import { Inject, Injectable, Logger } from '@nestjs/common';

import { CONFIG_TOKEN, type AppConfig } from '../../config/configuration';
import { ResendTransport } from './resend.transport';
import {
  EmailProviderNotConfiguredError,
  EmailSendError,
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

  /** Provider name for logging and error detail, without resolving a transport. */
  get providerName(): string {
    return this.config.email.provider;
  }

  /**
   * Why sending is currently impossible, or `null` when it should work. Lets callers
   * fail a send *before* moving a report into SENDING, and lets the UI warn earlier.
   */
  configurationProblem(): string | null {
    if (this.config.email.provider === 'none') {
      return 'EMAIL_PROVIDER is not set (currently "none").';
    }
    if (!this.config.email.apiKey) return 'EMAIL_API_KEY is not set.';
    return null;
  }

  async sendEmail(email: OutboundEmail): Promise<EmailSendResult> {
    const transport = this.resolveTransport();

    if (email.toRecipients.length === 0) {
      throw new EmailSendError('Refusing to send an email with no recipients.', {
        detail: {
          provider: transport.provider,
          httpStatus: null,
          providerCode: 'no_recipients',
          providerMessage: null,
        },
        safeMessage: 'Email could not be sent — add at least one "To" recipient.',
      });
    }
    if (!email.fromEmail) {
      throw new EmailSendError('Refusing to send an email with no sender address.', {
        detail: {
          provider: transport.provider,
          httpStatus: null,
          providerCode: 'no_sender',
          providerMessage: null,
        },
        safeMessage: 'Email could not be sent — no sender address is set.',
      });
    }

    // Recipient counts, never the addresses themselves: this line lands in shared logs.
    this.logger.log(
      `Sending via ${transport.provider}: "${email.subject}" to ${email.toRecipients.length} ` +
        `recipient(s), ${email.ccRecipients?.length ?? 0} cc`,
    );
    return transport.send(email);
  }

  private resolveTransport(): EmailTransport {
    if (this.transport) return this.transport;

    if (this.config.email.provider === 'resend' && this.config.email.apiKey) {
      this.transport = new ResendTransport(
        this.config.email.apiKey,
        this.config.email.apiBaseUrl,
      );
      return this.transport;
    }

    throw new EmailProviderNotConfiguredError();
  }
}

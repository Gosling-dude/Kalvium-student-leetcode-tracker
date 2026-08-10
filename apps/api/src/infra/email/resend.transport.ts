/**
 * Resend transport (https://resend.com).
 *
 * Chosen for the free tier (3,000 emails/month, 100/day at the time of writing) and a
 * single JSON POST with no SMTP setup. Nothing provider-specific leaks past this file —
 * `EmailService` and everything upstream of it only know `EmailTransport`.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { EmailSendResult, EmailTransport, OutboundEmail } from './email.types';
import { EmailSendError } from './email.types';

const RESEND_API_URL = 'https://api.resend.com/emails';

@Injectable()
export class ResendTransport implements EmailTransport {
  readonly provider = 'resend';
  private readonly logger = new Logger(ResendTransport.name);

  constructor(private readonly apiKey: string) {}

  async send(email: OutboundEmail): Promise<EmailSendResult> {
    let response: Response;
    try {
      response = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: email.fromEmail,
          to: email.toRecipients,
          cc: email.ccRecipients?.length ? email.ccRecipients : undefined,
          subject: email.subject,
          html: email.html,
        }),
      });
    } catch (error) {
      throw new EmailSendError(
        `Could not reach the Resend API: ${(error as Error).message}`,
        error,
      );
    }

    const body = await response.json().catch(() => null);

    if (!response.ok) {
      const message =
        (body as { message?: string } | null)?.message ?? `Resend responded ${response.status}`;
      this.logger.warn(`Resend send failed (${response.status}): ${message}`);
      throw new EmailSendError(message);
    }

    const id = (body as { id?: string } | null)?.id;
    if (!id) {
      throw new EmailSendError('Resend accepted the request but returned no message id.');
    }
    return { providerMessageId: id };
  }
}

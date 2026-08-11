/**
 * Resend transport (https://resend.com).
 *
 * Chosen for the free tier (3,000 emails/month, 100/day at the time of writing) and a
 * single JSON POST with no SMTP setup. Nothing provider-specific leaks past this file —
 * `EmailService` and everything upstream of it only know `EmailTransport`.
 */

import { Logger } from '@nestjs/common';
import type { EmailSendResult, EmailTransport, OutboundEmail } from './email.types';
import { EmailSendError } from './email.types';

export const RESEND_API_URL = 'https://api.resend.com/emails';

/** Shape of Resend's error body. Both fields are absent on some 5xx responses. */
interface ResendError {
  name?: string;
  message?: string;
  statusCode?: number;
}

/**
 * Provider failures a mentor can actually act on, restated in their terms.
 *
 * Anything not listed falls back to the generic "verify the email configuration",
 * because unrecognised provider text may quote the request back — including headers.
 * Matching is on Resend's stable `name` field, not on message prose.
 */
function safeMessageFor(code: string | null, status: number | null): string | undefined {
  switch (code) {
    case 'validation_error':
      // Overwhelmingly the unverified-domain case, which is the single most common
      // first-run failure and completely opaque as a bare 4xx.
      return 'Sender email is not verified. Verify the sending domain with the email provider, or use an address on a verified domain.';
    case 'missing_api_key':
    case 'invalid_api_key':
    case 'restricted_api_key':
      return 'Email could not be sent — the email provider rejected the API key. Check EMAIL_API_KEY on the server.';
    case 'daily_quota_exceeded':
    case 'rate_limit_exceeded':
      return 'Email could not be sent — the provider’s sending limit has been reached. Try again later.';
    case 'invalid_from_address':
      return 'Sender email is not valid. Check the "From" address.';
    case 'invalid_to_address':
      return 'One or more recipient addresses were rejected by the provider. Check the To and CC lists.';
    default:
      break;
  }

  if (status === 401 || status === 403) {
    return 'Email could not be sent — the email provider rejected the API key. Check EMAIL_API_KEY on the server.';
  }
  if (status === 429) {
    return 'Email could not be sent — the provider’s sending limit has been reached. Try again later.';
  }
  if (status !== null && status >= 500) {
    return 'Email could not be sent — the email provider is currently unavailable. Try again shortly.';
  }
  return undefined;
}

export class ResendTransport implements EmailTransport {
  readonly provider = 'resend';
  private readonly logger = new Logger(ResendTransport.name);

  private readonly endpoint: string;

  constructor(
    private readonly apiKey: string,
    endpoint?: string | null,
  ) {
    this.endpoint = endpoint || RESEND_API_URL;
  }

  async send(email: OutboundEmail): Promise<EmailSendResult> {
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
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
      // Network-level: DNS, TLS, timeout. Never reached the provider at all.
      throw new EmailSendError(`Could not reach the Resend API: ${(error as Error).message}`, {
        detail: {
          provider: this.provider,
          httpStatus: null,
          providerCode: 'network_error',
          providerMessage: (error as Error).message,
        },
        safeMessage:
          'Email could not be sent — the email provider could not be reached. Check the server’s network access and try again.',
        cause: error,
      });
    }

    const body = (await response.json().catch(() => null)) as ResendError & { id?: string } | null;

    if (!response.ok) {
      const providerCode = body?.name ?? null;
      const providerMessage = body?.message ?? null;

      throw new EmailSendError(
        providerMessage ?? `Resend responded ${response.status}`,
        {
          detail: {
            provider: this.provider,
            httpStatus: response.status,
            providerCode,
            providerMessage,
          },
          safeMessage: safeMessageFor(providerCode, response.status),
        },
      );
    }

    const id = body?.id;
    if (!id) {
      // A 2xx with no id means we cannot prove the message was accepted, so this must
      // not be recorded as SENT.
      throw new EmailSendError('Resend accepted the request but returned no message id.', {
        detail: {
          provider: this.provider,
          httpStatus: response.status,
          providerCode: 'missing_message_id',
          providerMessage: null,
        },
      });
    }

    this.logger.log(`Resend accepted message ${id}`);
    return { providerMessageId: id };
  }
}

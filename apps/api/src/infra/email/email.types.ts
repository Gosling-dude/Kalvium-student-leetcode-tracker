/**
 * Transport abstraction for outbound email.
 *
 * The daily-report feature (and anything else that later wants to send mail) talks
 * only to `EmailService`, never to a provider SDK directly. Swapping providers means
 * writing one class that implements `EmailTransport` and wiring it in `email.module.ts`
 * — nothing in `modules/email-reports` changes.
 */

export interface OutboundEmail {
  fromEmail: string;
  toRecipients: string[];
  ccRecipients?: string[];
  subject: string;
  html: string;
}

export interface EmailSendResult {
  /** Provider-assigned id for the send, stored for support/troubleshooting. */
  providerMessageId: string;
}

export interface EmailTransport {
  readonly provider: string;
  send(email: OutboundEmail): Promise<EmailSendResult>;
}

/**
 * Thrown by `EmailService.sendEmail` when no provider is configured. Distinct from a
 * provider-side failure: previews, drafts and approvals all work with no provider
 * configured — only the actual send is refused, and with a message that says why.
 */
export class EmailProviderNotConfiguredError extends Error {
  constructor() {
    super(
      'No email provider is configured. Set EMAIL_PROVIDER, EMAIL_API_KEY and EMAIL_FROM ' +
        'to enable sending — see docs/DAILY_EMAIL_REPORTING.md.',
    );
    this.name = 'EmailProviderNotConfiguredError';
  }
}

/** A configured provider rejected or failed to send the message. */
export class EmailSendError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'EmailSendError';
  }
}

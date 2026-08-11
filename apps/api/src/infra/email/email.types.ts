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
 * Everything an email failure needs to be *actionable*, split by audience.
 *
 * `safeMessage` is written for the mentor staring at the UI and is the only part that
 * crosses the HTTP boundary; `providerMessage` and the rest go to the server log. The
 * split exists because provider errors sometimes quote the offending request back, and
 * an API key must never reach a browser or a database column.
 */
export interface EmailFailureDetail {
  provider: string;
  /** HTTP status the provider replied with, when the failure was an HTTP response. */
  httpStatus: number | null;
  /** Provider's machine-readable error name, e.g. `validation_error`. */
  providerCode: string | null;
  /** Provider's raw message. Server-side only. */
  providerMessage: string | null;
}

/**
 * Thrown by `EmailService.sendEmail` when no provider is configured. Distinct from a
 * provider-side failure: previews, drafts and approvals all work with no provider
 * configured — only the actual send is refused, and with a message that says why.
 */
export class EmailProviderNotConfiguredError extends Error {
  /** Shown to the user. Names the fix without naming any secret's value. */
  readonly safeMessage =
    'Email could not be sent — no email provider is configured. ' +
    'Set EMAIL_PROVIDER, EMAIL_API_KEY and EMAIL_FROM on the server, then try again.';

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
  readonly detail: EmailFailureDetail;
  /** User-facing text. Specific when the provider's reason is safe to repeat. */
  readonly safeMessage: string;

  constructor(
    message: string,
    options: {
      detail: EmailFailureDetail;
      safeMessage?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'EmailSendError';
    this.detail = options.detail;
    this.safeMessage =
      options.safeMessage ?? 'Email could not be sent. Please verify the email configuration.';
    this.cause = options.cause;
  }
}

/** True for errors whose `safeMessage` is fit to return to a client. */
export function isEmailError(
  error: unknown,
): error is EmailSendError | EmailProviderNotConfiguredError {
  return error instanceof EmailSendError || error instanceof EmailProviderNotConfiguredError;
}

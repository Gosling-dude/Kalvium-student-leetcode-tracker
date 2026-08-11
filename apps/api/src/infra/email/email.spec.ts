/**
 * Outbound email failure handling.
 *
 * The defect these cover: every email failure — a missing provider, an unverified
 * sender domain, a rejected API key — surfaced as a bare HTTP 500 carrying
 * "An unexpected error occurred", so "Approve & Send" could only ever report
 * "Something went wrong". Each case below asserts both halves of the fix: the
 * diagnosis kept for the server log, and the specific message safe to show a mentor.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EmailService } from './email.service';
import { ResendTransport } from './resend.transport';
import {
  EmailProviderNotConfiguredError,
  EmailSendError,
  isEmailError,
} from './email.types';
import type { AppConfig } from '../../config/configuration';

const API_KEY = 're_live_SUPERSECRET_do_not_leak';

const EMAIL = {
  fromEmail: 'reports@kalvium.community',
  toRecipients: ['campus.manager@kalvium.community'],
  ccRecipients: ['program.head@kalvium.community'],
  subject: 'Daily DSA Report — 10 Aug',
  html: '<p>report</p>',
};

/** Minimal config double — `EmailService` only reads the `email` block. */
function configWith(email: Partial<AppConfig['email']>): AppConfig {
  return {
    email: {
      provider: 'none',
      apiKey: null,
      fromEmail: null,
      defaultTo: [],
      defaultCc: [],
      apiBaseUrl: null,
      ...email,
    },
  } as AppConfig;
}

/** Stub `fetch` with one canned provider response. */
function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('EmailService — configuration', () => {
  it('reports unconfigured when no provider is set', () => {
    const service = new EmailService(configWith({ provider: 'none' }));
    expect(service.isConfigured()).toBe(false);
    expect(service.configurationProblem()).toMatch(/EMAIL_PROVIDER/);
  });

  it('reports unconfigured when the provider is set but the key is missing', () => {
    const service = new EmailService(configWith({ provider: 'resend', apiKey: null }));
    expect(service.isConfigured()).toBe(false);
    expect(service.configurationProblem()).toMatch(/EMAIL_API_KEY/);
  });

  it('reports configured once both are present', () => {
    const service = new EmailService(configWith({ provider: 'resend', apiKey: API_KEY }));
    expect(service.isConfigured()).toBe(true);
    expect(service.configurationProblem()).toBeNull();
  });

  it('throws a typed, actionable error rather than a bare Error when unconfigured', async () => {
    const service = new EmailService(configWith({ provider: 'none' }));
    await expect(service.sendEmail(EMAIL)).rejects.toBeInstanceOf(
      EmailProviderNotConfiguredError,
    );

    const error = await service.sendEmail(EMAIL).catch((e: unknown) => e);
    expect(isEmailError(error)).toBe(true);
    // Names the fix, and names no secret's value.
    expect((error as EmailProviderNotConfiguredError).safeMessage).toContain('EMAIL_PROVIDER');
    expect((error as EmailProviderNotConfiguredError).safeMessage).not.toContain(API_KEY);
  });

  it('refuses to send with no recipients instead of asking the provider to', async () => {
    stubFetch(200, { id: 'should-not-be-called' });
    const service = new EmailService(configWith({ provider: 'resend', apiKey: API_KEY }));

    const error = await service
      .sendEmail({ ...EMAIL, toRecipients: [] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmailSendError);
    expect((error as EmailSendError).detail.providerCode).toBe('no_recipients');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('ResendTransport — success', () => {
  it('returns the provider message id and sends exactly what it was given', async () => {
    const spy = stubFetch(200, { id: 'msg_abc123' });
    const result = await new ResendTransport(API_KEY).send(EMAIL);

    expect(result.providerMessageId).toBe('msg_abc123');

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    const payload = JSON.parse(init.body as string);
    expect(payload).toMatchObject({
      from: EMAIL.fromEmail,
      to: EMAIL.toRecipients,
      cc: EMAIL.ccRecipients,
      subject: EMAIL.subject,
      // The approved body must go out byte-for-byte — this is what the preview showed.
      html: EMAIL.html,
    });
  });

  it('omits cc entirely rather than sending an empty array', async () => {
    const spy = stubFetch(200, { id: 'msg_1' });
    await new ResendTransport(API_KEY).send({ ...EMAIL, ccRecipients: [] });
    const payload = JSON.parse((spy.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(payload.cc).toBeUndefined();
  });

  it('honours an endpoint override so the real path can be tested against a stub', async () => {
    const spy = stubFetch(200, { id: 'msg_1' });
    await new ResendTransport(API_KEY, 'http://localhost:4999/emails').send(EMAIL);
    expect((spy.mock.calls[0] as [string])[0]).toBe('http://localhost:4999/emails');
  });

  it('refuses to claim success when the provider returns no message id', async () => {
    stubFetch(200, {});
    const error = await new ResendTransport(API_KEY).send(EMAIL).catch((e: unknown) => e);
    // Without an id we cannot prove delivery was accepted, so this must not be SENT.
    expect(error).toBeInstanceOf(EmailSendError);
    expect((error as EmailSendError).detail.providerCode).toBe('missing_message_id');
  });
});

describe('ResendTransport — provider failures map to specific, safe messages', () => {
  it.each([
    [
      403,
      { name: 'validation_error', message: 'The kalvium.community domain is not verified.' },
      /Sender email is not verified/i,
    ],
    [401, { name: 'invalid_api_key', message: 'API key is invalid' }, /rejected the API key/i],
    [
      429,
      { name: 'daily_quota_exceeded', message: 'quota reached' },
      /sending limit has been reached/i,
    ],
    [500, { name: 'internal_server_error', message: 'oops' }, /currently unavailable/i],
    [
      400,
      { name: 'invalid_to_address', message: 'bad recipient' },
      /recipient addresses were rejected/i,
    ],
  ])('maps HTTP %i to a message a mentor can act on', async (status, body, expected) => {
    stubFetch(status, body);
    const error = (await new ResendTransport(API_KEY)
      .send(EMAIL)
      .catch((e: unknown) => e)) as EmailSendError;

    expect(error).toBeInstanceOf(EmailSendError);
    expect(error.safeMessage).toMatch(expected);
    expect(error.safeMessage).not.toMatch(/something went wrong/i);
  });

  it('records provider, status and code for the server log', async () => {
    stubFetch(403, { name: 'validation_error', message: 'domain is not verified' });
    const error = (await new ResendTransport(API_KEY)
      .send(EMAIL)
      .catch((e: unknown) => e)) as EmailSendError;

    expect(error.detail).toEqual({
      provider: 'resend',
      httpStatus: 403,
      providerCode: 'validation_error',
      providerMessage: 'domain is not verified',
    });
  });

  it('falls back to a generic safe message for an unrecognised 4xx', async () => {
    stubFetch(422, { name: 'some_new_error_code', message: 'internal detail' });
    const error = (await new ResendTransport(API_KEY)
      .send(EMAIL)
      .catch((e: unknown) => e)) as EmailSendError;

    // Unrecognised provider prose is not repeated to the client — it can quote the
    // request back, headers included.
    expect(error.safeMessage).toBe(
      'Email could not be sent. Please verify the email configuration.',
    );
    expect(error.detail.providerCode).toBe('some_new_error_code');
  });

  it('survives a non-JSON error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 })),
    );
    const error = (await new ResendTransport(API_KEY)
      .send(EMAIL)
      .catch((e: unknown) => e)) as EmailSendError;

    expect(error).toBeInstanceOf(EmailSendError);
    expect(error.detail.httpStatus).toBe(502);
    expect(error.safeMessage).toMatch(/currently unavailable/i);
  });

  it('reports a network failure as unreachable, not as a rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND api.resend.com');
      }),
    );
    const error = (await new ResendTransport(API_KEY)
      .send(EMAIL)
      .catch((e: unknown) => e)) as EmailSendError;

    expect(error.detail.providerCode).toBe('network_error');
    expect(error.detail.httpStatus).toBeNull();
    expect(error.safeMessage).toMatch(/could not be reached/i);
  });

  it('never leaks the API key into any client-facing text', async () => {
    // The provider echoing our own Authorization header back is the realistic worry.
    stubFetch(400, {
      name: 'validation_error',
      message: `Request failed with Authorization: Bearer ${API_KEY}`,
    });
    const error = (await new ResendTransport(API_KEY)
      .send(EMAIL)
      .catch((e: unknown) => e)) as EmailSendError;

    expect(error.safeMessage).not.toContain(API_KEY);
    expect(error.safeMessage).not.toContain('Bearer');
  });
});

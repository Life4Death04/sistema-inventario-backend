/**
 * Twilio client factory — lazy singleton.
 *
 * The client is created on first access so the application boots without
 * requiring Twilio credentials. Missing env vars at send-time surface as a
 * runtime error (INTERNAL_ERROR 500) via the caller's error handling.
 *
 * Usage:
 *   import { getTwilioClient } from './twilio-client.js';
 *   const client = getTwilioClient();
 *   await client.messages.create({ ... });
 */
import twilio from 'twilio';
import { env } from '../../config/env.js';

let _client: ReturnType<typeof twilio> | null = null;

/**
 * Returns the shared Twilio client, creating it on first call.
 * Throws if TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN are not set.
 */
export function getTwilioClient(): ReturnType<typeof twilio> {
  if (_client) return _client;

  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;

  if (!sid || !token) {
    throw new Error(
      'Twilio credentials are not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.',
    );
  }

  _client = twilio(sid, token);
  return _client;
}

/**
 * Reset the client singleton — used in tests to ensure a fresh client
 * after overriding env vars.
 * @internal
 */
export function _resetTwilioClient(): void {
  _client = null;
}

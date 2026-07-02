/**
 * Public API for the notifications module.
 *
 * Exports:
 *   notificationService          — singleton implementation (Twilio in prod)
 *   __setNotificationService()   — DI override for tests
 *   normalizeE164()              — E.164 normalization / validation helper
 *   buildSentTemplate()          — SENT WhatsApp message body builder
 *   buildCancelledTemplate()     — CANCELLED WhatsApp message body builder
 */
export {
  notificationService,
  __setNotificationService,
  type NotificationService,
} from './notifications.service.js';

export { normalizeE164 } from './normalizeE164.js';

export { buildSentTemplate, buildCancelledTemplate } from './templates.js';

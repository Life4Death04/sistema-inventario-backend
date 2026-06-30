/**
 * Pino logger instance — application-wide structured logging.
 *
 * Configuration:
 * - Level sourced from env.LOG_LEVEL (validated at boot by config/env.ts).
 * - Sensitive fields are redacted from all log output.
 * - Development: pretty-printed with colors via pino-pretty transport.
 * - Production: raw JSON for log aggregation pipelines.
 */
import pino from 'pino';
import { env } from '../../config/env.js';

const isDevelopment = env.NODE_ENV !== 'production';

const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', 'req.body.password', 'req.cookies.refresh_token'],
    censor: '[REDACTED]',
  },
  ...(isDevelopment && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
      },
    },
  }),
});

export default logger;

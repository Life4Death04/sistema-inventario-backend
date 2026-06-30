/**
 * Express Request type augmentation.
 *
 * Extends the Express Request interface to include the `user` property
 * populated by the `authenticate` middleware after JWT verification.
 *
 * Using declaration merging (not module overriding) so that this file works
 * alongside @types/express without conflicts.
 */
import type { UserRole } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      /**
       * Populated by `authenticate` middleware after successful JWT verification.
       * Contains only the claims embedded in the access token — not a full DB read.
       * Undefined on unauthenticated routes.
       */
      user?: {
        id: string;
        role: UserRole;
      };
    }
  }
}

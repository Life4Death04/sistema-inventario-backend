/**
 * Products router — mounts product CRUD and product-supplier link endpoints.
 */
import {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from 'express';
import { validate } from '../../shared/validation/validate.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { requireRole } from '../../shared/middleware/requireRole.js';
import { AppError } from '../../shared/errors/AppError.js';
import { ERROR_CODES } from '../../shared/errors/errorCodes.js';
import {
  attachSupplierSchema,
  createProductSchema,
  listProductsQuerySchema,
  productIdParamsSchema,
  productSupplierParamsSchema,
  updateProductSchema,
} from './products.schema.js';
import {
  attachProductSupplierController,
  createProductController,
  deleteProductController,
  detachProductSupplierController,
  getProductController,
  listProductsController,
  listProductSuppliersController,
  updateProductController,
} from './products.controller.js';
import { listMovementsByProductController } from '../inventory-movements/inventory-movements.controller.js';
import {
  listMovementsByProductQuerySchema,
  movementProductIdParamsSchema,
} from '../inventory-movements/inventory-movements.schema.js';

export const productsRouter = Router();

const MUTATION_ROLES = ['ADMIN', 'MANAGER'] as const;
const READ_ROLES = ['ADMIN', 'MANAGER', 'OPERATOR'] as const;

function rejectStockPatch(req: Request, _res: Response, next: NextFunction): void {
  const body = req.body as unknown;
  if (
    typeof body === 'object' &&
    body !== null &&
    Object.prototype.hasOwnProperty.call(body, 'stock')
  ) {
    next(
      new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        400,
        'stock is only modifiable via /api/inventory-movements',
      ),
    );
    return;
  }

  next();
}

productsRouter.post(
  '/',
  authenticate,
  requireRole(...MUTATION_ROLES),
  validate(createProductSchema, 'body'),
  createProductController as RequestHandler,
);

productsRouter.get(
  '/',
  authenticate,
  requireRole(...READ_ROLES),
  validate(listProductsQuerySchema, 'query'),
  listProductsController as RequestHandler,
);

productsRouter.get(
  '/:id/suppliers',
  authenticate,
  requireRole(...READ_ROLES),
  validate(productIdParamsSchema, 'params'),
  listProductSuppliersController as RequestHandler,
);

productsRouter.post(
  '/:id/suppliers',
  authenticate,
  requireRole(...MUTATION_ROLES),
  validate(productIdParamsSchema, 'params'),
  validate(attachSupplierSchema, 'body'),
  attachProductSupplierController as RequestHandler,
);

productsRouter.delete(
  '/:id/suppliers/:supplierId',
  authenticate,
  requireRole(...MUTATION_ROLES),
  validate(productSupplierParamsSchema, 'params'),
  detachProductSupplierController as RequestHandler,
);

// ── GET /api/products/:productId/inventory-movements ─────────────────────
//
// Sub-resource: movement history for a specific product (design D5).
// Registered before /:id to ensure the more-specific path is matched first.

productsRouter.get(
  '/:productId/inventory-movements',
  authenticate,
  requireRole(...READ_ROLES),
  validate(movementProductIdParamsSchema, 'params'),
  validate(listMovementsByProductQuerySchema, 'query'),
  listMovementsByProductController as RequestHandler,
);

productsRouter.get(
  '/:id',
  authenticate,
  requireRole(...READ_ROLES),
  validate(productIdParamsSchema, 'params'),
  getProductController as RequestHandler,
);

productsRouter.patch(
  '/:id',
  authenticate,
  requireRole(...MUTATION_ROLES),
  validate(productIdParamsSchema, 'params'),
  rejectStockPatch,
  validate(updateProductSchema, 'body'),
  updateProductController as RequestHandler,
);

productsRouter.delete(
  '/:id',
  authenticate,
  requireRole(...MUTATION_ROLES),
  validate(productIdParamsSchema, 'params'),
  deleteProductController as RequestHandler,
);

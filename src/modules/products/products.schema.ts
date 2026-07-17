/**
 * Zod schemas and inferred types for the products module.
 *
 * Schemas:
 *   - createProductSchema           body for POST /api/products
 *   - updateProductSchema           body for PATCH /api/products/:id
 *   - productIdParamsSchema         params for /:id routes
 *   - productSupplierParamsSchema   params for /:id/suppliers/:supplierId
 *   - listProductsQuerySchema       query for GET /api/products
 *   - attachSupplierSchema          body for POST /api/products/:id/suppliers
 */
import { z } from 'zod';
import { ProductUnit } from '@prisma/client';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRODUCT_CODE_MAX_LENGTH = 60;
const PRODUCT_NAME_MIN_LENGTH = 2;
const PRODUCT_NAME_MAX_LENGTH = 200;
const PRODUCT_ACTIVE_INGREDIENT_MAX_LENGTH = 200;
const PRODUCT_PRESENTATION_MAX_LENGTH = 100;
const PRODUCT_BRAND_MAX_LENGTH = 120;
const PRODUCT_DESCRIPTION_MAX_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Reusable field schemas
// ---------------------------------------------------------------------------

/**
 * unitContent: required, > 0, up to 3 decimal places.
 * Accepts string or number input; validates that it is a positive number
 * with at most 3 decimal places and converts it to a string representation
 * safe for Prisma Decimal.
 */
const unitContentSchema = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine(
    (v) => {
      const n = Number(v);
      return !isNaN(n);
    },
    { message: 'unitContent must be a valid number.' },
  )
  .refine(
    (v) => {
      const n = Number(v);
      return n > 0;
    },
    { message: 'unitContent must be greater than 0.' },
  )
  .refine(
    (v) => {
      // Allow up to 3 decimal places.
      return /^\d+(\.\d{1,3})?$/.test(v);
    },
    { message: 'unitContent must have at most 3 decimal places.' },
  );

/**
 * price: Decimal >= 0, up to 2 decimal places.
 * Accepts string or number input.
 */
const priceSchema = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine(
    (v) => {
      const n = Number(v);
      return !isNaN(n);
    },
    { message: 'price must be a valid number.' },
  )
  .refine(
    (v) => {
      const n = Number(v);
      return n >= 0;
    },
    { message: 'price must be >= 0.' },
  )
  .refine(
    (v) => {
      // Allow up to 2 decimal places.
      return /^\d+(\.\d{1,2})?$/.test(v);
    },
    { message: 'price must have at most 2 decimal places.' },
  );

/**
 * referencePrice: Decimal(12,2), optional, >= 0.
 * Accepts string or number; null is allowed (omit referencePrice).
 */
const referencePriceSchema = z
  .union([z.string(), z.number()])
  .transform((v) => String(v))
  .refine(
    (v) => {
      const n = Number(v);
      return !isNaN(n);
    },
    { message: 'referencePrice must be a valid number.' },
  )
  .refine(
    (v) => {
      const n = Number(v);
      return n >= 0;
    },
    { message: 'referencePrice must be >= 0.' },
  )
  .refine(
    (v) => {
      return /^\d+(\.\d{1,2})?$/.test(v);
    },
    { message: 'referencePrice must have at most 2 decimal places.' },
  )
  .nullable()
  .optional();

// ---------------------------------------------------------------------------
// Body schemas
// ---------------------------------------------------------------------------

/**
 * Schema for POST /api/products body.
 * code, name, unit, unitContent, categoryId, price are required.
 * stock, minStock default to 0.
 * Optional: activeIngredient, presentation, brand, description.
 */
export const createProductSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, { message: 'code must be at least 1 character.' })
    .max(PRODUCT_CODE_MAX_LENGTH, {
      message: `code must be at most ${PRODUCT_CODE_MAX_LENGTH} characters.`,
    }),

  name: z
    .string()
    .trim()
    .min(PRODUCT_NAME_MIN_LENGTH, { message: 'name must be at least 2 characters.' })
    .max(PRODUCT_NAME_MAX_LENGTH, {
      message: `name must be at most ${PRODUCT_NAME_MAX_LENGTH} characters.`,
    }),

  activeIngredient: z
    .string()
    .trim()
    .max(PRODUCT_ACTIVE_INGREDIENT_MAX_LENGTH, {
      message: `activeIngredient must be at most ${PRODUCT_ACTIVE_INGREDIENT_MAX_LENGTH} characters.`,
    })
    .optional(),

  presentation: z
    .string()
    .trim()
    .max(PRODUCT_PRESENTATION_MAX_LENGTH, {
      message: `presentation must be at most ${PRODUCT_PRESENTATION_MAX_LENGTH} characters.`,
    })
    .optional(),

  brand: z
    .string()
    .trim()
    .max(PRODUCT_BRAND_MAX_LENGTH, {
      message: `brand must be at most ${PRODUCT_BRAND_MAX_LENGTH} characters.`,
    })
    .optional(),

  description: z
    .string()
    .trim()
    .max(PRODUCT_DESCRIPTION_MAX_LENGTH, {
      message: `description must be at most ${PRODUCT_DESCRIPTION_MAX_LENGTH} characters.`,
    })
    .optional(),

  unit: z.nativeEnum(ProductUnit, {
    errorMap: () => ({ message: `unit must be one of: ${Object.values(ProductUnit).join(', ')}.` }),
  }),

  unitContent: unitContentSchema,

  categoryId: z.string().cuid({ message: 'categoryId must be a valid cuid.' }),

  stock: z
    .number()
    .int({ message: 'stock must be an integer.' })
    .min(0, { message: 'stock must be >= 0.' })
    .default(0),

  minStock: z
    .number()
    .int({ message: 'minStock must be an integer.' })
    .min(0, { message: 'minStock must be >= 0.' })
    .default(0),

  price: z.union([priceSchema, z.null()]).optional(),
});

/**
 * Schema for PATCH /api/products/:id body.
 * All fields optional — at least 1 key required.
 * stock is explicitly FORBIDDEN — returns 400 with specific message.
 * activeIngredient, description, presentation, brand can be explicitly set to null to clear them.
 */
export const updateProductSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(1, { message: 'code must be at least 1 character.' })
      .max(PRODUCT_CODE_MAX_LENGTH, {
        message: `code must be at most ${PRODUCT_CODE_MAX_LENGTH} characters.`,
      })
      .optional(),

    name: z
      .string()
      .trim()
      .min(PRODUCT_NAME_MIN_LENGTH, { message: 'name must be at least 2 characters.' })
      .max(PRODUCT_NAME_MAX_LENGTH, {
        message: `name must be at most ${PRODUCT_NAME_MAX_LENGTH} characters.`,
      })
      .optional(),

    activeIngredient: z
      .string()
      .trim()
      .max(PRODUCT_ACTIVE_INGREDIENT_MAX_LENGTH, {
        message: `activeIngredient must be at most ${PRODUCT_ACTIVE_INGREDIENT_MAX_LENGTH} characters.`,
      })
      .nullable()
      .optional(),

    presentation: z
      .string()
      .trim()
      .max(PRODUCT_PRESENTATION_MAX_LENGTH, {
        message: `presentation must be at most ${PRODUCT_PRESENTATION_MAX_LENGTH} characters.`,
      })
      .nullable()
      .optional(),

    brand: z
      .string()
      .trim()
      .max(PRODUCT_BRAND_MAX_LENGTH, {
        message: `brand must be at most ${PRODUCT_BRAND_MAX_LENGTH} characters.`,
      })
      .nullable()
      .optional(),

    description: z
      .string()
      .trim()
      .max(PRODUCT_DESCRIPTION_MAX_LENGTH, {
        message: `description must be at most ${PRODUCT_DESCRIPTION_MAX_LENGTH} characters.`,
      })
      .nullable()
      .optional(),

    unit: z
      .nativeEnum(ProductUnit, {
        errorMap: () => ({
          message: `unit must be one of: ${Object.values(ProductUnit).join(', ')}.`,
        }),
      })
      .optional(),

    unitContent: unitContentSchema.optional(),

    categoryId: z.string().cuid({ message: 'categoryId must be a valid cuid.' }).optional(),

    minStock: z
      .number()
      .int({ message: 'minStock must be an integer.' })
      .min(0, { message: 'minStock must be >= 0.' })
      .optional(),

    price: z.union([priceSchema, z.null()]).optional(),

    // stock is NOT allowed on PATCH — the service guard catches it, but we
    // also reject it at the schema level so the controller never sees it.
    stock: z
      .never({ invalid_type_error: 'stock is only modifiable via /api/inventory-movements' })
      .optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update.',
  });

// ---------------------------------------------------------------------------
// Params schemas
// ---------------------------------------------------------------------------

/** Schema for :id route param — must be a valid cuid. */
export const productIdParamsSchema = z.object({
  id: z.string().cuid({ message: 'Product id must be a valid cuid.' }),
});

/** Schema for /:id/suppliers/:supplierId route params. */
export const productSupplierParamsSchema = z.object({
  id: z.string().cuid({ message: 'Product id must be a valid cuid.' }),
  supplierId: z.string().cuid({ message: 'Supplier id must be a valid cuid.' }),
});

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------

/**
 * Schema for GET /api/products query params.
 * Extends paginationQuerySchema with product-specific filters.
 *
 * active  — default true. Uses z.enum(['true','false']).transform(...).
 *           NEVER z.coerce.boolean() — Boolean("false") === true (bug in suppliers).
 * lowStock — when true, filters stock <= minStock.
 */
export const listProductsQuerySchema = z.object({
  page: z.coerce
    .number({ invalid_type_error: 'page must be a number' })
    .int('page must be an integer')
    .min(1, 'page must be at least 1')
    .default(1),

  pageSize: z.coerce
    .number({ invalid_type_error: 'pageSize must be a number' })
    .int('pageSize must be an integer')
    .min(1, 'pageSize must be at least 1')
    .max(100, 'pageSize must be at most 100')
    .default(20),

  search: z.string().max(200).optional(),

  categoryId: z.string().cuid({ message: 'categoryId must be a valid cuid.' }).optional(),

  /**
   * Filter by active status.
   * z.enum(['true','false']).transform ensures "false" maps to false, not true.
   * Boolean("false") === true — z.coerce.boolean() CANNOT be used here.
   */
  active: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /**
   * When true, filters products where stock <= minStock.
   * Same boolean gotcha — must use enum transform.
   */
  lowStock: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  supplierId: z.string().cuid({ message: 'supplierId must be a valid cuid.' }).optional(),

  orderBy: z
    .enum(['name', 'stock', 'price', 'createdAt'], {
      errorMap: () => ({ message: 'orderBy must be one of: name, stock, price, createdAt.' }),
    })
    .default('createdAt'),

  order: z
    .enum(['asc', 'desc'], {
      errorMap: () => ({ message: 'order must be asc or desc.' }),
    })
    .default('desc'),
});

// ---------------------------------------------------------------------------
// Sub-resource schemas
// ---------------------------------------------------------------------------

/**
 * Schema for POST /api/products/:id/suppliers body.
 * supplierId is required; referencePrice is optional.
 */
export const attachSupplierSchema = z.object({
  supplierId: z.string().cuid({ message: 'supplierId must be a valid cuid.' }),
  referencePrice: referencePriceSchema,
});

// ---------------------------------------------------------------------------
// Inferred DTO types
// ---------------------------------------------------------------------------

export type CreateProductDto = z.infer<typeof createProductSchema>;
export type UpdateProductDto = z.infer<typeof updateProductSchema>;
export type ProductIdParams = z.infer<typeof productIdParamsSchema>;
export type ProductSupplierParams = z.infer<typeof productSupplierParamsSchema>;
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;
export type AttachSupplierDto = z.infer<typeof attachSupplierSchema>;

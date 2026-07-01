/**
 * Zod schemas and inferred types for the suppliers module.
 *
 * Schemas:
 *   - createSupplierSchema      body for POST /api/suppliers
 *   - updateSupplierSchema      body for PATCH /api/suppliers/:id
 *   - supplierIdParamsSchema    params for /:id routes
 *   - listSuppliersQuerySchema  query for GET /api/suppliers (extends paginationQuerySchema)
 */
import { z } from 'zod';
import { paginationQuerySchema } from '../../shared/pagination/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUPPLIER_NAME_MIN_LENGTH = 2;
const SUPPLIER_NAME_MAX_LENGTH = 120;
const SUPPLIER_ADDRESS_MAX_LENGTH = 255;

// ---------------------------------------------------------------------------
// Reusable field schemas
// ---------------------------------------------------------------------------

const supplierNameSchema = z
  .string()
  .min(SUPPLIER_NAME_MIN_LENGTH, { message: 'Supplier name must be at least 2 characters.' })
  .max(SUPPLIER_NAME_MAX_LENGTH, { message: 'Supplier name must be at most 120 characters.' })
  .trim();

/**
 * RIF field: optional. Empty string is normalized to null.
 * Non-empty must be a non-empty trimmed string.
 * Null RIFs do NOT collide (Postgres allows multiple NULLs on UNIQUE columns).
 */
const supplierRifSchema = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();

/**
 * WhatsApp field: optional; if provided, simple international format +?\d{8,15}.
 * Normalized by trimming and stripping spaces/dashes.
 */
const supplierWhatsappSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .refine((v) => /^\+?\d{8,15}$/.test(v), {
    message: 'WhatsApp must be a valid international number (8–15 digits, optional leading +).',
  })
  .nullable()
  .optional();

/** Address: optional; if provided, max 255 chars, trimmed. */
const supplierAddressSchema = z
  .string()
  .trim()
  .max(SUPPLIER_ADDRESS_MAX_LENGTH, { message: 'Address must be at most 255 characters.' })
  .nullable()
  .optional();

// ---------------------------------------------------------------------------
// Body schemas
// ---------------------------------------------------------------------------

/**
 * Schema for POST /api/suppliers body.
 * name is required; rif, whatsapp, address are optional.
 */
export const createSupplierSchema = z.object({
  name: supplierNameSchema,
  rif: supplierRifSchema,
  whatsapp: supplierWhatsappSchema,
  address: supplierAddressSchema,
});

/**
 * Schema for PATCH /api/suppliers/:id body.
 * All fields optional — reject empty objects (at least 1 key required).
 * rif, whatsapp, address can be explicitly set to null to clear them.
 */
export const updateSupplierSchema = z
  .object({
    name: supplierNameSchema.optional(),
    rif: supplierRifSchema,
    whatsapp: supplierWhatsappSchema,
    address: supplierAddressSchema,
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update.',
  });

// ---------------------------------------------------------------------------
// Params schema
// ---------------------------------------------------------------------------

/** Schema for :id route param — must be a valid cuid. */
export const supplierIdParamsSchema = z.object({
  id: z.string().cuid({ message: 'Supplier id must be a valid cuid.' }),
});

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------

/**
 * Schema for GET /api/suppliers query params.
 * Extends paginationQuerySchema with supplier-specific filters.
 *   active  — filter by active status (default: true)
 *   search  — case-insensitive substring match on name OR rif
 */
export const listSuppliersQuerySchema = paginationQuerySchema.extend({
  search: z.string().max(200).optional(),
  /**
   * Filter by active status.
   * Query strings "true"/"false" are explicitly mapped to booleans.
   * z.coerce.boolean() cannot be used here because Boolean("false") === true.
   */
  active: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

// ---------------------------------------------------------------------------
// Inferred DTO types
// ---------------------------------------------------------------------------

export type CreateSupplierDto = z.infer<typeof createSupplierSchema>;
export type UpdateSupplierDto = z.infer<typeof updateSupplierSchema>;
export type SupplierIdParams = z.infer<typeof supplierIdParamsSchema>;
export type ListSuppliersQuery = z.infer<typeof listSuppliersQuerySchema>;

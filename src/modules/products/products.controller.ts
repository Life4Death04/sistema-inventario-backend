/**
 * Products controller — HTTP handlers for product CRUD and supplier links.
 */
import type { Request, Response } from 'express';
import { productsService } from './products.service.js';
import type {
  AttachSupplierDto,
  CreateProductDto,
  ListProductsQuery,
  ProductIdParams,
  ProductSupplierParams,
  UpdateProductDto,
} from './products.schema.js';

// ── POST /api/products ───────────────────────────────────────────────────────

export async function createProductController(req: Request, res: Response): Promise<void> {
  const dto = req.body as CreateProductDto;
  const product = await productsService.create(dto);
  res.status(201).json({ product });
}

// ── GET /api/products ────────────────────────────────────────────────────────

export async function listProductsController(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListProductsQuery;
  const result = await productsService.list(query);
  res.status(200).json(result);
}

// ── GET /api/products/:id ────────────────────────────────────────────────────

export async function getProductController(req: Request, res: Response): Promise<void> {
  const { id } = req.params as ProductIdParams;
  const product = await productsService.getById(id);
  res.status(200).json({ product });
}

// ── PATCH /api/products/:id ──────────────────────────────────────────────────

export async function updateProductController(req: Request, res: Response): Promise<void> {
  const { id } = req.params as ProductIdParams;
  const dto = req.body as UpdateProductDto;
  const product = await productsService.update(id, dto);
  res.status(200).json({ product });
}

// ── DELETE /api/products/:id ─────────────────────────────────────────────────

export async function deleteProductController(req: Request, res: Response): Promise<void> {
  const { id } = req.params as ProductIdParams;
  await productsService.softDelete(id);
  res.status(204).end();
}

// ── GET /api/products/:id/suppliers ──────────────────────────────────────────

export async function listProductSuppliersController(req: Request, res: Response): Promise<void> {
  const { id } = req.params as ProductIdParams;
  const suppliers = await productsService.listSuppliers(id);
  res.status(200).json({ suppliers });
}

// ── POST /api/products/:id/suppliers ─────────────────────────────────────────

export async function attachProductSupplierController(req: Request, res: Response): Promise<void> {
  const { id } = req.params as ProductIdParams;
  const dto = req.body as AttachSupplierDto;
  const link = await productsService.attachSupplier(id, dto);
  res.status(201).json({ link });
}

// ── DELETE /api/products/:id/suppliers/:supplierId ───────────────────────────

export async function detachProductSupplierController(req: Request, res: Response): Promise<void> {
  const { id, supplierId } = req.params as ProductSupplierParams;
  await productsService.detachSupplier(id, supplierId);
  res.status(204).end();
}

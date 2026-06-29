# SDD Agent Instructions — sistema-inventario-backend

> This file is read by all SDD agents operating on this project.
> Updated by: sdd-init | 2026-06-29

## Project Identity

**Name**: sistema-inventario-backend  
**Type**: Greenfield Node.js/TypeScript REST API  
**Domain**: Pharmacy inventory management (HighMeds, Maturín, Venezuela)  
**Companion frontend**: `../sistema-inventario-frontend` (React 18 + Vite + TanStack Query)

## Critical Context

- The frontend currently runs entirely on **mock data** (`src/data/mockDatabase.ts`).  
  This backend is the real implementation that will replace that mock layer.
- API base URL consumed by frontend: `/api`
- Auth is localStorage-based in the mock (Zustand store). Backend must implement **JWT**.
- Frontend types live at `../sistema-inventario-frontend/src/types/common.types.ts` —  
  the backend API **must match those shapes exactly** (field names, types, enums).
- Stack is **not yet chosen**. Do not assume a framework until sdd-propose completes.

## Domain Model (from frontend types)

```
UserRole: ADMIN | MANAGER | OPERATOR
MovementType: IN | OUT | ADJUSTMENT
ReplenishmentStatus: PENDING | SENT | RECEIVED | CANCELLED

Entities: User, Category, Supplier, Product, ProductSupplier (join),
          InventoryMovement, ReplenishmentRequest, ReplenishmentRequestItem
```

## SDD Phase Rules

| Phase   | Entry condition | Output |
|---------|----------------|--------|
| propose | Fresh start — **choose stack first** | proposal doc + stack decision |
| spec    | Stack chosen   | delta specs per resource |
| design  | Spec approved  | architecture + DB schema |
| tasks   | Design approved | implementation task list |
| apply   | Tasks ready    | working code + tests |
| verify  | Apply done     | test report + API contract proof |
| archive | Verify passed  | updated openspec/config.yaml testing section |

## Strict TDD

**Disabled** (greenfield — no test runner yet). Will be activated once the stack is chosen in propose phase.

## Skill Registry

See `.atl/skill-registry.md` for available skills.

## OpenSpec Layout

```
openspec/
├── config.yaml        — project config, stack, testing capabilities
├── AGENTS.md          — this file
├── specs/             — delta specs per change/feature
└── changes/
    └── archive/       — completed change archives
```

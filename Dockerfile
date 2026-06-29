# Multi-stage Dockerfile for sistema-inventario-backend
# Stage 1 (deps): install production dependencies only
# Stage 2 (build): compile TypeScript
# Stage 3 (runtime): minimal Node 20 Alpine image, non-root user

# ---- deps ----
FROM node:20-alpine AS deps
WORKDIR /app
# Copy manifests only to leverage Docker cache
COPY package*.json ./
RUN npm ci --omit=dev

# ---- build ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# Generate Prisma client and compile TypeScript
RUN npx prisma generate && npm run build

# ---- runtime ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy compiled output and production node_modules from previous stages
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package*.json ./

EXPOSE 3000

# Run as non-root for defence-in-depth (see design §Security baseline)
USER node

CMD ["node", "dist/index.js"]

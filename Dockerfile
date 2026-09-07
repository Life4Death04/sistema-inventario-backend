# Multi-stage Dockerfile for sistema-inventario-backend
# Base: Node 20 Alpine with the OpenSSL runtime required by Prisma
# Build: generate Prisma Client, compile TypeScript, and prune dev dependencies
# Runtime: minimal non-root image derived from the same OpenSSL base

# ---- base ----
FROM node:20-alpine AS base
RUN apk add --no-cache openssl

# ---- build ----
FROM base AS build
WORKDIR /app
COPY package*.json ./
RUN HUSKY=0 npm ci
COPY . .
# Preserve the generated client while removing build-only dependencies.
RUN npx prisma generate \
    && npm run build \
    && npm prune --omit=dev --ignore-scripts

# ---- runtime ----
FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Copy compiled output and its generated, production-only dependency tree.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package*.json ./

EXPOSE 3000

# Run as non-root for defence-in-depth (see design §Security baseline)
USER node

CMD ["node", "dist/server.js"]

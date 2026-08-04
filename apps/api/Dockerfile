# Multi-stage build for the API.
#
# The build context is the monorepo root so the `@dsa/shared` workspace resolves
# normally; only the compiled output and production dependencies reach the final image.

# ---- deps -------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app

# OpenSSL is required by Prisma's query engine on Alpine.
RUN apk add --no-cache openssl

COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/

RUN npm ci

# ---- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY . .

RUN npm run build -w @dsa/shared \
  && npx prisma generate --schema apps/api/prisma/schema.prisma \
  && npm run build -w @dsa/api

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache openssl

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/prisma ./apps/api/prisma

# Run unprivileged. `node` already exists in the base image.
USER node

EXPOSE 4000

# Migrations are applied at start-up rather than baked into the image, so a fresh
# volume converges on its own and a redeploy against an existing database is a no-op.
#
# The parentheses matter. `a && b || true && c` parses as `((a && b) || true) && c`,
# which swallows a FAILED MIGRATION and starts the API against an unmigrated database.
# Only the seed is allowed to fail (it is idempotent and non-essential); a migration
# failure must stop the container so the problem is visible.
CMD ["sh", "-c", "npx prisma migrate deploy --schema apps/api/prisma/schema.prisma && (npx tsx apps/api/prisma/seed.ts || echo 'seed skipped') && node apps/api/dist/main.js"]

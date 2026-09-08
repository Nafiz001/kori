# Multi-stage: the build needs TypeScript and dev dependencies, the runtime does
# not. Shipping them would triple the image and put a compiler in production.

FROM node:22-alpine AS build
WORKDIR /app

# Copy the manifests alone first. Docker caches this layer on their checksum, so
# a source-only change does not reinstall every dependency.
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# The .sql files are read at runtime by the migration runner and are not
# compiled, so tsc does not carry them across.
COPY src/db/migrations ./dist/db/migrations

# Run as a non-root user. The node image ships one; a container that does not
# use it runs the whole application as root for no reason.
USER node

EXPOSE 3000

# The orchestrator uses this to decide whether the instance can serve. Readiness
# rather than liveness, because it checks the database too.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]

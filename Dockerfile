# syntax=docker/dockerfile:1

# ── Build stage ───────────────────────────────────────────────────────
# fab's `prepare` script compiles dist/ during `npm ci`, so the source
# tree must be present before install.
FROM node:24-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm ci

# Drop devDependencies; the optional @anthropic-ai/claude-agent-sdk stays
# — the in-cluster path runs the sdk runtime.
RUN npm prune --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY skills ./skills

# Run as the unprivileged user shipped in the base image.
USER node

ENTRYPOINT ["node", "dist/bin/fab.js"]

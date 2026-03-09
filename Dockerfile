# ==========================================
# Builder Stage
# ==========================================
FROM oven/bun:1.1.8-debian AS builder

WORKDIR /app

# Install OS dependencies required for building natively
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Copy workspace configuration files first to cache dependencies
COPY package.json bun.lock ./
COPY apps/core-api/package.json ./apps/core-api/package.json
COPY packages/llm-extractor/package.json ./packages/llm-extractor/package.json
COPY packages/qmd-client/package.json ./packages/qmd-client/package.json
COPY packages/shared-types/package.json ./packages/shared-types/package.json

# Install dependencies (respecting workspaces)
RUN bun install --frozen-lockfile

# Copy the rest of the source code
COPY . .

# (Optional here: if any build steps or transpilation are needed, do them here.
# Since Bun executes TS directly, we mostly just need to ensure the environment is ready.)

# ==========================================
# Runner Stage
# ==========================================
FROM oven/bun:1.1.8-debian AS runner

WORKDIR /app

# Install Spatialite and QMD CLI dependencies
RUN apt-get update && apt-get install -y \
    libsqlite3-mod-spatialite \
    && rm -rf /var/lib/apt/lists/*

# Install QMD CLI globally so it is available on $PATH
RUN bun install -g @tobilu/qmd

# Ensure the container runs as a non-root user to avoid permission issues
# with bind mounts on the host (e.g. SQLite DB and Markdown files)
RUN chown -R bun:bun /app
USER bun

# Copy built node_modules and source from builder stage
COPY --from=builder --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/package.json ./package.json
COPY --from=builder --chown=bun:bun /app/bun.lock ./bun.lock
COPY --from=builder --chown=bun:bun /app/apps ./apps
COPY --from=builder --chown=bun:bun /app/packages ./packages

# Expose the API port
EXPOSE 3000

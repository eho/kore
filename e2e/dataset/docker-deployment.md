# Docker Deployment Strategy — Pocket Bookmark

Saved from Pocket — blog post from a senior DevOps engineer on production Docker deployment patterns.

## Multi-Stage Builds

The most impactful optimisation for Docker images in production. Separate your build environment from your runtime environment.

```dockerfile
# Stage 1: Builder
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
CMD ["node", "dist/index.js"]
```

## Docker Compose for Production

Use `docker-compose.yml` for orchestrating multi-service deployments. Define resource limits, restart policies, and health checks.

## Container Health Checks

Always define `HEALTHCHECK` instructions so orchestrators can detect unhealthy containers and restart them automatically.

## Secrets Management

Never bake secrets into images. Use Docker secrets, environment variables injected at runtime, or a secrets manager like HashiCorp Vault.

Tags: docker, deployment, container, devops, multi-stage build, docker-compose, production

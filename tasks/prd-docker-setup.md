# PRD: Docker Setup

## Introduction
The Kore project requires a Docker setup to allow the application to run entirely in a containerized environment. This feature will provide containerization for the unified Bun monorepo, supporting both the reactive "Pull" channel (Core API and QMD CLI) and the proactive "Push" channel (Notification Worker). It relies on the host machine's Ollama instance to maintain GPU acceleration. It will establish bind mounts for persistent data (SQLite database, markdown files) and support both a lightweight production deployment and a local development environment with hot-reloading.

## Goals
- Containerize the Core API, Notification Worker, and QMD CLI within a unified Bun runtime environment.
- Connect to a host-level Ollama service for GPU acceleration.
- Use explicit bind mounts with proper non-root permissions for persistent data storage to host directories.
- Provide a multi-stage Dockerfile that correctly handles Bun workspaces and enables both optimized production builds and a local development environment via Docker Compose.

## User Stories

### US-001: Create multi-stage Dockerfile for Core API + QMD + Workers
**Description:** As a developer, I want a multi-stage Dockerfile to build a lightweight production image of the Kore application that handles the Bun monorepo structure and OS-level dependencies.

**Acceptance Criteria:**
- [ ] Create `Dockerfile` at the project root based on an official Bun image (e.g., `oven/bun:debian` or `alpine`).
- [ ] Install OS-level dependencies required for geographic queries (e.g., `libsqlite3-mod-spatialite`).
- [ ] Implement a builder stage that copies `package.json`, `bun.lock`, `apps/`, and `packages/` to correctly resolve local workspace dependencies (e.g., `@kore/llm-extractor`).
- [ ] Ensure the container runs as a non-root user (e.g., the built-in `bun` user) to prevent permission issues on host-mounted volumes.
- [ ] Install the QMD CLI dependency in the image.
- [ ] Typecheck/lint passes locally.
- [ ] **[Documentation]** Update `README.md` and `docs/architecture/` with the location and purpose of the Dockerfile.

### US-002: Create Docker Compose configuration for Production
**Description:** As a user, I want a `docker-compose.yml` file to easily deploy the Core API and Notification Worker with appropriate directory bind mounts and host network access to Ollama.

**Acceptance Criteria:**
- [ ] Create `docker-compose.yml` at the project root.
- [ ] Configure the `core-api` service to use the built image, serving the reactive Pull channel (mapping port 3000 to the host).
- [ ] Configure a `notification-worker` service using the same image but overriding the command to run the background queue/Push channel.
- [ ] Configure bind mounts for `$KORE_DATA_PATH`, QMD configuration (if applicable), and the SQLite database directory, ensuring they match the non-root user IDs from US-001.
- [ ] Provide environment variable configuration demonstrating how to connect to the host's Ollama instance (e.g., `OLLAMA_HOST=http://host.docker.internal:11434`).
- [ ] **[Documentation]** Document production Docker deployment steps in `README.md`.

### US-003: Create Docker Compose configuration for Local Development
**Description:** As a developer, I want to use Docker Compose for local development with hot-reloading so that I don't have to install dependencies directly on my host machine.

**Acceptance Criteria:**
- [ ] Create `docker-compose.override.yml` or a `docker-compose.dev.yml` file.
- [ ] Mount the host source code (`apps`, `packages`, etc.) directly into the container.
- [ ] Override the container start command to use `bun run --hot` (or equivalent dev script) for both the Core API and Notification Worker services.
- [ ] **[Logic/Backend]** Verify the API hot-reloads upon source code changes without a container restart.
- [ ] **[Documentation]** Add a section to `README.md` on how to run the development environment via Docker.

## Functional Requirements
- FR-1: The system must provide a `Dockerfile` that correctly builds the Bun workspace and packages the Core Engine (API + Worker) and QMD CLI.
- FR-2: The system must use `docker-compose` to orchestrate both the pull (API) and push (Worker) channels.
- FR-3: The Docker Compose setup must map explicitly defined host directories to the container for persistent storage, avoiding root ownership issues on the host.
- FR-4: The container must be able to communicate with an Ollama instance running on the host machine.
- FR-5: The setup must support a hot-reloading development mode via source code bind mounts.
- FR-6: The Docker image must include `mod_spatialite` installed at the OS level for location-based queries.

## Non-Goals
- Containerizing Ollama (it will remain on the host for GPU acceleration/performance).
- Introducing Redis, BullMQ, or any separate message broker; the system must strictly use an SQLite-backed queue for "Local First" simplicity.
- Automated CI/CD pipelines for Docker image publishing.
- Kubernetes or Docker Swarm deployment configurations.

## Technical Considerations
- `host.docker.internal` may require specific configuration depending on the host OS (Linux vs macOS/Windows) to successfully reach the host's Ollama instance.
- Ensure the QMD CLI binary is compatible with the Docker image's OS architecture (typically `linux/amd64` or `linux/arm64`).
- **File Permissions:** By default, Docker runs as root. The internal SQLite path and markdown paths must map to a host path securely without permission issues. This requires using `USER bun` in the Dockerfile and potentially matching host UID/GID for bind mounts.
- **Spatialite Support:** Depending on the base image (`oven/bun:debian` vs `alpine`), installing Spatialite differs (`apt-get install libsqlite3-mod-spatialite` vs `apk add sqlite-spatialite`). Debian is generally safer for compatibility with `bun:sqlite`'s native NAPI bindings.

## Success Metrics
- A developer can run `docker compose up` to start a fully functional production instance (API + Worker).
- A developer can run a specific compose command to start a development instance with hot-reloading.
- Kore successfully communicates with the host's Ollama and writes to the mounted host directories with the correct host user permissions.
- Spatialite queries execute without missing extension errors.

## Open Questions
- What default paths should we use in `.env.example` for the bind mounts to make the initial setup as smooth as possible?
- How should we handle the initial `qmd collection add` command inside the containerized environment?

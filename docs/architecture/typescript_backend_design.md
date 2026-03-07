# Backend Evaluation: Python vs. Bun/TypeScript

The initial Kore architecture assumed a Python 3.12+ (FastAPI/Pydantic) backend for the "Core Engine" and LLM processing, while relying on a Bun/TS monorepo for ingestion (`an-export`) and indexing (`QMD`). 

This document re-evaluates that assumption to determine if shifting the Core Engine to **Bun/TypeScript** provides a better developer experience and system architecture.

---

## 1. The Python/FastAPI Baseline (Current Assumption)

**Why Python was initially considered:**
*   **AI Ecosystem:** Python is the undisputed king of AI. Libraries like LangChain, Pydantic (for strictly structured LLM outputs), and background orchestrators (Celery, ARQ) are highly mature.
*   **Ease of Data Processing:** Python handles complex web scraping, text chunking, and PDF parsing easily.

**The Fracture Problem:**
Kore is explicitly structured as a **Bun Monorepo**. 
*   Our best ingestion tool (`packages/an-export`) relies strictly on Bun, TypeScript, and macOS specific integrations. 
*   Our core indexer (`qmd`) is built entirely on Node/Bun and `node-llama-cpp`. 
*   If we use Python for the Core Engine, we introduce an immediate language fracture. We lose the ability to share Zod/Pydantic types, data schemas, and utility functions between the ingestors, the engine, and the indexer.

---

## 2. A Unified Bun/TypeScript Architecture

If we shift the Core Engine to Bun/TypeScript, the architecture immediately becomes cohesive. Let's look at how the Python components map to the modern Bun ecosystem:

| Component | Python Counterpart | Bun/TypeScript Solution |
| :--- | :--- | :--- |
| **Monorepo** | Poetry / UV / Pants | **Bun Workspaces** (Already in use) |
| **API Framework** | FastAPI | **ElysiaJS** or **Hono**. (Both offer incredible performance on Bun and native OpenAPI/Swagger generation). |
| **Data Validation** | Pydantic | **Zod`** or **TypeBox**. (Integrating seamlessly with Elysia to provide strictly typed APIs and LLM outputs). |
| **LLM Orchestration** | LangChain / OpenAI SDK | **Vercel AI SDK**, **Zod Structured Outputs**, or native `openai-node`. |
| **Database Driver** | asyncpg / sqlite3 | **`bun:sqlite`**. Bun has the fastest native SQLite driver available. We can easily load the `mod_spatialite` extension at runtime for geographic queries. |
| **Background Queue** | Celery / RQ / ARQ | **SQLite-backed queue** (Using `bun:sqlite` directly). BullMQ introduces a Redis dependency which breaks the "Local First" zero-dependency philosophy. |

---

## 3. Pros and Cons of a Unified Bun/TS Backend

### Pros

1.  **Code Reusability:** Every single interface, type definition (e.g., `MemoryItem`, `ExtractionResult`), and utility library can be shared across `apps/`, `packages/`, the Core Engine, and the UI.
2.  **Native Integration with QMD:** Since QMD is an NPM package/Bun tool (`@tobilu/qmd`), a TypeScript Core Engine can import its types, interact directly with its APIs, or manage its background processes natively rather than treating it as a black-box subprocess.
3.  **Simplified Infrastructure:** No need for a multi-language Docker Compose setup. The entire application (Ingestors + Engine + UI + Indexer) runs in a single Bun runtime environment.
4.  **Performance:** Bun's native SQLite driver (`bun:sqlite`) is notoriously fast, making Spatialite geofencing queries incredibly performant.

### Cons

*   **Immature ML Libraries:** If Kore ever needs to run heavy, customized local PyTorch pipelines (beyond what `node-llama-cpp` or QMD provides), it is much harder in JS. However, since QMD handles the local GGUF models via C++ bindings, this is not a concern for Kore's current scope.
*   **Spatialite Compilation:** Loading SQLite extensions in Node/Bun can occasionally be tricky depending on the host OS architecture (e.g., Apple Silicon vs Linux Docker). We must ensure `mod_spatialite` is properly available.

---

## 4. Architectural Decision & Redesign

**Conclusion:** The benefits of a unified, single-language Bun monorepo drastically outweigh the benefits of using Python for the Core Engine. Given that our most complex local requirements (QMD) are already JS/TS native, forcing a Python middle layer creates unnecessary friction.

### The New System Design (Bun-Native)

1.  **Framework:** The Core Engine will be an **ElysiaJS** server running on Bun.
2.  **Validation:** All incoming raw data and LLM extraction goals will use **Zod** schemas. Use OpenAI's `response_format` with `zodResponseFormat` to guarantee the LLM outputs perfect MemU-style "Atomic Memory Items".
3.  **Storage Engine:** `bun:sqlite` connecting to a `spatialite` database for the "Push" channel, while orchestrating `.md` file creation for the QMD "Pull" channel.
4.  **Queues:** A simple worker pool within Bun fetching from an SQLite task table. This avoids needing a Redis container, keeping the stack maximally simple, local-first, and lightweight.
5.  **LLM Pipeline:** Using **Vercel AI SDK** with `createOpenAI()` provider pointed at a local **Ollama** instance (`http://localhost:11434/v1`) as the default for cost efficiency and privacy. The default model is `qwen2.5:7b`. Cloud providers (OpenAI, Anthropic) can be swapped in via configuration if needed. The local QMD component handles the reranking and embedding natively.

This design unifies Kore under completely strict TypeScript, reducing cognitive overhead and simplifying long-term maintenance.

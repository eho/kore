# QMD Architecture and Search Pipeline Analysis

Kore uses the QMD (Query Markup Documents) engine for its local search and indexing capabilities. QMD operates entirely locally using SQLite, `sqlite-vec`, and local GGUF models via `node-llama-cpp`.

This document details how QMD designs its indexing pipelines, its sophisticated Hybrid Search execution, and specific mathematical quirks observed during testing (such as the "Nearest Neighbor in an Empty Room" problem).

---

## 1. Indexing & Storage

QMD indexes markdown files from configured collections. The indexing process is split into two distinct storage mechanisms: full-text storage and vector embedding.

### SQLite Full-Text Storage
When a file is indexed, QMD extracts its title (from the filename or the first markdown heading) and hashes the content to generate a 6-character `docid`. The full document text is then stored in a SQLite **FTS5 (Full-Text Search)** table to enable fast, exact keyword matching (BM25).

### Smart Chunking
For semantic search, documents cannot simply be fed into an embedding model in their entirety due to context window limits, nor can they be split blindly at hard token boundaries (which often cuts sentences or code blocks in half).

QMD uses a "Smart Chunking" algorithm to break documents into ~900-token chunks with 15% overlap. It scores potential break points based on Markdown semantics:
* **High Score:** Cutting at `H1`/`H2` headings.
* **Medium Score:** Cutting at paragraph breaks or horizontal rules.
* **Low Score:** Cutting in the middle of a sentence.
* **Protected:** Code blocks are explicitly protected from being split unless they exceed the chunk size themselves.

### Vector Embeddings
Each smart chunk is passed through a local embedding model (by default, `embeddinggemma-300M-Q8_0`). The resulting high-dimensional vectors are stored in an `sqlite-vec` index alongside metadata mapping them back to their original character positions in the source document.

---

## 2. The Hybrid Search Pipeline

QMD's flagship search command (`qmd query`, which powers `kore search`) uses a multi-stage Retrieve & Re-rank architecture. It combines the speed of bi-encoders and keyword search with the precision of cross-encoders.

### Step 1: Query Expansion
The user's initial query is passed to a small, fine-tuned local LLM (`qmd-query-expansion-1.7B`). This model generates alternative query phrasing, synonyms, and variations (e.g., expanding "auth" to "authentication flow, login, JWT").

### Step 2: Parallel Retrieval
The original query (which is given 2x weight) and the expanded variations are executed in parallel against:
1. **The FTS5 index** (for exact BM25 keyword matches).
2. **The Vector index** (for semantic similarity via Cosine Distance).

### Step 3: Reciprocal Rank Fusion (RRF)
The results from all these parallel searches are merged into a single ranked list using RRF (with a `k=60` constant). 
* **Top-Rank Bonus:** QMD applies a mathematical bonus (e.g., +0.05) to documents that rank #1 for the *original* query. This ensures that highly relevant exact matches aren't lost or diluted by the expanded query variations during fusion.
* **Cutoff:** The top 30 candidates from this merged list are kept for the next stage.

### Step 4: Cross-Encoder Re-ranking
Bi-encoders (used in Step 2) are fast but lack deep contextual understanding because they compress the query and document independently. 

To achieve high precision, QMD passes the top 30 candidates to a **Cross-Encoder** model (`qwen3-reranker-0.6b`). A cross-encoder feeds both the `Query` and the `Document` into the LLM simultaneously, allowing the model to use cross-attention to see how specific words in the query relate to specific words in the document.

The reranker evaluates: *"Is this document relevant to the query?"* It measures the **logprobs** (the mathematical confidence the model has in the token "Yes") and outputs an absolute relevance score from **0.0 to 1.0**.

### Step 5: Position-Aware Blending
Pure reranking can sometimes aggressively downrank exact keyword matches (e.g., if you search for an exact error code, the LLM might think a generic troubleshooting guide is "more semantically relevant" than the exact log file). 

To prevent this, QMD blends the deep Reranker score with the fast Retrieval (RRF) score. It applies a position-aware formula based on the document's initial retrieval rank:
* **Rank 1-3:** `75% RRF + 25% Reranker` (Heavily trusts retrieval to preserve obvious, exact top hits).
* **Rank 4-10:** `60% RRF + 40% Reranker`
* **Rank 11-30:** `40% RRF + 60% Reranker` (Trusts the LLM heavily here to find "hidden gems" that the fast retrieval missed and pull them to the top).

---

## 3. Edge Case: Vector Search in Small Indexes

When testing semantic vector search with a very small number of documents (e.g., just 1 or 2 files), users often encounter a confusing behavior: searching for a completely unrelated term returns the only document in the database, often with a surprisingly high relevance score.

### The "Nearest Neighbor in an Empty Room" Problem
This occurs due to how vector databases operate mathematically. Vector search maps your query to a point in high-dimensional space and asks the database for the *K nearest neighbors* (k-NN). If a "Ramen" document is the **only** document in the database, it is technically the "closest" point to a query for "Computer", even if the absolute semantic distance is massive. It wins by default.

### The Mathematical "Score Floor"
Because of QMD's Position-Aware Blending, an irrelevant document in a tiny index will receive an artificially inflated final score. 

1. **RRF Rank Score:** Since it's the only document, it is mathematically guaranteed to be the #1 result. Its RRF rank score is `1 / rank` = `1.0`. 
2. **LLM Score:** The reranker evaluates it and gives it a low baseline score (e.g., `0.50` based on base token probability).
3. **The Final Calculation (Rank 1 Formula):**
   `(0.75 * 1.0) + (0.25 * 0.50) = 0.875`

Because of this blending, **the absolute lowest score a Rank 1 document can ever get is 0.75** (even if the LLM reranker gives it a score of 0.0). 

### Mitigation

#### 1. Natural Resolution via Index Growth
This problem solves itself automatically as the index grows. As soon as you ingest more documents (e.g., 50+ notes), searching for "computer" will return actual tech notes. 

The irrelevant Ramen document will get pushed down to rank `30+`. At rank `30`, its RRF score becomes `1/30 (0.033)` and it uses the `40% / 60%` blending formula:
`(0.40 * 0.033) + (0.60 * 0.0) = 0.0132`

Once the index is populated, irrelevant documents naturally sink to scores well below `0.1`.

#### 2. Manual Mitigation via `--min-score`
To handle this during testing or with small datasets, a `minScore` threshold can be applied to drop results that fall below a certain confidence level. 

* In a populated index, a `--min-score 0.3` is usually sufficient to drop noise.
* In a nearly empty index, you must use a very high threshold (e.g., `--min-score 0.9`) to aggressively filter out the "least-bad" default winners that get artificially boosted to `0.75+`.

Kore exposes this via the CLI:
```sh
kore search "computer" --min-score 0.9
```
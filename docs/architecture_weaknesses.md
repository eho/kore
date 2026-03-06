# Architecture Stress Test: Weaknesses of the Hybrid Model

While the "Hybrid File-System" approach (combining MemU's extraction philosophies with QMD's retrieval engine and a Spatialite sidecar) is elegant and low-latency, it introduces specific edge cases and architectural trade-offs. 

By analyzing where this design breaks down, we can either build mitigations into the Core Engine or explicitly define them out of scope.

---

## 1. The "State Synchronization" Problem

**The Weakness:** We are storing the *same* memory across two different query engines.
1.  The Markdown file indexed by QMD.
2.  The coordinates and fast-lookup metadata in Spatialite.

**The Failure Scenario:**
If a user asks their AI Agent, *"I didn't actually like Mutekiya Ramen, can you delete that recommendation from my memory?"*, the MCP server `qmd_delete` (if implemented) will delete the `.md` file. However, QMD has no idea the Spatialite database exists. The restaurant's GPS coordinates will remain in Spatialite. Next year, the user will walk past Mutekiya and receive a push notification for a restaurant they explicitly asked to forget.

**Mitigation Required:**
The Kore API Gateway must be the single source of truth for all mutations (Create, Update, Delete). If an AI agent wants to modify a memory, it must call a Kore API endpoint, which then synchronously updates the `.md` file *and* the Spatialite DB, rather than the agent modifying the filesystem directly.

---

## 2. The "Over-Extraction" Information Loss

**The Weakness:** MemU's philosophy relies on distilling sloppy human input into rigid "Atomic Memory Items" at ingestion time.

**The Failure Scenario:**
A user saves a lengthy Reddit thread debating the nuances of three different Japanese learning textbooks (Genki, Minna no Nihongo, and Tobira). The ingestion LLM, trying to be concise, extracts:
*   *Memory Item: Genki is good for beginners.*
*   *Memory Item: Tobira is good for intermediate.*

Six months later, the user queries: *"In that Reddit thread I saved, what was the specific reason the top commenter said Minna no Nihongo was better than Genki for self-study?"*

Because the ingestion LLM deemed the detailed comparison irrelevant during the initial abstraction phase, QMD will index the overly-summarized Frontmatter higher than the raw text. The specific nuance is buried or lost entirely if the extraction was too aggressive.

**Mitigation Required:**
QMD must be configured to place equal index weight on both the `Raw Source` section of the `.md` file and the `Distilled Items` frontmatter, ensuring semantic matches against the original text are not penalized.

---

## 3. The "Dynamic Data Decay" Problem

**The Weakness:** The architecture stores extracted facts as immutable text in a Markdown file.

**The Failure Scenario:**
A user saves a bookmark to a local cafe. The LLM extracts: `Entity: Blue Bottle Coffee`, `State: Open Tuesday-Sunday`.
Two years later, the user asks the agent to plan a Monday coffee meeting. QMD retrieves the file and reads `State: Open Tuesday-Sunday`. The agent confidently tells the user to avoid Monday. However, the cafe changed its hours a year ago.

Because the intelligence (the extraction) happened *at ingestion time* and was frozen in a `.md` file, the memory is stale. Pure conversational RAG architectures handle this by retrieving the raw URL and browsing the live internet at query time. The Hybrid model trusts the frozen extracted state.

**Mitigation Required:**
Not easily solved without building an active web-scraping "memory maintenance" worker that periodically verifies the factual accuracy of established Memory Items (which defeats the low-compute goal). This must be accepted as an explicit system limitation: *Kore remembers what was true at the exact moment of ingestion.*

---

## 4. The "Concept Drift & Cross-Referencing" Failure

**The Weakness:** QMD indices flat files. It does not build a Knowledge Graph (nodes and edges).

**The Failure Scenario:**
Over three years, a user saves:
1.  A note about wanting to learn Python.
2.  A bookmark to a FastAPI tutorial.
3.  A Reddit thread about SQLAlchemy.

In a Graph Database (like Neo4j), these would be linked via edges to a central `[Concept: Python Backend]` node. 

In the Kore Hybrid model, if the user asks, *"Summarize my journey learning backend development"*, QMD has to rely entirely on vector similarity to fetch all three disparate documents. If the embedding distance between "Python" and "Backend development" isn't perfectly aligned in the LLM's latent space, it might miss the SQLAlchemy thread entirely.

**Mitigation Required:**
The system trades the robust relationship-mapping of a Knowledge Graph for the speed and simplicity of Flat Files + Vector Search. This means Kore will struggle with highly complex, multi-hop reasoning questions (e.g., *"Based on all my saved health records, travel history, and food preferences, why did I feel sick in March?"*).

---

## 5. Summary of Unsuitable Use Cases

If the user predominantly engages in the following behaviors, the Kore architecture will perform poorly:

*   **Mass Data Archiving:** Dumping 10,000 unread PDFs into the system. Running the MemU-style extraction pipeline on 10,000 PDFs will bankrupt the user in API costs (or melt a local GPU) before they ever issue a single search query. Kore is for *high-signal, explicit saves*, not a generic file dump like Google Drive.
*   **Live Fact Retrieval:** Asking Kore for stock alerts or current restaurant opening hours.
*   **Complex Multi-Hop Reasoning:** Asking Kore to synthesize a hypothesis based on 40 different, tangentially related saved notes over a five-year period. QMD's context window will simply truncate the results before the reasoning agent can see the full picture.

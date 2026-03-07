# Concrete Examples: The Kore Hybrid Architecture in Action

This document illustrates exactly how data moves through the proposed Kore Hybrid Architecture (MemU-style extraction feeding into a QMD index and Spatialite database). 

We will walk through two distinct scenarios: an unstructured note about a restaurant, and a structured bookmark about a technical concept.

---

## Example 1: The Scrambled Apple Note (Focus on Location & Intent)

**The Scenario:** You are at a dinner party and someone recommends a great restaurant in Tokyo. You open Apple Notes and quickly jot down a messy, unstructured thought so you don't forget it.

### 1. Raw Ingestion (The Resource)
The `an-export` background worker grabs the raw note from the local Apple Notes SQLite database.

```text
Title: None
Body: 
John told me about this insane ramen place in tokyo. it's called Mutekiya in Ikebukuro. 
He said to get there right when it opens or the line is an hour long. 
Try the tonkotsu, it's their signature. 
Mentioned it's good for solo dining.
```

### 2. The Extraction (Core + Plugin Hooks)
The Bun worker intercepts this raw text. The ingestion is split into two phases:

1.  **Core Extraction:** The core engine determines the base intent and categories:
    *   **Categories:** `[Travel, Food, Restaurant, Japan, Ramen]`
    *   **Key Facts:** "Signature dish is tonkotsu.", "Arrive at opening to avoid 1hr line.", "Good for solo dining."

2.  **Plugin Hook (`kore-plugin-spatialite`):** The Spatial plugin inspects the text, sees geographical markers ("Tokyo", "Ikebukuro", "Mutekiya"), and runs a rapid LLM extraction to inject metadata:
    *   **Entity:** Mutekiya Ramen (Ikebukuro, Tokyo, Japan)
    *   **Coordinates:** Lat: `35.7289`, Long: `139.7115`

### 3. The Output (The Mount Point)
The Bun worker takes the aggregated data and constructs a standardized Markdown file. It writes this file to the filesystem at `~/kore-data/places/mutekiya_ramen.md`. 
It then broadcasts the `memory.indexed` event. The `spatialite` plugin listens to this event and writes the coordinates and file path to its own isolated **Spatialite Database**.

```markdown
---
id: a1b2c3d4
category: qmd://travel/food/japan
type: place
name: Mutekiya Ramen
location: Ikebukuro, Tokyo, Japan
coordinates: [35.7289, 139.7115]
source: apple_notes
date_saved: 2026-03-06
tags: [ramen, solo-dining, tonkotsu]
---

# Mutekiya Ramen (Ikebukuro, Tokyo)

## Distilled Memory Items
- **Recommendation:** Recommended by John for excellent tonkotsu ramen (signature dish).
- **Logistics:** Arrive exactly at opening; otherwise, expect a 1+ hour line.
- **Vibe:** Highly recommended for solo dining.

---
## Raw Source
John told me about this insane ramen place in tokyo. it's called Mutekiya in Ikebukuro. 
He said to get there right when it opens or the line is an hour long. 
Try the tonkotsu, it's their signature. 
Mentioned it's good for solo dining.
```

### 4. Indexing & Retrieval
A local file watcher triggers `qmd update`. QMD reads the new markdown file, embeds the text using its local `embeddinggemma` model, and updates the SQLite FTS5 (BM25) index.

#### The Agentic Pull (QMD Workflow)
*   **User Query (via Claude/OpenClaw):** *"I'm heading to Tokyo alone next month. Do I have any saved restaurants that are good for eating by myself?"*
*   **MCP Action:** The agent uses `qmd_deep_search(query="Tokyo solo dining restaurant")`.
*   **QMD Retrieval Process:**
    1.  QMD performs hybrid search (Vector similarity matching "solo dining" and BM25 matching "Tokyo").
    2.  Because the text was cleanly distilled in the Frontmatter and "Distilled Memory Items" section, `mutekiya_ramen.md` scores a `0.95` relevance.
    3.  QMD returns the snippet containing the raw facts to the agent. 
*   **Agent Response:** *"Yes! John recommended a place called Mutekiya Ramen in Ikebukuro. He noted it's great for solo dining, but you should try to get there right when it opens to avoid an hour-long line. Their signature is the tonkotsu."*

#### The Proactive Push (Spatialite Workflow)
*   **Trigger:** Six months later, the user is walking around Shibuya/Ikebukuro. Their phone sends a generic OS-level location ping to the Kore Spatialite DB: `[Lat: 35.7300, Long: 139.7100]`.
*   **Query:** The DB runs `ST_Distance` and finds `mutekiya_ramen.md` is only 400 meters away. 
*   **Result:** The system fires a lightweight push notification to the user's phone: *"📍 Mutekiya Ramen is 400m away. You previously saved a note to try their Tonkotsu and that it's great for solo dining."* (Zero LLM inference required at the moment of the push).

---

## Example 2: The Complex Bookmark (Focus on Knowledge & Concepts)

**The Scenario:** You are reading an article about "React Server Components vs. Client Components" on your phone. You use an iOS Shortcut or Web Clipper to save the URL to Kore because you want to use the concepts for a personal project later.

### 1. Raw Ingestion (The Resource)
The web clipper grabs the URL, title, and the fully scraped HTML body text of the article.

```text
URL: https://example.com/react-server-components-guide
Title: The Ultimate Guide to React Server Components
Body: [3,000 words of technical explanation, code snippets, and deployment tradeoffs regarding when to use RSCs versus traditional client-side rendering...]
```

### 2. The Extraction (MemU-Style Distillation)
The background worker sends the massive text block to an LLM. Asking an agent to read 3,000 words *at retrieval time* is slow and token-heavy. Therefore, the extraction LLM distills the core lessons.

The LLM extracts **Atomic Memory Items**:
*   **Category:** `[Technology, Web Development, React]`
*   **Key Fact 1:** RSCs do not bundle into the client Javascript payload, reducing bundle size.
*   **Key Fact 2:** Cannot use `useState` or `useEffect` in Server Components.
*   **Key Fact 3:** Recommended for data fetching and static markup.

### 3. The Output (The Mount Point)
The worker saves `~/kore-data/tech/react_server_components_guide.md`.

```markdown
---
id: e5f6g7h8
category: qmd://tech/web-dev/react
type: article_bookmark
url: https://example.com/react-server-components-guide
title: The Ultimate Guide to React Server Components
date_saved: 2026-03-06
tags: [react, server-components, architecture]
---

# The Ultimate Guide to React Server Components

## Distilled Memory Items
- **Core Benefit:** React Server Components (RSCs) execute exclusively on the server, meaning their dependencies are not added to the client JavaScript bundle.
- **Constraints:** You cannot use interactivity hooks (`useState`, `useEffect`, `onClick`) within a Server Component. 
- **Use Cases:** Ideal for heavy data fetching, accessing backend resources directly, and rendering static content. Use Client components for interactive UI elements.

---
## Raw Source
[The original scraped 3,000 words is preserved below for direct context if the agent requests the `--full` document via QMD...]
```

### 4. Indexing & Retrieval

QMD indexes the highly structured Markdown file. The `qmd://tech/web-dev/react` context path heavily influences the vector space, ensuring this document clusters with other web development concepts.

#### The Agentic Pull (QMD Workflow)
*   **User Query (via Cursor IDE or Claude):** *"I'm building my new app portfolio. Should I make the navigation bar a Server Component?"*
*   **MCP Action:** The agent runs `qmd_deep_search(query="React server component tradeoffs interactive UI")`
*   **QMD Retrieval Process:**
    1.  QMD's local LLM reranker sees the highly summarized "Distilled Memory Items" section in `react_server_components_guide.md`.
    2.  It matches the exact constraint: *"Cannot use interactivity hooks (`onClick`) within a Server Component."*
    3.  Because the file was pre-summarized at ingestion, QMD returns a highly concentrated 150-token context snippet to the agent, rather than vomiting a 3,000-word article into the prompt.
*   **Agent Response:** *"Based on an article you saved on React Server Components, you should likely make the navigation bar a **Client Component**. Your saved notes highlight that you cannot use interactivity hooks like `onClick` or `useState` inside Server Components. Since a navbar usually requires interactive state (like opening a mobile menu), it needs to be client-side. You can keep the main page wrapper as a Server Component though!"*

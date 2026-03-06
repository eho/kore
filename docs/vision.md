# Vision Document: Kore 

*Kore (n.)*
1. **Greek roots:** Meaning "the core" or "the heart," tying into the mythological themes of the Cronus system, memory, and cycles.
2. **Japanese (これ - "this"):** A literal pointer. In the context of an AI agent, Kore transforms the system from a vague "database" into an active participant providing specific, localized context, effectively saying, "Here, use *this* right now."

## 1. The Core Problem: "The Recall Disconnect"

We constantly capture high-value inspiration for our personal lives—from standout dining experiences and travel itineraries to language learning resources and photography spots. However, this curation is scattered across an increasingly fragmented digital landscape. We save items with the explicit intention of using them later, utilizing platforms such as:

* **Social & Media Saves:** X Bookmarks, Reddit "Saves", Instagram and TikTok saved collections (highly common for food/travel), and YouTube "Watch Later" lists.
* **Reading & Curation Apps:** Safari/Chrome bookmarks, Pocket, Instapaper, or Pinterest boards.
* **Note-Taking & Workspaces:** Apple Notes, Google Keep, Notion, or Obsidian.
* **Communication Silos:** Slack "Saved Items", Discord bookmarks, or starred emails.

Because human working memory of the *act of saving* fades within hours, a critical disconnect occurs. When the context actually arises where that information is needed, we fail to retrieve our curated ideas simply because we forgot they exist across this sprawling web of apps. This forces redundant, last-minute research, adds unnecessary stress to planning, and leaves our best discoveries untouched in a digital black hole.

## 2. Real-World Friction (The Scenarios)

* **The Location-Blind Spot (Travel & Food):** You see a great thread about hidden alleyway cafes and must-try restaurants in Melbourne and bookmark it. Months later, you travel there for a marathon. As you are walking around the city looking for a place to eat, you default to a generic Google Maps search because the tailored list you saved months ago never crosses your mind. The memory needs to be triggered by the *location*, not just a manual search.
* **The Special Occasion Scramble:** You are looking for a special spot to celebrate your wife's birthday. Three months ago, you saw a glowing review on X for an incredible new degustation menu in Sydney and bookmarked it. When it is time to actually make a reservation, the name is forgotten, and digging through hundreds of unsorted X bookmarks takes longer than just searching for a new place from scratch.
* **The Stalled Hobby:** You come across a highly recommended framework or app for practicing Japanese and Mandarin. You save the link in Apple Notes, meaning to set it up over the weekend. The weekend arrives, the "trigger" to check your notes never fires, and the resource gathers digital dust.

## 3. The Vision: "The Proactive Lifestyle Concierge"

We are building a seamless, AI-integrated lifestyle backend that completely removes the burden of "remembering to remember." This system bridges the gap between passive inspiration and active execution.

Instead of an app you have to open and organize, it is an invisible engine that aggregates your explicitly saved content and seamlessly surfaces it exactly when and where you need it—either through conversational AI or proactive, context-aware nudges.

## 4. Core Pillars of the System

* **Frictionless, Passive Ingestion:** The system does not require you to change how you browse. It relies on automated pipelines to silently ingest the things you already do: X bookmarks, Safari bookmarks, and Apple Notes. It strictly ignores passive data (like browser history) to maintain a high-signal, privacy-first database.
* **Invisible, Agentic Retrieval:** There is no complex UI or folder system to manage, nor do you need to learn specific commands. Retrieval is completely frictionless and autonomous. The system acts as a background reasoning engine; when you converse with your AI about upcoming travel plans or a coding issue, the AI autonomously determines if your memory bank contains relevant context, retrieves it, and weaves it into the conversation without you ever having to say, *"Search my memory."*
* **Context and Location Proactivity (The Holy Grail):** The system goes beyond reactive conversational search and becomes a truly proactive concierge. By structuring the ingested data with geographic, temporal, or categorical metadata during ingestion, the engine can initiate the interaction. It can send a gentle nudge when you are geographically walking past a cafe you saved on Instagram six months ago, or remind you of a saved resource when an anniversary or trip date is approaching.

## 5. Technical Boundaries & Assumptions

To ensure this vision is technically actionable and grounded, the following constraints and assumptions guide the initial architecture:

* **Ingestion Strategy:** Initial ingestion will focus on platforms with accessible APIs (e.g., X, Reddit, Pocket) or via local sync mechanisms (e.g., Apple Notes). Closed ecosystems (like TikTok or Instagram) will require alternative methods like iOS Shortcuts or browser extensions.
* **Proactivity Triggers:** The system assumes the presence of a companion mobile app or a tight integration with OS-level location services to provide the background location and temporal data necessary for proactive nudges.
* **Data Privacy & Storage:** The architecture prioritizes a "privacy-first" model. Initially, this assumes local-first storage or a dedicated, user-owned, self-hosted environment (e.g., Docker container) to ensure sensitive personal data is strictly isolated.
* **Processing & Extraction:** The system relies on Large Language Models (LLMs) running asynchronously (as background jobs) to extract rich metadata—like geographic coordinates, categories, and potential intent—from raw ingested links and content.
* **Dual-Channel Interface (Pull vs. Push):** To realize both "Agentic Retrieval" and "Proactive Nudges," the system requires two distinct output channels:
    * **The Pull Channel (Reactive/Conversational):** The core memory engine will be exposed as a plugin or tool using the Model Context Protocol (MCP). This allows existing AI assistants (like Claude, Cursor, or ChatGPT) to seamlessly query the memory bank during your workflow without requiring a custom chat UI.
    * **The Push Channel (Proactive):** Because MCP is primarily a reactive client-server model, proactive location or time-based nudges will be handled by a separate notification worker. When a trigger fires (e.g., GPS proximity to a saved cafe), this worker pushes an alert directly to the user via an OS-level integration, lightweight companion app, or messaging bot (like Telegram).

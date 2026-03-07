# Potential macOS Local Ingestion Sources

Because Kore focuses on **"high signal, explicitly saved (or highly relevant) data"** rather than indiscriminate logging, the Mac is a goldmine of local, high-signal data. Here are the most valuable local macOS sources to consider for ingestion, ranked by signal-to-noise ratio:

## 1. The "Screenshot Habit" (Apple Photos / OCR)
Many people see a restaurant on Instagram or a book recommendation on TikTok and, instead of using a native "save" feature, they simply take a screenshot. 
*   **The Ingestion:** A script that monitors the `~/Pictures/Screenshots` folder (or queries the native Photos database for the "Screenshots" media type), runs lightweight local OCR, and passes the text to the Kore LLM to extract entities (e.g., "This is a screenshot of a Yelp page for a Sushi restaurant").
*   **Why it's great:** Captures the "invisible" saves from walled-garden apps like Instagram/TikTok that lack exportable APIs.

## 2. Apple Reminders (`Reminders` SQLite DB)
While Notes is for thoughts, Reminders is for *intent*. People frequently use Reminders as a dump for "Movies to Watch," "Books to Read," or "Places to visit in XYZ."
*   **The Ingestion:** Similar to `an-export`, a script reads the local Reminders SQLite DB, extracting the list names, item titles, and completion status.
*   **Why it's great:** Extremely high-signal. If it's on a list, the user explicitly wanted to remember it.

## 3. iMessage Recommendations (`chat.db`)
Your `~/Library/Messages/chat.db` contains incredible, curated recommendations from friends.
*   **The Ingestion:** You wouldn't want to ingest every "Hey" or "On my way." Instead, the extraction LLM could be prompted to filter specifically for recommendation semantics: *"You have to try [X]"*, *"Check out this [Y]"*, or links shared between friends.
*   **Why it's great:** Recommendations from close friends carry much higher weight than random internet bookmarks.

## 4. Apple Calendar Events & Invites
Calendar events are the ultimate temporal and spatial anchors.
*   **The Ingestion:** Reading local `.ics` data for event titles, locations, attendees, and the event "Notes" field (which often contains Zoom links, agendas, or context).
*   **Why it's great:** Enables queries like, *"What was the name of the venture capital firm I met with for coffee in SoHo last October?"* The agent combines the time, the Calendar location, and the contact name.

## 5. Safari Reading List (Distinct from Bookmarks)
Bookmarks are often used for utility (e.g., a link to your bank), whereas the Reading List is used purely for content consumption intent.
*   **The Ingestion:** Safari stores the Reading List in a local plist/database (`~/Library/Safari/Bookmarks.plist`).
*   **Why it's great:** It's explicitly curated content. Apple also caches the offline HTML of Reading List items locally, meaning you could ingest the full text of the article immediately without hitting the live web.

## 6. Apple Contacts ("Notes" Field)
The `~/Library/Application Support/AddressBook/` database holds your contacts.
*   **The Ingestion:** Pulling the names, companies, and specifically the **Notes** section of a contact card.
*   **Why it's great:** Power-networkers often write *"Met at AWS re:Invent, spouse is named Jane, likes craft beer"* in the contact notes. Ingesting this turns Kore into an incredibly powerful personal CRM.

## 7. Developer & Niche Data (If applicable)
*   **Terminal History (`.zsh_history`):** For software engineers, we constantly google complex commands (like an obscure `ffmpeg` conversion string) and then forget them. Ingesting the terminal history, using an LLM to figure out *what* the command does, and saving it as a "Skill" memory item.
*   **Local PKM Vaults:** If you use Obsidian, Logseq, or Bear, these are either local markdown folders or local SQLite DBs that can easily be mapped directly into Kore.

---

### Summary of the "Mac Local" Ecosystem Strategy
The beauty of macOS is that almost every native app (`Notes`, `Reminders`, `Messages`, `Calendar`, `Contacts`, `Safari`) stores its data in local, unencrypted SQLite databases or Plist files within `~/Library/...` 

As long as the Bun ingestion worker is granted **"Full Disk Access"** in macOS System Settings, it can quietly read from all of these silos in the background without needing a single API key or cloud integration.

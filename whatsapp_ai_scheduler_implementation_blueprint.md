# Project Specification: Autonomous WhatsApp-to-Calendar AI Agent ("SyncGuard")

> **Instructions for Claude Code / AI Coding Agent:**  
> You are tasked with building **SyncGuard**, an autonomous background service that silently monitors a user's WhatsApp group chats and direct messages, filters for relevant university/social schedules (lectures, vivas, project deadlines, meetups, picnics), checks Google Calendar for conflicts, books events automatically, and sends proactive conflict alerts back to the user via their WhatsApp "Message Yourself" chat.  
> Follow this specification strictly and implement the project phase-by-phase, verifying each phase before moving to the next.

---

## 1. System Overview & Core Problems Solved

The user does not read noisy WhatsApp group chats regularly and misses critical university announcements (viva slots, rescheduled lectures, project deadlines) and social plans (picnics, meetups). 

### Key Functional Requirements:
1. **Zero-Touch Passive Ingestion:** Silently listen to incoming WhatsApp messages (text and image captions) from selected or all group chats without requiring the user to manually forward messages.
2. **Contextual Batching (Anti-Spam):** Do not trigger AI parsing on every single `"Ok"` or `"👍"` message. Buffer messages per chat and evaluate them in conversational batches once a discussion settles or on a periodic interval.
3. **Personal Relevance Filtering:** University groups broadcast notices for multiple batches, sub-groups, and courses. The AI must cross-reference incoming notices against a `user_profile.json` (e.g., the user's specific degree, year, sub-group, and enrolled module codes) and ignore irrelevant notices.
4. **Event vs. Deadline Distinction:**
   - **Time-Blocked Events** (Lectures, Vivas, Meetings, Picnics): Have a strict `start_time` and `end_time`. Must be checked for time-slot overlaps.
   - **Point-in-Time Deadlines** (Project Submissions, Assignment Due Dates): Should be scheduled as high-visibility Reminder/Deadline blocks (e.g., 30-minute block at the due time or an All-Day banner) with advance notifications (48h and 24h prior) without falsely blocking daytime lectures.
5. **Strict Conflict Detection & Advance Alerting:** Before inserting a Time-Blocked Event into Google Calendar, query the user's existing schedule.
   - **No Conflict:** Automatically add the event to Google Calendar and send a clean confirmation to the user's own WhatsApp ("Message Yourself" chat).
   - **Conflict Detected:** Do NOT silently overwrite. Create the calendar event prefixed with `⚠️ [CONFLICT]` (colored red in Google Calendar) AND immediately send a high-priority WhatsApp alert to the user detailing both overlapping events so they can reschedule in advance.
6. **Update & Reschedule Awareness:** If a lecturer or friend says *"Tomorrow's 10 AM viva is moved to 2 PM"*, the system must search existing calendar events over the next 14 days, update the existing event, and re-verify for conflicts.

---

## 2. Tech Stack & Architecture

- **Runtime:** Node.js (v20+ LTS) with TypeScript (`tsx` for execution).
- **WhatsApp Bridge:** `@whiskeysockets/baileys` (Lightweight WebSockets library that connects as a Linked Device via terminal QR code—no heavy headless Chrome required).
- **Database & State Management:** `better-sqlite3` with Drizzle ORM or raw SQL (lightweight, zero-config local file `syncguard.db`).
- **AI / LLM Engine:** Google Gemini API (`@google/genai` using `gemini-2.5-flash`) or Anthropic Claude API (`@anthropic-ai/sdk`) using **Structured JSON Outputs**.
- **Calendar Integration:** `googleapis` (Google Calendar API v3 using OAuth2 with local refresh token persistence).
- **Task Scheduling:** `node-cron` (for flushing message buffers and sending daily morning agenda summaries).

---

## 3. Directory Structure

```text
syncguard/
├── package.json
├── tsconfig.json
├── .env.example
├── config/
│   └── user_profile.json         # User's university courses, batch, group filters, and preferences
├── data/
│   ├── auth_info_baileys/        # Auto-generated WhatsApp session credentials
│   ├── google_token.json         # OAuth2 saved token
│   └── syncguard.db              # SQLite database for message buffering & event logs
└── src/
    ├── index.ts                  # Application entry point & orchestrator
    ├── config.ts                 # Env validation and user_profile loader
    ├── db/
    │   └── database.ts           # SQLite schema initialization & queries
    ├── whatsapp/
    │   ├── client.ts             # Baileys connection, QR generation, message listener
    │   └── notifier.ts           # Sends formatted alerts to user's own WhatsApp JID
    ├── buffer/
    │   └── batchProcessor.ts     # Sliding-window buffer & cron job to send chat chunks to AI
    ├── ai/
    │   ├── extractor.ts          # LLM call with strict JSON schema & user relevance prompt
    │   └── prompts.ts            # System instructions for university/social context extraction
    └── calendar/
        ├── googleClient.ts       # Google OAuth2 setup & Calendar API wrapper
        └── conflictEngine.ts     # FreeBusy/overlap checker, event creator, and updater
```

---

## 4. Configuration: `config/user_profile.json`

Create this file so the user can customize what is relevant to them without touching code:

```json
{
  "userName": "Alex",
  "timezone": "Asia/Colombo",
  "universityProfile": {
    "institution": "University",
    "year": 3,
    "semester": 1,
    "batchGroup": "Y3.S1.WE.02",
    "specialization": "Software Engineering",
    "enrolledModules": [
      { "code": "SE3010", "name": "Software Quality Assurance" },
      { "code": "SE3020", "name": "Distributed Systems" },
      { "code": "CS3040", "name": "Database Systems" },
      { "code": "IT3050", "name": "Final Year Project" }
    ],
    "ignoreKeywords": ["Year 1", "Year 2", "Y1S1", "Y2S2", "Repeat Exam"]
  },
  "socialPreferences": {
    "trackMeetups": true,
    "trackPicnicsAndTrips": true,
    "defaultEventDurationMinutes": 60,
    "defaultPicnicDurationMinutes": 240
  },
  "monitoredChats": {
    "mode": "ALL_EXCEPT_MUTED",
    "whitelistedGroupNames": [
      "Y3S1 Official Notices",
      "SE3020 Project Group",
      "Batch Trip 2026",
      "Uni Friends"
    ],
    "blacklistedGroupNames": [
      "Meme Dump",
      "Buy & Sell"
    ]
  },
  "notifications": {
    "dailyBriefingTime": "07:30",
    "alertOnEveryAddedEvent": true,
    "alertOnConflictsImmediately": true
  }
}
```

---

## 5. Database Schema (`src/db/database.ts`)

Use SQLite to store raw incoming messages temporarily and maintain a ledger of scheduled events (to prevent duplicate entries when people keep talking about the same event).

```sql
-- Table 1: Message Buffer (stores unread messages waiting for batch AI analysis)
CREATE TABLE IF NOT EXISTS message_buffer (
    id TEXT PRIMARY KEY,
    chat_jid TEXT NOT NULL,
    chat_name TEXT NOT NULL,
    sender_name TEXT NOT NULL,
    message_text TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    processed INTEGER DEFAULT 0
);

-- Table 2: Synced Events Ledger (prevents duplicates & enables rescheduling)
CREATE TABLE IF NOT EXISTS synced_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_event_id TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL, -- 'LECTURE' | 'VIVA' | 'DEADLINE' | 'MEETUP' | 'PICNIC' | 'OTHER'
    start_time TEXT NOT NULL, -- ISO 8601
    end_time TEXT NOT NULL,   -- ISO 8601
    source_chat_name TEXT NOT NULL,
    has_conflict INTEGER DEFAULT 0,
    conflicting_with TEXT,    -- JSON array of conflicting event titles
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

---

## 6. Core Logic & Pipeline Design

### Module A: WhatsApp Passive Listener (`src/whatsapp/client.ts`)
1. Initialize `@whiskeysockets/baileys` using `useMultiFileAuthState('./data/auth_info_baileys')`.
2. Print the QR code in the terminal using `qrcode-terminal` on first run.
3. Listen to `sock.ev.on('messages.upsert', ...)`:
   - Extract text from standard messages (`message.conversation`), extended text (`message.extendedTextMessage.text`), or image/document captions (`message.imageMessage.caption` / `message.documentMessage.caption`).
   - Ignore status broadcasts (`status@broadcast`) and messages sent by the bot itself.
   - Check `user_profile.json` chat filtering rules.
   - Insert valid messages into `message_buffer` with `processed = 0`.

### Module B: Smart Sliding-Window Batcher (`src/buffer/batchProcessor.ts`)
Why batch? In a group chat, 15 messages might be exchanged over 5 minutes to agree on a meetup time.
1. Run a job every **3 minutes**.
2. Query `message_buffer` for any `chat_jid` that has unprocessed messages (`processed = 0`) where either:
   - The newest message in that chat is at least **2 minutes old** (conversation settled), OR
   - There are more than **20 unprocessed messages** waiting in that chat.
3. Also fetch the last 5 *already processed* messages from that same chat as read-only context so the AI understands what a reply like *"Let's make it 3 PM instead"* refers to.
4. Fetch the user's upcoming 14 days of `synced_events` from SQLite and pass them to the AI so it knows what is *already* on the calendar (preventing duplicates and enabling updates).

### Module C: AI Relevance & Extraction Engine (`src/ai/extractor.ts` & `src/ai/prompts.ts`)

Pass the formatted chat transcript, the current date/time (with day of week and timezone), `user_profile.json`, and existing scheduled events to the LLM.

#### System Prompt Specification:
```text
You are an elite personal scheduling assistant for a university student.
Current Reference Time: {{CURRENT_ISO_TIME}} ({{DAY_OF_WEEK}}), Timezone: {{TIMEZONE}}.

USER PROFILE:
{{USER_PROFILE_JSON}}

ALREADY SCHEDULED EVENTS (Next 14 Days):
{{EXISTING_EVENTS_JSON}}

TASK:
Analyze the provided WhatsApp chat transcript from "{{CHAT_NAME}}" and extract any actionable schedule items.

STRICT RULES:
1. RELEVANCE FILTER:
   - If the message is a university notice, verify if it applies to the user's year, semester, batchGroup, specialization, or enrolledModules.
   - If a notice is exclusively for a different group (e.g., different subgroup or module the user doesn't take), ignore it completely.
2. CONSENSUS CHECK FOR SOCIAL PLANS:
   - For meetups, picnics, or group study sessions, do NOT extract hypothetical questions ("Can we meet Friday?") unless there is agreement or a clear plan set in the chat.
3. EVENT CLASSIFICATION & DURATION:
   - LECTURE / VIVA / EXAM / MEETING / MEETUP / PICNIC: Set `is_time_blocked = true`. If `end_time` is not explicitly stated, infer a sensible duration based on `user_profile.json` (e.g., 1 hour for meetings/vivas, 2 hours for lectures, 4 hours for picnics).
   - DEADLINE (Assignment/Project submissions): Set `is_time_blocked = false`. Set `start_time` to 30 minutes before the due time and `end_time` to the exact due time.
4. DEDUPLICATION & UPDATES:
   - Compare extracted items against ALREADY SCHEDULED EVENTS.
   - If the exact event is already scheduled at the same time, set `action = "IGNORE"`.
   - If the chat reschedules or changes the time/venue of an existing event, set `action = "UPDATE"` and include the `target_google_event_id`.
   - If it is a brand new event, set `action = "CREATE"`.
```

#### Expected Structured Output Schema (JSON):
```json
{
  "extracted_items": [
    {
      "action": "CREATE | UPDATE | IGNORE",
      "target_google_event_id": "string or null",
      "title": "Clear, concise title (e.g., '[SE3020] Viva Presentation' or 'Batch Picnic - Kosgama')",
      "category": "LECTURE | VIVA | DEADLINE | MEETUP | PICNIC | OTHER",
      "is_time_blocked": true,
      "start_time": "2026-10-20T10:00:00+05:30",
      "end_time": "2026-10-20T11:00:00+05:30",
      "location": "Room A502 / Zoom Link / Online / Unknown",
      "description": "Summary of instructions, what to bring, or sender details from the chat.",
      "confidence_score": 0.95,
      "reasoning": "Why this is relevant to the user and how the time was calculated."
    }
  ]
}
```

### Module D: Conflict Engine & Google Calendar Sync (`src/calendar/conflictEngine.ts`)

For every extracted item where `action === "CREATE"` or `"UPDATE"` and `confidence_score >= 0.75`:

1. **Step 1: Check for Conflicts (`calendar.events.list`)**
   - Query the user's primary Google Calendar between `start_time` and `end_time` (`singleEvents: true`).
   - Filter out all-day banner events or free/transparent events (`transparency === 'transparent'`).
   - If `is_time_blocked === true` and one or more existing busy events overlap:
     - Mark `has_conflict = true`.
     - Record the conflicting event names and time ranges.

2. **Step 2: Insert or Update on Google Calendar**
   - **If NO Conflict:**
     - Create/Update the event on Google Calendar.
     - Color ID: Blue (`9`) for Lectures, Yellow (`5`) for Meetups/Picnics, Purple (`3`) for Vivas, Orange (`6`) for Deadlines.
     - Add custom reminders: Popup at 60 minutes and 1440 minutes (24 hours) before.
   - **If Conflict Detected:**
     - Still create the event on Google Calendar so the user sees it visually, **but** prefix the title with `⚠️ [CONFLICT] ` and set Google Calendar `colorId = '11'` (Bright Red / Tomato).
     - Append the conflict details into the Google Calendar event description.

3. **Step 3: Instant WhatsApp Self-Notification (`src/whatsapp/notifier.ts`)**
   - Send a message to the user's own WhatsApp JID (`sock.user.id`).
   - **Format for Conflict Alert:**
     ```text
     🚨 *SCHEDULE CONFLICT DETECTED* 🚨

     A new event from *{{source_chat_name}}* clashes with your existing schedule!

     📌 *New Event:* {{title}}
     🕒 *Time:* {{formatted_start}} - {{formatted_end}}
     📍 *Location:* {{location}}

     ⚡ *Clashes With:*
     • {{existing_event_title}} ({{existing_start}} - {{existing_end}})

     _I have added this to your Google Calendar in RED so you can rearrange one of them in advance._
     ```
   - **Format for Clean Addition:**
     ```text
     ✅ *Auto-Scheduled from WhatsApp*
     📅 *{{title}}* ({{category}})
     🕒 {{formatted_start}} - {{formatted_end}}
     💬 Source: _{{source_chat_name}}_
     🟢 Status: *No Conflicts*
     ```

---

## 7. Step-by-Step Implementation Plan for Claude Code

Execute the implementation in the following sequential phases:

### Phase 1: Project Scaffolding & Configuration
1. Initialize `package.json` with dependencies:
   - `@whiskeysockets/baileys`, `qrcode-terminal`, `pino`
   - `@google/genai` (or `@anthropic-ai/sdk`), `googleapis`
   - `better-sqlite3`, `node-cron`, `dotenv`, `zod`
   - Dev dependencies: `typescript`, `@types/node`, `@types/better-sqlite3`, `@types/qrcode-terminal`, `tsx`
2. Create `tsconfig.json`, `.env.example`, and `config/user_profile.json`.
3. Implement `src/db/database.ts` and verify that running a test script creates `./data/syncguard.db` with both tables.

### Phase 2: Google Calendar & Conflict Engine (Testable Standalone)
1. Implement `src/calendar/googleClient.ts` with a CLI helper script (`npm run auth:google`) that spins up a temporary localhost callback server to complete the OAuth2 login flow and save `./data/google_token.json`.
2. Implement `src/calendar/conflictEngine.ts` with functions:
   - `checkConflicts(startTime: string, endTime: string)`
   - `upsertCalendarEvent(eventData, conflictInfo)`
3. Create a test script `src/test-calendar.ts` that simulates two overlapping events and verifies that `checkConflicts` catches the overlap and colors the conflicting event red.

### Phase 3: AI Extractor & Relevance Engine (Testable Standalone)
1. Implement `src/ai/prompts.ts` and `src/ai/extractor.ts` with strict JSON schema validation using `zod`.
2. Create a test script `src/test-ai.ts` containing 3 realistic mock WhatsApp transcripts:
   - *Case 1:* A university notice containing viva dates for two different subgroups (verify only the user's subgroup is extracted).
   - *Case 2:* A chaotic 8-message friend group chat negotiating a batch picnic date and settling on Saturday at 9 AM.
   - *Case 3:* A project deadline announcement due "this Friday before 11:59 PM".
3. Run `npx tsx src/test-ai.ts` and verify the JSON outputs.

### Phase 4: WhatsApp Listener, Buffer & End-to-End Wiring
1. Implement `src/whatsapp/client.ts` and `src/whatsapp/notifier.ts`.
2. Implement `src/buffer/batchProcessor.ts` to bridge SQLite -> AI Extractor -> Conflict Engine -> WhatsApp Notifier.
3. Implement `src/index.ts` to start the WhatsApp client, start the 3-minute batch processor cron, and start the 7:30 AM daily agenda summary cron (which messages the user all events and deadlines for the next 7 days).

### Phase 5: Resilience & Production Polish
1. Add automatic reconnection handling in `client.ts` for Baileys (`DisconnectReason.loggedOut` vs network drops).
2. Add a simple WhatsApp command listener in the user's "Message Yourself" chat:
   - Typing `!today` replies with today's full schedule.
   - Typing `!week` replies with the next 7 days' schedule and any unresolved conflicts.
   - Typing `!groups` lists all WhatsApp groups with their JIDs so the user can easily whitelist/blacklist them.
`
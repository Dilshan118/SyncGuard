import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { env } from '../config';

export interface MessageBufferRecord {
  id: string;
  chat_jid: string;
  chat_name: string;
  sender_name: string;
  message_text: string;
  timestamp: number;
  processed: number; // 0 = unprocessed, 1 = processed
}

export interface SyncedEventRecord {
  id?: number;
  google_event_id: string;
  title: string;
  category: 'LECTURE' | 'VIVA' | 'DEADLINE' | 'MEETUP' | 'PICNIC' | 'OTHER';
  start_time: string; // ISO 8601
  end_time: string;   // ISO 8601
  start_ts?: number;  // UTC epoch milliseconds
  end_ts?: number;    // UTC epoch milliseconds
  source_chat_name: string;
  has_conflict: number; // 0 = false, 1 = true
  conflicting_with?: string | null; // JSON string array e.g. '["Lecture 1", "Meeting 2"]'
  created_at?: string;
}

let dbInstance: Database.Database | null = null;

/**
 * Initializes the SQLite database, creating tables and indexes if they do not exist.
 */
export function initDatabase(dbFilePath: string = env.DATABASE_PATH): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const resolvedPath = path.resolve(process.cwd(), dbFilePath);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);
  // Enable WAL mode for better concurrency and performance
  db.pragma('journal_mode = WAL');

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_buffer (
      id TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      chat_name TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      message_text TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      processed INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_msg_processed 
      ON message_buffer(processed, chat_jid);

    CREATE TABLE IF NOT EXISTS synced_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_event_id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      start_ts INTEGER,
      end_ts INTEGER,
      source_chat_name TEXT NOT NULL,
      has_conflict INTEGER DEFAULT 0,
      conflicting_with TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_events_start_time 
      ON synced_events(start_time);
  `);

  // Migration check: ensure start_ts and end_ts columns exist for existing databases
  try {
    const tableInfo = db.prepare("PRAGMA table_info(synced_events)").all() as Array<{ name: string }>;
    const columnNames = tableInfo.map(c => c.name);
    if (!columnNames.includes('start_ts')) {
      db.exec('ALTER TABLE synced_events ADD COLUMN start_ts INTEGER;');
    }
    if (!columnNames.includes('end_ts')) {
      db.exec('ALTER TABLE synced_events ADD COLUMN end_ts INTEGER;');
    }

    // Backfill any existing rows with missing timestamps
    const rowsWithoutTs = db.prepare('SELECT id, start_time, end_time FROM synced_events WHERE start_ts IS NULL').all() as Array<{ id: number; start_time: string; end_time: string }>;
    if (rowsWithoutTs.length > 0) {
      const updateStmt = db.prepare('UPDATE synced_events SET start_ts = ?, end_ts = ? WHERE id = ?');
      for (const row of rowsWithoutTs) {
        const sTs = new Date(row.start_time).getTime();
        const eTs = new Date(row.end_time).getTime();
        updateStmt.run(sTs, eTs, row.id);
      }
    }

    // Now safely create index on start_ts
    db.exec('CREATE INDEX IF NOT EXISTS idx_events_start_ts ON synced_events(start_ts);');
  } catch (migErr) {
    console.error('Migration notice for synced_events columns:', migErr);
  }

  dbInstance = db;
  return dbInstance;
}

/**
 * Returns the active database instance, initializing it if necessary.
 */
export function getDb(): Database.Database {
  if (!dbInstance) {
    return initDatabase();
  }
  return dbInstance;
}

/**
 * Closes the database connection.
 */
export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

// ======================== Message Buffer Operations ========================

/**
 * Inserts a new WhatsApp message into the message buffer.
 */
export function insertMessage(msg: {
  id: string;
  chat_jid: string;
  chat_name: string;
  sender_name: string;
  message_text: string;
  timestamp: number;
}): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO message_buffer (id, chat_jid, chat_name, sender_name, message_text, timestamp, processed)
    VALUES (@id, @chat_jid, @chat_name, @sender_name, @message_text, @timestamp, 0)
  `);
  stmt.run(msg);
}

/**
 * Fetches all unprocessed messages, optionally filtered by chat_jid.
 */
export function getUnprocessedMessages(chatJid?: string): MessageBufferRecord[] {
  const db = getDb();
  if (chatJid) {
    const stmt = db.prepare(`
      SELECT * FROM message_buffer 
      WHERE processed = 0 AND chat_jid = ? 
      ORDER BY timestamp ASC
    `);
    return stmt.all(chatJid) as MessageBufferRecord[];
  }

  const stmt = db.prepare(`
    SELECT * FROM message_buffer 
    WHERE processed = 0 
    ORDER BY timestamp ASC
  `);
  return stmt.all() as MessageBufferRecord[];
}

/**
 * Returns a list of chat JIDs with unprocessed message counts and latest message timestamp.
 */
export function getUnprocessedChatsSummary(): Array<{
  chat_jid: string;
  chat_name: string;
  unprocessed_count: number;
  latest_timestamp: number;
  oldest_timestamp: number;
}> {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT 
      chat_jid,
      chat_name,
      COUNT(*) AS unprocessed_count,
      MAX(timestamp) AS latest_timestamp,
      MIN(timestamp) AS oldest_timestamp
    FROM message_buffer
    WHERE processed = 0
    GROUP BY chat_jid, chat_name
  `);
  return stmt.all() as Array<{
    chat_jid: string;
    chat_name: string;
    unprocessed_count: number;
    latest_timestamp: number;
    oldest_timestamp: number;
  }>;
}

/**
 * Retrieves the last N already processed messages for a chat to provide context.
 */
export function getRecentProcessedMessages(chatJid: string, limit: number = 5): MessageBufferRecord[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM message_buffer
    WHERE processed = 1 AND chat_jid = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `);
  const rows = stmt.all(chatJid, limit) as MessageBufferRecord[];
  return rows.reverse(); // Return in chronological order
}

/**
 * Marks a list of message IDs as processed.
 */
export function markMessagesProcessed(messageIds: string[]): void {
  if (messageIds.length === 0) return;
  const db = getDb();
  const placeholders = messageIds.map(() => '?').join(',');
  const stmt = db.prepare(`
    UPDATE message_buffer 
    SET processed = 1 
    WHERE id IN (${placeholders})
  `);
  stmt.run(...messageIds);
}

/**
 * Deletes rows from message_buffer where chat_jid = ? AND processed = 1,
 * keeping only the newest keepRecentCount processed rows for that group as sliding-window context.
 * Returns the number of purged rows.
 */
export function purgeProcessedMessages(chatJid: string, keepRecentCount: number = 5): number {
  const db = getDb();
  const stmt = db.prepare(`
    DELETE FROM message_buffer
    WHERE chat_jid = ? AND processed = 1 AND id NOT IN (
      SELECT id FROM message_buffer
      WHERE chat_jid = ? AND processed = 1
      ORDER BY timestamp DESC
      LIMIT ?
    )
  `);
  const result = stmt.run(chatJid, chatJid, keepRecentCount);
  return result.changes;
}

// ======================== Synced Events Operations ========================

/**
 * Inserts a newly synced event into the ledger.
 */
export function insertSyncedEvent(event: Omit<SyncedEventRecord, 'id' | 'created_at'>): number {
  const db = getDb();
  const startTs = event.start_ts ?? new Date(event.start_time).getTime();
  const endTs = event.end_ts ?? new Date(event.end_time).getTime();

  const stmt = db.prepare(`
    INSERT INTO synced_events (
      google_event_id, title, category, start_time, end_time, start_ts, end_ts, source_chat_name, has_conflict, conflicting_with
    ) VALUES (
      @google_event_id, @title, @category, @start_time, @end_time, @start_ts, @end_ts, @source_chat_name, @has_conflict, @conflicting_with
    )
  `);
  const result = stmt.run({
    ...event,
    has_conflict: event.has_conflict ?? 0,
    conflicting_with: event.conflicting_with ?? null,
    start_ts: startTs,
    end_ts: endTs
  });
  return Number(result.lastInsertRowid);
}

/**
 * Updates an existing synced event in the ledger by google_event_id.
 */
export function updateSyncedEvent(
  googleEventId: string,
  event: Partial<Omit<SyncedEventRecord, 'id' | 'google_event_id' | 'created_at'>>
): boolean {
  const db = getDb();
  const fields: string[] = [];
  const values: Record<string, unknown> = { google_event_id: googleEventId };

  if (event.title !== undefined) {
    fields.push('title = @title');
    values.title = event.title;
  }
  if (event.category !== undefined) {
    fields.push('category = @category');
    values.category = event.category;
  }
  if (event.start_time !== undefined) {
    fields.push('start_time = @start_time', 'start_ts = @start_ts');
    values.start_time = event.start_time;
    values.start_ts = new Date(event.start_time).getTime();
  }
  if (event.end_time !== undefined) {
    fields.push('end_time = @end_time', 'end_ts = @end_ts');
    values.end_time = event.end_time;
    values.end_ts = new Date(event.end_time).getTime();
  }
  if (event.source_chat_name !== undefined) {
    fields.push('source_chat_name = @source_chat_name');
    values.source_chat_name = event.source_chat_name;
  }
  if (event.has_conflict !== undefined) {
    fields.push('has_conflict = @has_conflict');
    values.has_conflict = event.has_conflict;
  }
  if (event.conflicting_with !== undefined) {
    fields.push('conflicting_with = @conflicting_with');
    values.conflicting_with = event.conflicting_with;
  }

  if (fields.length === 0) return false;

  const stmt = db.prepare(`
    UPDATE synced_events 
    SET ${fields.join(', ')} 
    WHERE google_event_id = @google_event_id
  `);
  const res = stmt.run(values);
  return res.changes > 0;
}

/**
 * Retrieves a synced event by its Google Calendar Event ID.
 */
export function getSyncedEventByGoogleId(googleEventId: string): SyncedEventRecord | null {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM synced_events WHERE google_event_id = ?');
  const row = stmt.get(googleEventId);
  return (row as SyncedEventRecord) || null;
}

/**
 * Fetches upcoming synced events for the next N days (default: 14 days) from a given reference time.
 */
export function getUpcomingSyncedEvents(
  daysAhead: number = 14,
  referenceTimeIso?: string
): SyncedEventRecord[] {
  const db = getDb();
  const fromIso = referenceTimeIso || new Date().toISOString();
  const fromTs = new Date(fromIso).getTime();
  const toTs = fromTs + daysAhead * 24 * 60 * 60 * 1000;
  const toIso = new Date(toTs).toISOString();

  const stmt = db.prepare(`
    SELECT * FROM synced_events 
    WHERE (start_ts IS NOT NULL AND start_ts >= ? AND start_ts <= ?)
       OR (start_ts IS NULL AND start_time >= ? AND start_time <= ?)
    ORDER BY COALESCE(start_ts, 0) ASC, start_time ASC
  `);
  return stmt.all(fromTs, toTs, fromIso, toIso) as SyncedEventRecord[];
}

/**
 * Deletes all events and messages (useful for resetting/tests).
 */
export function clearAllTables(): void {
  const db = getDb();
  db.exec(`
    DELETE FROM message_buffer;
    DELETE FROM synced_events;
  `);
}

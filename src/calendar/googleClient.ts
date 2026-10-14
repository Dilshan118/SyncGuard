import fs from 'node:fs';
import path from 'node:path';
import { google, calendar_v3 } from 'googleapis';
import { env } from '../config';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly'
];

export interface ICalendarService {
  listEvents(params: calendar_v3.Params$Resource$Events$List): Promise<calendar_v3.Schema$Events>;
  insertEvent(params: calendar_v3.Params$Resource$Events$Insert): Promise<calendar_v3.Schema$Event>;
  updateEvent(params: calendar_v3.Params$Resource$Events$Update): Promise<calendar_v3.Schema$Event>;
  patchEvent(params: calendar_v3.Params$Resource$Events$Patch): Promise<calendar_v3.Schema$Event>;
  deleteEvent(params: calendar_v3.Params$Resource$Events$Delete): Promise<void>;
}

/**
 * Creates an OAuth2 client configured with environment variables
 */
export function getOAuth2Client() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return null;
  }

  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
}

/**
 * Checks if saved Google OAuth2 tokens exist
 */
export function hasSavedGoogleToken(tokenPath: string = env.GOOGLE_TOKEN_PATH): boolean {
  const resolved = path.resolve(process.cwd(), tokenPath);
  return fs.existsSync(resolved);
}

/**
 * Loads saved tokens from data/google_token.json and returns an authenticated Calendar client
 */
export function getCalendarClient(tokenPath: string = env.GOOGLE_TOKEN_PATH): calendar_v3.Calendar | null {
  const oauth2Client = getOAuth2Client();
  if (!oauth2Client) {
    return null;
  }

  const resolved = path.resolve(process.cwd(), tokenPath);
  if (!fs.existsSync(resolved)) {
    return null;
  }

  try {
    const tokenData = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
    oauth2Client.setCredentials(tokenData);

    // Persist refreshed OAuth2 tokens automatically
    oauth2Client.on('tokens', (refreshed) => {
      try {
        const merged = { ...tokenData, ...refreshed };
        saveGoogleTokens(merged, tokenPath);
      } catch (err) {
        console.error('Failed to auto-save refreshed Google tokens:', err);
      }
    });

    return google.calendar({ version: 'v3', auth: oauth2Client });
  } catch (err) {
    console.error(`Error loading Google tokens from ${resolved}:`, err);
    return null;
  }
}

/**
 * Automatically discovers or creates a dedicated secondary Google Calendar named "SyncGuard".
 * Returns the calendar ID (or 'primary' fallback).
 */
export async function getOrCreateSyncGuardCalendar(calendar: calendar_v3.Calendar): Promise<string> {
  try {
    const listRes = await calendar.calendarList.list();
    const existing = (listRes.data.items || []).find(
      c => c.summary === 'SyncGuard' && !c.deleted
    );

    if (existing && existing.id) {
      return existing.id;
    }

    // Create a new dedicated secondary calendar
    const created = await calendar.calendars.insert({
      requestBody: {
        summary: 'SyncGuard',
        description: 'University & Group Schedule Protection by SyncGuard AI',
        timeZone: 'Asia/Colombo'
      }
    });

    console.log(`📅 Created dedicated secondary Google Calendar: "SyncGuard" (${created.data.id})`);
    return created.data.id || 'primary';
  } catch (err: any) {
    console.warn(`Could not manage secondary calendar (${err.message}). Defaulting to primary.`);
    return 'primary';
  }
}

/**
 * Generates the OAuth2 URL for the user to authorize Google Calendar
 */
export function generateAuthUrl(): string {
  const oauth2Client = getOAuth2Client();
  if (!oauth2Client) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env to generate auth URL.');
  }

  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES
  });
}

/**
 * Saves given OAuth2 tokens to disk with 0600 file permissions (owner read/write only)
 */
export function saveGoogleTokens(tokens: any, tokenPath: string = env.GOOGLE_TOKEN_PATH): void {
  const resolved = path.resolve(process.cwd(), tokenPath);
  const dir = path.dirname(resolved);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(resolved, JSON.stringify(tokens, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

/**
 * In-memory Mock Calendar Service for testing and offline development
 */
export class MockCalendarService implements ICalendarService {
  private events: Map<string, calendar_v3.Schema$Event & { _calendarId?: string }> = new Map();
  private idCounter = 1;

  async listEvents(params: calendar_v3.Params$Resource$Events$List): Promise<calendar_v3.Schema$Events> {
    const timeMin = params.timeMin ? new Date(params.timeMin).getTime() : 0;
    const timeMax = params.timeMax ? new Date(params.timeMax).getTime() : Infinity;
    const targetCal = params.calendarId || 'primary';

    const items: calendar_v3.Schema$Event[] = [];
    for (const event of this.events.values()) {
      if (event._calendarId && event._calendarId !== targetCal) {
        continue;
      }

      const eventStart = event.start?.dateTime ? new Date(event.start.dateTime).getTime() : null;
      const eventEnd = event.end?.dateTime ? new Date(event.end.dateTime).getTime() : null;

      if (eventStart !== null && eventEnd !== null) {
        // Overlap query: event starts before timeMax AND ends after timeMin
        if (eventStart < timeMax && eventEnd > timeMin) {
          items.push(event);
        }
      }
    }

    // Sort chronologically
    items.sort((a, b) => {
      const aTime = new Date(a.start?.dateTime || 0).getTime();
      const bTime = new Date(b.start?.dateTime || 0).getTime();
      return aTime - bTime;
    });

    return { items };
  }

  async insertEvent(params: calendar_v3.Params$Resource$Events$Insert): Promise<calendar_v3.Schema$Event> {
    const id = `mock_event_${this.idCounter++}`;
    const newEvent: calendar_v3.Schema$Event & { _calendarId?: string } = {
      id,
      _calendarId: params.calendarId || 'primary',
      ...params.requestBody
    };
    this.events.set(id, newEvent);
    return newEvent;
  }

  async updateEvent(params: calendar_v3.Params$Resource$Events$Update): Promise<calendar_v3.Schema$Event> {
    const eventId = params.eventId;
    if (!eventId || !this.events.has(eventId)) {
      throw new Error(`Event with ID ${eventId} not found`);
    }
    const updated = {
      ...this.events.get(eventId),
      ...params.requestBody,
      id: eventId
    };
    this.events.set(eventId, updated);
    return updated;
  }

  async patchEvent(params: calendar_v3.Params$Resource$Events$Patch): Promise<calendar_v3.Schema$Event> {
    return this.updateEvent(params as any);
  }

  async deleteEvent(params: calendar_v3.Params$Resource$Events$Delete): Promise<void> {
    const eventId = params.eventId;
    if (eventId) {
      this.events.delete(eventId);
    }
  }

  // Helper for test setups
  clear(): void {
    this.events.clear();
    this.idCounter = 1;
  }

  getAllEvents(): calendar_v3.Schema$Event[] {
    return Array.from(this.events.values());
  }
}

/**
 * Real Google Calendar API Adapter implementing ICalendarService
 */
export class GoogleCalendarServiceAdapter implements ICalendarService {
  constructor(private calendar: calendar_v3.Calendar) {}

  async listEvents(params: calendar_v3.Params$Resource$Events$List): Promise<calendar_v3.Schema$Events> {
    const res = await this.calendar.events.list(params);
    return res.data;
  }

  async insertEvent(params: calendar_v3.Params$Resource$Events$Insert): Promise<calendar_v3.Schema$Event> {
    const res = await this.calendar.events.insert(params);
    return res.data;
  }

  async updateEvent(params: calendar_v3.Params$Resource$Events$Update): Promise<calendar_v3.Schema$Event> {
    const res = await this.calendar.events.update(params);
    return res.data;
  }

  async patchEvent(params: calendar_v3.Params$Resource$Events$Patch): Promise<calendar_v3.Schema$Event> {
    const res = await this.calendar.events.patch(params);
    return res.data;
  }

  async deleteEvent(params: calendar_v3.Params$Resource$Events$Delete): Promise<void> {
    await this.calendar.events.delete(params);
  }
}

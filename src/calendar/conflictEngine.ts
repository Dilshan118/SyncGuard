import { calendar_v3 } from 'googleapis';
import { env, loadUserProfile } from '../config';
import {
  ICalendarService,
  getCalendarClient,
  GoogleCalendarServiceAdapter,
  MockCalendarService
} from './googleClient';
export { ICalendarService };
import {
  insertSyncedEvent,
  updateSyncedEvent,
  getSyncedEventByGoogleId
} from '../db/database';

export type EventCategory = 'LECTURE' | 'VIVA' | 'DEADLINE' | 'MEETUP' | 'PICNIC' | 'OTHER';

export interface ExtractedScheduleItem {
  action: 'CREATE' | 'UPDATE' | 'IGNORE';
  target_google_event_id?: string | null;
  title: string;
  category: EventCategory;
  is_time_blocked: boolean;
  start_time: string; // ISO 8601
  end_time: string;   // ISO 8601
  location?: string;
  description?: string;
  confidence_score: number;
  reasoning: string;
  source_chat_name?: string;
}

export interface ConflictingEventDetail {
  id: string;
  title: string;
  start: string;
  end: string;
}

export interface ConflictCheckResult {
  hasConflict: boolean;
  conflictingEvents: ConflictingEventDetail[];
}

export interface UpsertResult {
  googleEventId: string;
  title: string;
  startTime: string;
  endTime: string;
  colorId: string;
  hasConflict: boolean;
  conflictingWith: ConflictingEventDetail[];
  actionTaken: 'CREATED' | 'UPDATED' | 'IGNORED';
  sourceChatName: string;
  category: EventCategory;
  location?: string;
  description?: string;
}

// Color ID mapping based on specification
export const COLOR_IDS = {
  LECTURE: '9',   // Blueberry / Blue
  VIVA: '3',      // Grape / Purple
  MEETUP: '5',    // Banana / Yellow
  PICNIC: '5',    // Banana / Yellow
  DEADLINE: '6',  // Tangerine / Orange
  OTHER: '9',     // Blueberry / Blue
  CONFLICT: '11'  // Tomato / Bright Red
} as const;

// Shared fallback mock service when running in offline/testing mode without real Google credentials
let defaultMockService: MockCalendarService | null = null;

export function getDefaultCalendarService(): ICalendarService {
  const realClient = getCalendarClient();
  if (realClient) {
    return new GoogleCalendarServiceAdapter(realClient);
  }

  if (!defaultMockService) {
    defaultMockService = new MockCalendarService();
  }
  return defaultMockService;
}

let activeCalendarId: string = env.GOOGLE_CALENDAR_ID || 'primary';

export function setActiveCalendarId(id: string): void {
  activeCalendarId = id;
}

export function getActiveCalendarId(): string {
  return activeCalendarId;
}

/**
 * Resets the fallback mock service (useful for test isolation)
 */
export function resetMockCalendarService(): MockCalendarService {
  defaultMockService = new MockCalendarService();
  return defaultMockService;
}

/**
 * Checks Google Calendar for conflicting busy events overlapping [startTime, endTime].
 * All-day events and transparent (free) events are ignored.
 */
export async function checkConflicts(
  startTime: string,
  endTime: string,
  isTimeBlocked: boolean = true,
  excludeEventId?: string | null,
  calendarService: ICalendarService = getDefaultCalendarService(),
  calendarId: string = getActiveCalendarId()
): Promise<ConflictCheckResult> {
  // If event is not time-blocked (e.g. deadline), it never produces a daytime schedule clash
  if (!isTimeBlocked) {
    return { hasConflict: false, conflictingEvents: [] };
  }

  const requestedStart = new Date(startTime).getTime();
  const requestedEnd = new Date(endTime).getTime();

  // Multi-calendar check: query both the target calendar and 'primary'
  const targetCalendars = Array.from(new Set([calendarId, 'primary']));
  const conflictingEvents: ConflictingEventDetail[] = [];
  const seenEventIds = new Set<string>();

  for (const cId of targetCalendars) {
    try {
      const response = await calendarService.listEvents({
        calendarId: cId,
        timeMin: new Date(startTime).toISOString(),
        timeMax: new Date(endTime).toISOString(),
        singleEvents: true,
        orderBy: 'startTime'
      });

      const items = response.items || [];
      for (const item of items) {
        if (!item.id || seenEventIds.has(item.id)) {
          continue;
        }
        seenEventIds.add(item.id);

        // Exclude the event being updated
        if (excludeEventId && item.id === excludeEventId) {
          continue;
        }

        // Ignore transparent (free) events
        if (item.transparency === 'transparent') {
          continue;
        }

        // All-day banner events have date only (e.g. { date: '2026-10-20' }) without dateTime
        const itemStartDateTime = item.start?.dateTime;
        const itemEndDateTime = item.end?.dateTime;
        if (!itemStartDateTime || !itemEndDateTime) {
          // Ignored per spec: "Filter out all-day banner events"
          continue;
        }

        const itemStart = new Date(itemStartDateTime).getTime();
        const itemEnd = new Date(itemEndDateTime).getTime();

        // Check overlap: itemStart < requestedEnd && itemEnd > requestedStart
        if (itemStart < requestedEnd && itemEnd > requestedStart) {
          conflictingEvents.push({
            id: item.id || 'unknown',
            title: item.summary || 'Untitled Event',
            start: itemStartDateTime,
            end: itemEndDateTime
          });
        }
      }
    } catch {
      // Gracefully continue if secondary calendar query is unsupported by mock or offline
    }
  }

  return {
    hasConflict: conflictingEvents.length > 0,
    conflictingEvents
  };
}

/**
 * Inserts or updates an event in Google Calendar, applying proper colors, conflict banners,
 * descriptions, and reminder popups. Also records in the SQLite synced_events ledger.
 */
export async function upsertCalendarEvent(
  item: ExtractedScheduleItem,
  conflictCheck?: ConflictCheckResult,
  calendarService: ICalendarService = getDefaultCalendarService(),
  calendarId: string = getActiveCalendarId()
): Promise<UpsertResult> {
  if (item.action === 'IGNORE') {
    return {
      googleEventId: '',
      title: item.title,
      startTime: item.start_time,
      endTime: item.end_time,
      colorId: '',
      hasConflict: false,
      conflictingWith: [],
      actionTaken: 'IGNORED',
      sourceChatName: item.source_chat_name || 'Unknown Chat',
      category: item.category
    };
  }

  // Determine conflicts if not already provided
  const conflicts = conflictCheck || (await checkConflicts(
    item.start_time,
    item.end_time,
    item.is_time_blocked,
    item.target_google_event_id,
    calendarService,
    calendarId
  ));

  const hasConflict = conflicts.hasConflict;
  const userProfile = loadUserProfile();
  const timezone = userProfile.timezone || 'Asia/Colombo';

  // Format event title with conflict prefix if clash detected
  let finalTitle = item.title;
  if (hasConflict) {
    if (!finalTitle.startsWith('⚠️ [CONFLICT]')) {
      finalTitle = `⚠️ [CONFLICT] ${finalTitle}`;
    }
  } else {
    // If it was previously marked as conflict and is now resolved, strip prefix
    finalTitle = finalTitle.replace(/^⚠️\s*\[CONFLICT\]\s*/i, '');
  }

  // Determine color ID
  let colorId: string;
  if (hasConflict) {
    colorId = COLOR_IDS.CONFLICT; // '11' Tomato / Red
  } else {
    colorId = COLOR_IDS[item.category] || COLOR_IDS.OTHER;
  }

  // Format description
  let finalDescription = item.description || '';
  if (hasConflict && conflicts.conflictingEvents.length > 0) {
    const conflictLines = conflicts.conflictingEvents
      .map(c => `• ${c.title} (${c.start} - ${c.end})`)
      .join('\n');

    finalDescription = `${finalDescription}\n\n⚠️ SCHEDULE CONFLICT DETECTED:\nThis event clashes with your existing schedule:\n${conflictLines}\n\n(Added automatically by SyncGuard for early rescheduling)`.trim();
  }

  // Set reminders
  // Deadlines: 48h (2880m), 24h (1440m), 60m
  // Regular events: 24h (1440m), 60m
  const reminders = item.category === 'DEADLINE'
    ? [
        { method: 'popup', minutes: 2880 },
        { method: 'popup', minutes: 1440 },
        { method: 'popup', minutes: 60 }
      ]
    : [
        { method: 'popup', minutes: 1440 },
        { method: 'popup', minutes: 60 }
      ];

  const isDeadline = item.category === 'DEADLINE' || !item.is_time_blocked;

  const eventPayload: calendar_v3.Schema$Event = {
    summary: finalTitle,
    location: item.location || undefined,
    description: finalDescription,
    colorId,
    transparency: isDeadline ? 'transparent' : 'opaque',
    extendedProperties: {
      private: {
        syncguard: '1',
        category: item.category,
        sourceChat: item.source_chat_name || 'WhatsApp',
        isDeadline: isDeadline ? '1' : '0'
      }
    },
    start: {
      dateTime: item.start_time,
      timeZone: timezone
    },
    end: {
      dateTime: item.end_time,
      timeZone: timezone
    },
    reminders: {
      useDefault: false,
      overrides: reminders
    }
  };

  let googleEventId: string;
  let actionTaken: 'CREATED' | 'UPDATED';

  // SEC-01: Ownership & Ledger Verification before UPDATE
  // Verify that target_google_event_id is present in the local synced_events ledger
  // to ensure SyncGuard never patches or mutates arbitrary user events it did not create.
  let isVerifiedOwnedEvent = false;
  if (item.action === 'UPDATE' && item.target_google_event_id) {
    const existingLedgerRecord = getSyncedEventByGoogleId(item.target_google_event_id);
    if (existingLedgerRecord) {
      isVerifiedOwnedEvent = true;
    } else {
      console.warn(
        `🛡️ Security Guard: Attempted UPDATE on untracked event ID "${item.target_google_event_id}". Rejecting patch and creating a fresh SyncGuard-owned event.`
      );
    }
  }

  if (isVerifiedOwnedEvent && item.target_google_event_id) {
    googleEventId = item.target_google_event_id;
    await calendarService.patchEvent({
      calendarId,
      eventId: googleEventId,
      requestBody: eventPayload
    });
    actionTaken = 'UPDATED';

    // Update SQLite ledger
    updateSyncedEvent(googleEventId, {
      title: finalTitle,
      category: item.category,
      start_time: item.start_time,
      end_time: item.end_time,
      source_chat_name: item.source_chat_name || 'WhatsApp',
      has_conflict: hasConflict ? 1 : 0,
      conflicting_with: hasConflict ? JSON.stringify(conflicts.conflictingEvents.map(e => e.title)) : null
    });
  } else {
    // CREATE new event
    const created = await calendarService.insertEvent({
      calendarId,
      requestBody: eventPayload
    });

    googleEventId = created.id || `syncguard_${Date.now()}`;
    actionTaken = 'CREATED';

    // Insert into SQLite ledger
    insertSyncedEvent({
      google_event_id: googleEventId,
      title: finalTitle,
      category: item.category,
      start_time: item.start_time,
      end_time: item.end_time,
      source_chat_name: item.source_chat_name || 'WhatsApp',
      has_conflict: hasConflict ? 1 : 0,
      conflicting_with: hasConflict ? JSON.stringify(conflicts.conflictingEvents.map(e => e.title)) : null
    });
  }

  return {
    googleEventId,
    title: finalTitle,
    startTime: item.start_time,
    endTime: item.end_time,
    colorId,
    hasConflict,
    conflictingWith: conflicts.conflictingEvents,
    actionTaken,
    sourceChatName: item.source_chat_name || 'WhatsApp',
    category: item.category,
    location: item.location,
    description: finalDescription
  };
}

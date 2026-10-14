import { WASocket } from '@whiskeysockets/baileys';
import { normalizeJid } from './privacyFilter';
import { UpsertResult, ConflictingEventDetail } from '../calendar/conflictEngine';
import { SyncedEventRecord } from '../db/database';

/**
 * Formats ISO date times into readable local time strings in given timezone
 */
export function formatTimeInTimezone(
  isoString: string,
  timezone: string = 'Asia/Colombo'
): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZone: timezone
    });
  } catch {
    return isoString;
  }
}

export function formatDateInTimezone(
  isoString: string,
  timezone: string = 'Asia/Colombo'
): string {
  try {
    const d = new Date(isoString);
    return d.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      timeZone: timezone
    });
  } catch {
    return isoString;
  }
}

/**
 * Hard-locked outbound sender that physically prevents sending messages
 * to anyone other than the authenticated user's own JID.
 */
export async function sendSecureSelfMessage(
  sock: WASocket | any,
  targetJid: string,
  selfJid: string,
  messageContent: { text: string }
): Promise<void> {
  const normalizedTarget = normalizeJid(targetJid);
  const normalizedSelf = normalizeJid(selfJid);

  // HARD SECURITY GATE: Block any message targeted outside the user's own self JID or to groups
  if (!normalizedTarget || !normalizedSelf || normalizedTarget !== normalizedSelf || targetJid.endsWith('@g.us')) {
    console.error(`🚨 SECURITY BLOCK: Outbound message blocked. Target JID: "${targetJid}", Self JID: "${selfJid}"`);
    throw new Error("SECURITY BLOCK: Outbound messages are strictly locked to the user's own JID.");
  }

  // Target JID must be the self JID
  await sock.sendMessage(normalizedSelf, messageContent);
}

/**
 * Sends a conflict alert to the user's "Message Yourself" chat
 */
export async function sendConflictAlert(
  sock: WASocket | any,
  selfJid: string,
  event: UpsertResult,
  timezone: string = 'Asia/Colombo'
): Promise<void> {
  const cleanTitle = event.title.replace(/^⚠️\s*\[CONFLICT\]\s*/i, '');
  const startFmt = formatTimeInTimezone(event.startTime, timezone);
  const endFmt = formatTimeInTimezone(event.endTime, timezone);
  const dateFmt = formatDateInTimezone(event.startTime, timezone);

  const clashLines = event.conflictingWith.map((c: ConflictingEventDetail) => {
    const cStart = formatTimeInTimezone(c.start, timezone);
    const cEnd = formatTimeInTimezone(c.end, timezone);
    return `• *${c.title}* (${cStart} - ${cEnd})`;
  }).join('\n');

  const text = `🚨 *SCHEDULE CONFLICT DETECTED* 🚨

A new event from *${event.sourceChatName}* clashes with your existing schedule!

📌 *New Event:* ${cleanTitle}
📅 *Date:* ${dateFmt}
🕒 *Time:* ${startFmt} - ${endFmt}
📍 *Location:* ${event.location || 'Unknown'}

⚡ *Clashes With:*
${clashLines || '• Conflicting event in Google Calendar'}

_I have added this to your Google Calendar in RED (⚠️ [CONFLICT]) so you can rearrange one of them in advance._`;

  await sendSecureSelfMessage(sock, selfJid, selfJid, { text });
}

/**
 * Sends a clean confirmation to the user's "Message Yourself" chat
 */
export async function sendCleanEventConfirmation(
  sock: WASocket | any,
  selfJid: string,
  event: UpsertResult,
  timezone: string = 'Asia/Colombo'
): Promise<void> {
  const startFmt = formatTimeInTimezone(event.startTime, timezone);
  const endFmt = formatTimeInTimezone(event.endTime, timezone);
  const dateFmt = formatDateInTimezone(event.startTime, timezone);

  const isUpdate = event.actionTaken === 'UPDATED';
  const header = isUpdate ? `🔄 *Event Updated from WhatsApp*` : `✅ *Auto-Scheduled from WhatsApp*`;

  const text = `${header}
📅 *${event.title}* (${event.category})
📆 Date: ${dateFmt}
🕒 Time: ${startFmt} - ${endFmt}
📍 Location: ${event.location || 'Unknown'}
💬 Source: _${event.sourceChatName}_
🟢 Status: *No Conflicts*`;

  await sendSecureSelfMessage(sock, selfJid, selfJid, { text });
}

/**
 * Sends a formatted daily morning briefing of all events and deadlines for today
 */
export async function sendDailyBriefing(
  sock: WASocket | any,
  selfJid: string,
  events: SyncedEventRecord[],
  timezone: string = 'Asia/Colombo',
  userGivenName: string = 'Alex'
): Promise<void> {
  const todayStr = formatDateInTimezone(new Date().toISOString(), timezone);

  if (events.length === 0) {
    const text = `☀️ *Good Morning, ${userGivenName}!*
📅 *${todayStr}*

🎉 You have *no scheduled events or deadlines* for today.
Enjoy your free time!`;
    await sendSecureSelfMessage(sock, selfJid, selfJid, { text });
    return;
  }

  const timeBlockedEvents = events.filter(e => e.category !== 'DEADLINE');
  const deadlines = events.filter(e => e.category === 'DEADLINE');

  let text = `☀️ *Good Morning, ${userGivenName}! Here is your schedule for today:*
📅 *${todayStr}*\n\n`;

  if (timeBlockedEvents.length > 0) {
    text += `📌 *Today's Schedule:*\n`;
    for (const ev of timeBlockedEvents) {
      const startFmt = formatTimeInTimezone(ev.start_time, timezone);
      const endFmt = formatTimeInTimezone(ev.end_time, timezone);
      const conflictTag = ev.has_conflict ? ' ⚠️ [CONFLICT]' : '';
      text += `• [${startFmt} - ${endFmt}] *${ev.title}* (${ev.category})${conflictTag}\n`;
    }
    text += `\n`;
  }

  if (deadlines.length > 0) {
    text += `⏰ *Deadlines Due Today:*\n`;
    for (const d of deadlines) {
      const dueFmt = formatTimeInTimezone(d.end_time, timezone);
      text += `• 🔴 *${d.title}* — Due by ${dueFmt}\n`;
    }
    text += `\n`;
  }

  text += `_Have a productive day!_`;

  await sendSecureSelfMessage(sock, selfJid, selfJid, { text });
}

/**
 * Sends agenda summary in response to self commands like !today or !week
 */
export async function sendCommandReply(
  sock: WASocket | any,
  selfJid: string,
  replyText: string
): Promise<void> {
  await sendSecureSelfMessage(sock, selfJid, selfJid, { text: replyText });
}

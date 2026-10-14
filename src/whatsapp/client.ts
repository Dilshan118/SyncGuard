import path from 'node:path';
import fs from 'node:fs';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  proto
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import { env, loadUserProfile } from '../config';
import {
  normalizeJid,
  evaluateIncomingMessage,
  redactSensitiveInfo
} from './privacyFilter';
import {
  sendCommandReply,
  formatTimeInTimezone,
  formatDateInTimezone
} from './notifier';
import {
  insertMessage,
  getUpcomingSyncedEvents
} from '../db/database';
import { extractScheduleFromChat } from '../ai/extractor';
import {
  getDefaultCalendarService,
  upsertCalendarEvent
} from '../calendar/conflictEngine';

let activeSock: WASocket | null = null;
let selfJid: string = '';
const groupMetadataCache = new Map<string, string>(); // jid -> group subject/name

/**
 * Returns the currently active WhatsApp socket instance
 */
export function getWhatsAppSocket(): WASocket | null {
  return activeSock;
}

/**
 * Returns the connected self JID
 */
export function getConnectedSelfJid(): string {
  return selfJid;
}

/**
 * Extracts plain text or caption from a WhatsApp message object
 */
export function extractMessageText(message?: proto.IMessage | null): string {
  if (!message) return '';

  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    ''
  );
}

/**
 * Populates or refreshes the group metadata cache for group whitelisting
 */
export async function refreshGroupMetadata(sock: WASocket): Promise<void> {
  try {
    const groups = await sock.groupFetchAllParticipating();
    for (const [jid, metadata] of Object.entries(groups)) {
      groupMetadataCache.set(jid, metadata.subject);
    }
  } catch (err) {
    // Silent fail in case of offline / limited permissions
  }
}

/**
 * Handles self commands sent in the user's "Message Yourself" chat
 */
export async function handleSelfCommand(
  sock: WASocket,
  commandStr: string,
  userSelfJid: string
): Promise<void> {
  const parts = commandStr.trim().split(/\s+/);
  const rootCommand = parts[0].toLowerCase();
  const userProfile = loadUserProfile();
  const timezone = userProfile.timezone || 'Asia/Colombo';

  if (rootCommand === '!today') {
    const today = new Date();
    const startOfDayTs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    const endOfDayTs = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999).getTime();

    const startOfDayIso = new Date(startOfDayTs).toISOString();
    const upcoming = getUpcomingSyncedEvents(2, startOfDayIso);
    const todayEvents = upcoming.filter(e => {
      const ts = e.start_ts ?? new Date(e.start_time).getTime();
      return ts >= startOfDayTs && ts <= endOfDayTs;
    });

    if (todayEvents.length === 0) {
      await sendCommandReply(
        sock,
        userSelfJid,
        `📅 *Today's Schedule (${formatDateInTimezone(startOfDayIso, timezone)})*\n\n🎉 No scheduled events or deadlines today!`
      );
      return;
    }

    let reply = `📅 *Today's Schedule (${formatDateInTimezone(startOfDayIso, timezone)})*\n\n`;
    for (const ev of todayEvents) {
      const startFmt = formatTimeInTimezone(ev.start_time, timezone);
      const endFmt = formatTimeInTimezone(ev.end_time, timezone);
      const tag = ev.has_conflict ? ' ⚠️ *[CONFLICT]*' : '';
      const icon = ev.category === 'DEADLINE' ? '⏰' : '📌';
      reply += `${icon} [${startFmt} - ${endFmt}] *${ev.title}* (${ev.category})${tag}\n`;
    }

    await sendCommandReply(sock, userSelfJid, reply.trim());
    return;
  }

  if (rootCommand === '!week') {
    const upcoming = getUpcomingSyncedEvents(7);
    if (upcoming.length === 0) {
      await sendCommandReply(
        sock,
        userSelfJid,
        `📆 *Upcoming 7 Days Schedule*\n\n🎉 No events scheduled in your ledger for the next 7 days!`
      );
      return;
    }

    let reply = `📆 *Upcoming 7 Days Schedule:*\n\n`;
    let currentDayStr = '';

    for (const ev of upcoming) {
      const dayStr = formatDateInTimezone(ev.start_time, timezone);
      if (dayStr !== currentDayStr) {
        currentDayStr = dayStr;
        reply += `\n🗓️ *${dayStr}*\n`;
      }

      const startFmt = formatTimeInTimezone(ev.start_time, timezone);
      const endFmt = formatTimeInTimezone(ev.end_time, timezone);
      const conflictTag = ev.has_conflict ? ' ⚠️ *[CONFLICT]*' : '';
      const icon = ev.category === 'DEADLINE' ? '⏰' : '•';
      reply += `  ${icon} [${startFmt} - ${endFmt}] *${ev.title}* (${ev.category})${conflictTag}\n`;
    }

    await sendCommandReply(sock, userSelfJid, reply.trim());
    return;
  }

  if (rootCommand === '!groups') {
    await refreshGroupMetadata(sock);
    if (groupMetadataCache.size === 0) {
      await sendCommandReply(
        sock,
        userSelfJid,
        'ℹ️ No participating groups found or metadata still syncing.'
      );
      return;
    }

    let reply = `📋 *Participating WhatsApp Groups (${groupMetadataCache.size}):*\n\n`;
    reply += `_Copy and paste these names into your \`config/user_profile.json\` whitelistedGroupNames:_\n\n`;

    for (const [jid, name] of groupMetadataCache.entries()) {
      reply += `• *${name}*\n  ID: \`${jid}\`\n`;
    }

    await sendCommandReply(sock, userSelfJid, reply.trim());
    return;
  }

  if (rootCommand === '!parse' || rootCommand === '!add') {
    const rawNotice = commandStr.replace(/^[!\/](?:parse|add)\s*/i, '').trim();
    if (!rawNotice) {
      await sendCommandReply(
        sock,
        userSelfJid,
        'ℹ️ *How to parse any past message or notice:*\n\nSend: `!parse <paste the announcement or notice here>`\n\nSyncGuard will extract future vivas, classes, and deadlines, check for conflicts, and schedule them directly on your Google Calendar!'
      );
      return;
    }

    await sendCommandReply(sock, userSelfJid, '⏳ *SyncGuard AI is analyzing your notice...*');

    try {
      const existingEvents = getUpcomingSyncedEvents(14);
      const aiResponse = await extractScheduleFromChat({
        chatName: 'Manual Ingestion (Self-Chat)',
        referenceTimeIso: new Date().toISOString(),
        timezone,
        userProfile,
        existingEvents,
        messages: [{ sender: 'Manual User Input', text: rawNotice, timestamp: Date.now() }]
      });

      if (aiResponse.extracted_items.length === 0) {
        await sendCommandReply(
          sock,
          userSelfJid,
          `ℹ️ No upcoming events or deadlines matching your profile (${userProfile.universityProfile.batchGroup}) were found in that message.`
        );
        return;
      }

      const calendarService = getDefaultCalendarService();
      let reply = `✅ *Extracted & Synced ${aiResponse.extracted_items.length} Event(s) to Google Calendar:*\n\n`;

      for (const item of aiResponse.extracted_items) {
        item.source_chat_name = 'Manual Ingestion';
        const upsertResult = await upsertCalendarEvent(item, undefined, calendarService);
        const startFmt = formatTimeInTimezone(upsertResult.startTime, timezone);
        const endFmt = formatTimeInTimezone(upsertResult.endTime, timezone);
        const dateFmt = formatDateInTimezone(upsertResult.startTime, timezone);
        const conflictTag = upsertResult.hasConflict ? ' ⚠️ *[CONFLICT DETECTED]*' : '';

        reply += `📌 *${upsertResult.title}*\n`;
        reply += `   🗓️ ${dateFmt} (${startFmt} - ${endFmt})\n`;
        reply += `   🏷️ Category: ${upsertResult.category}${conflictTag}\n`;
        reply += `   📍 Venue: ${item.location || 'SLIIT'}\n\n`;
      }

      await sendCommandReply(sock, userSelfJid, reply.trim());
    } catch (err: any) {
      console.error('Failed to parse manual notice:', err);
      await sendCommandReply(sock, userSelfJid, `❌ Failed to extract schedule: ${err.message}`);
    }
    return;
  }

  // Default Help
  const helpText = `🤖 *SyncGuard Assistant Commands:*

• *!today* — View all events and deadlines scheduled for today
• *!week* — View full schedule and conflicts for the next 7 days
• *!groups* — List all group names and JIDs to configure your whitelist
• *!parse <text>* — Paste ANY past message or announcement to extract & add it to your calendar

_All personal 1-on-1 chats remain 100% blocked by the privacy firewall._`;

  await sendCommandReply(sock, userSelfJid, helpText);
}

/**
 * Initializes and connects the WhatsApp client using Baileys with stealth options
 */
export async function startWhatsAppClient(
  onReady?: (sock: WASocket, selfJid: string) => void
): Promise<WASocket> {
  const authPath = path.resolve(process.cwd(), env.AUTH_INFO_PATH);
  if (!fs.existsSync(authPath)) {
    fs.mkdirSync(authPath, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  // Stealth Logger: never dump raw WhatsApp packets or decrypted chat contents
  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    markOnlineOnConnect: false, // Stealth Mode: Never show user as "Online" 24/7
    syncFullHistory: false,     // Never download old personal chat history
    generateHighQualityLinkPreview: false
  });

  activeSock = sock;

  // Credential updates
  sock.ev.on('creds.update', saveCreds);

  // Connection handling
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n====================================================');
      console.log('📱 Scan this QR code with WhatsApp (Linked Devices):');
      console.log('====================================================\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

      console.log(`🔌 WhatsApp connection closed (Status: ${statusCode}). Logged out: ${isLoggedOut}`);

      if (isLoggedOut) {
        console.warn('⚠️ Logged out from WhatsApp session.');
        console.log('🧹 Purging stale session in data/auth_info_baileys and generating a fresh QR code...');
        try {
          if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true });
          }
        } catch (rmErr) {
          console.error('Failed to remove stale auth directory:', rmErr);
        }

        setTimeout(() => {
          startWhatsAppClient(onReady).catch((err) => {
            console.error('Failed to restart WhatsApp client after logout:', err);
          });
        }, 1500);
      } else {
        // Normal network disconnect, attempt reconnect
        setTimeout(() => {
          startWhatsAppClient(onReady).catch((err) => {
            console.error('Failed to reconnect WhatsApp socket:', err);
          });
        }, 3000);
      }
    } else if (connection === 'open') {
      selfJid = normalizeJid(sock.user?.id || '');
      console.log(`✅ WhatsApp Client Connected! User JID: ${selfJid}`);
      console.log('🛡️ Stealth Mode Active: Online status disabled, zero read receipts.');

      // Cache group metadata
      await refreshGroupMetadata(sock);
      console.log(`📋 Cached ${groupMetadataCache.size} participating groups for whitelist verification.`);

      if (onReady) {
        onReady(sock, selfJid);
      }
    }
  });

  // Passive message listener with strict privacy firewall
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Only process incoming/new messages
    if (type !== 'notify' && type !== 'append') return;

    for (const msg of messages) {
      const remoteJid = msg.key.remoteJid;
      if (!remoteJid || !msg.message) continue;

      const fromMe = !!msg.key.fromMe;
      const text = extractMessageText(msg.message);
      if (!text.trim()) continue;

      // Group name lookup
      const groupName = groupMetadataCache.get(remoteJid) || undefined;

      // Gatekeeper: Evaluate privacy rules in memory
      const evaluation = evaluateIncomingMessage({
        remoteJid,
        selfJid,
        groupName,
        text,
        fromMe
      });

      // Handle self commands
      if (evaluation.isSelfCommand && evaluation.command) {
        await handleSelfCommand(sock, evaluation.command, selfJid);
        continue;
      }

      // If message is blocked by privacy rules (e.g. personal DM or non-whitelisted group), silently drop it
      if (!evaluation.allowed) {
        continue;
      }

      // Allowed whitelisted group message: Redact PII before buffering
      const sanitizedText = redactSensitiveInfo(text);
      const senderName = msg.pushName || 'Unknown Sender';
      const msgId = msg.key.id || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const timestamp = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now();

      insertMessage({
        id: msgId,
        chat_jid: remoteJid,
        chat_name: groupName || 'Whitelisted Group',
        sender_name: senderName,
        message_text: sanitizedText,
        timestamp
      });
    }
  });

  return sock;
}

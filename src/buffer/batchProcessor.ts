import { WASocket } from '@whiskeysockets/baileys';
import { loadUserProfile } from '../config';
import {
  getUnprocessedChatsSummary,
  getUnprocessedMessages,
  getRecentProcessedMessages,
  markMessagesProcessed,
  purgeProcessedMessages,
  getUpcomingSyncedEvents
} from '../db/database';
import { extractScheduleFromChat } from '../ai/extractor';
import { PromptContext } from '../ai/prompts';
import {
  upsertCalendarEvent,
  getDefaultCalendarService,
  ICalendarService
} from '../calendar/conflictEngine';
import {
  sendConflictAlert,
  sendCleanEventConfirmation
} from '../whatsapp/notifier';
import { getWhatsAppSocket, getConnectedSelfJid } from '../whatsapp/client';

let isBatchRunning = false;

export interface BatchProcessOptions {
  sock?: WASocket | null;
  selfJid?: string;
  calendarService?: ICalendarService;
  forceProcessAll?: boolean; // Bypass the 2-minute conversation settling wait (useful for tests / manual triggers)
}

/**
 * Evaluates pending message buffers across all whitelisted chats,
 * extracts actionable schedule items with AI, checks Google Calendar for conflicts,
 * and sends proactive self-alerts.
 */
export async function processChatBuffer(
  options: BatchProcessOptions = {}
): Promise<{ processedChats: number; itemsSynced: number }> {
  if (isBatchRunning) {
    console.log('⏳ Batch processor already running, skipping overlapping tick.');
    return { processedChats: 0, itemsSynced: 0 };
  }

  isBatchRunning = true;
  let processedChats = 0;
  let itemsSynced = 0;

  try {
    const userProfile = loadUserProfile();
    const chatSummaries = getUnprocessedChatsSummary();

    if (chatSummaries.length === 0) {
      return { processedChats: 0, itemsSynced: 0 };
    }

    const now = Date.now();
    const SETTLE_DELAY_MS = 2 * 60 * 1000; // 2 minutes
    const MAX_UNPROCESSED_BURST = 20;

    const sock = options.sock ?? getWhatsAppSocket();
    const selfJid = options.selfJid || getConnectedSelfJid();
    const calendarService = options.calendarService || getDefaultCalendarService();

    for (const chat of chatSummaries) {
      const timeSinceLastMessage = now - chat.latest_timestamp;
      const isSettled = timeSinceLastMessage >= SETTLE_DELAY_MS;
      const isBurst = chat.unprocessed_count >= MAX_UNPROCESSED_BURST;

      // Only process when conversation has settled OR reached 20 unread burst messages
      if (!options.forceProcessAll && !isSettled && !isBurst) {
        continue;
      }

      console.log(`\n🤖 Processing buffer for "${chat.chat_name}" (${chat.unprocessed_count} messages)...`);

      // 1. Fetch unprocessed messages for this chat
      const unprocessedMessages = getUnprocessedMessages(chat.chat_jid);
      if (unprocessedMessages.length === 0) continue;

      // 2. Fetch last 5 processed messages as conversation history context
      const historyRecords = getRecentProcessedMessages(chat.chat_jid, 5);
      const historyContext = historyRecords.map(h => ({
        sender: h.sender_name,
        text: h.message_text
      }));

      // 3. Fetch upcoming 14 days of already scheduled events from SQLite ledger
      const existingEvents = getUpcomingSyncedEvents(14);

      // 4. Run AI Extractor
      const promptContext: PromptContext = {
        chatName: chat.chat_name,
        referenceTimeIso: new Date().toISOString(),
        timezone: userProfile.timezone,
        userProfile,
        existingEvents,
        messages: unprocessedMessages.map(m => ({
          sender: m.sender_name,
          text: m.message_text,
          timestamp: m.timestamp
        })),
        historyContext
      };

      try {
        const aiResponse = await extractScheduleFromChat(promptContext);
        console.log(`   AI extracted ${aiResponse.extracted_items.length} actionable item(s).`);

        // 5. Sync extracted items to Google Calendar & Conflict Engine
        for (const item of aiResponse.extracted_items) {
          // Only act on CREATE or UPDATE items with confidence >= 0.75
          if ((item.action === 'CREATE' || item.action === 'UPDATE') && item.confidence_score >= 0.75) {
            item.source_chat_name = chat.chat_name;

            const upsertResult = await upsertCalendarEvent(
              item,
              undefined,
              calendarService
            );
            itemsSynced++;

            console.log(`   📅 Calendar Sync: "${upsertResult.title}" | Conflict: ${upsertResult.hasConflict} | Color: ${upsertResult.colorId}`);

            // 6. Proactive Self-Notifications via WhatsApp (Message Yourself)
            if (sock && selfJid) {
              if (upsertResult.hasConflict && userProfile.notifications.alertOnConflictsImmediately) {
                await sendConflictAlert(sock, selfJid, upsertResult, userProfile.timezone);
                console.log(`   🚨 Proactive conflict alert sent to user.`);
              } else if (!upsertResult.hasConflict && userProfile.notifications.alertOnEveryAddedEvent) {
                await sendCleanEventConfirmation(sock, selfJid, upsertResult, userProfile.timezone);
                console.log(`   ✅ Event confirmation alert sent to user.`);
              }
            }
          }
        }

        // 7. Mark messages as processed
        const messageIds = unprocessedMessages.map(m => m.id);
        markMessagesProcessed(messageIds);

        // 8. Auto-Purge Raw Messages (Privacy Firewall requirement)
        if (userProfile.privacyAndSafety.deleteRawMessagesAfterProcessing) {
          const purged = purgeProcessedMessages(chat.chat_jid, 5);
          console.log(`   🛡️ Privacy Purge: Removed ${purged} raw messages from database (kept 5 sliding-window context rows).`);
        }

        processedChats++;
      } catch (chatError) {
        console.error(`❌ Error processing chat buffer for "${chat.chat_name}":`, chatError);
      }
    }
  } finally {
    isBatchRunning = false;
  }

  return { processedChats, itemsSynced };
}

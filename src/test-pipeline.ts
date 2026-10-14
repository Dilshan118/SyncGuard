import { initDatabase, closeDatabase, clearAllTables, insertMessage, getRecentProcessedMessages, getUnprocessedMessages, getUpcomingSyncedEvents } from './db/database';
import { loadUserProfile } from './config';
import { processChatBuffer } from './buffer/batchProcessor';
import { MockCalendarService } from './calendar/googleClient';
import { sendSecureSelfMessage } from './whatsapp/notifier';

async function runPipelineIntegrationTest() {
  console.log('====================================================');
  console.log('🔄 Running End-to-End Pipeline Integration Test...');
  console.log('====================================================\n');

  initDatabase();
  clearAllTables();

  const userProfile = loadUserProfile();
  const selfJid = '94771234567@s.whatsapp.net';
  const mockCalendar = new MockCalendarService();

  // Mock WhatsApp Socket
  const outboundMessages: Array<{ targetJid: string; text: string }> = [];
  const mockSock = {
    sendMessage: async (targetJid: string, content: { text: string }) => {
      outboundMessages.push({ targetJid, text: content.text });
      return { key: { id: `out_${Date.now()}` } };
    }
  };

  // 1. Verify Hard Outbound Lock
  console.log('1. Testing Hard Outbound Security Lock in Notifier...');
  let securityBlockCaught = false;
  try {
    // Attempting to send message to someone else or a group
    await sendSecureSelfMessage(mockSock, '94779999999@s.whatsapp.net', selfJid, { text: 'Leak test' });
  } catch (err: any) {
    if (err.message.includes('SECURITY BLOCK')) {
      securityBlockCaught = true;
    }
  }

  if (!securityBlockCaught) {
    throw new Error('SECURITY VIOLATION: sendSecureSelfMessage allowed sending to non-self JID!');
  }
  console.log('   ✅ Outbound message to third party was blocked with security exception.\n');

  // 2. Simulate Incoming Whitelisted Group Announcement
  console.log('2. Simulating Incoming Whitelisted Notice into Message Buffer...');
  const groupJid = '120363011111@g.us';
  const groupName = 'Y3S1 Official Notices';

  insertMessage({
    id: 'test_pipe_001',
    chat_jid: groupJid,
    chat_name: groupName,
    sender_name: 'Dr. Silva (Coordinator)',
    message_text: `📢 NOTICE FOR YEAR 3 SOFTWARE ENGINEERING
Module: SE3020 Distributed Systems
Lab Viva for Subgroup Y3.S1.WE.02 is scheduled for Thursday, Oct 22 from 10:00 AM - 11:00 AM at Lab 3.
Subgroup Y3.S1.WE.01 is on Wednesday at 9 AM.`,
    timestamp: Date.now() - 300000 // 5 minutes ago
  });

  const unprocessedBefore = getUnprocessedMessages(groupJid);
  console.log(`   Unprocessed messages in buffer: ${unprocessedBefore.length}`);
  if (unprocessedBefore.length !== 1) {
    throw new Error('Failed to insert test message into buffer');
  }
  console.log('   ✅ Message buffered successfully.\n');

  // 3. Run the Batch Processor
  console.log('3. Running Batch Processor (AI Extraction -> Conflict Check -> Calendar -> WhatsApp Alert)...');
  const result = await processChatBuffer({
    sock: mockSock as any,
    selfJid,
    calendarService: mockCalendar,
    forceProcessAll: true
  });

  console.log(`   Processed Chats: ${result.processedChats}`);
  console.log(`   Calendar Items Synced: ${result.itemsSynced}`);

  if (result.processedChats !== 1 || result.itemsSynced !== 1) {
    throw new Error(`Pipeline failed: expected 1 processed chat and 1 synced item, got chats=${result.processedChats}, items=${result.itemsSynced}`);
  }

  // 4. Verify Calendar and Database Ledger
  console.log('4. Verifying Synced Event in SQLite and Calendar...');
  const syncedEvents = getUpcomingSyncedEvents(14);
  console.log(`   Found ${syncedEvents.length} event(s) in SQLite ledger:`);
  for (const ev of syncedEvents) {
    console.log(`   • "${ev.title}" (${ev.category}) from ${ev.start_time} to ${ev.end_time}`);
  }

  if (syncedEvents.length !== 1 || !syncedEvents[0].title.includes('SE3020')) {
    throw new Error('Synced event not found in ledger');
  }

  // 5. Verify Outbound WhatsApp Alert
  console.log('5. Verifying Self-Notification WhatsApp Alert...');
  console.log(`   Outbound alerts sent: ${outboundMessages.length}`);
  if (outboundMessages.length !== 1) {
    throw new Error(`Expected exactly 1 self-alert, got ${outboundMessages.length}`);
  }

  const alert = outboundMessages[0];
  console.log(`   Target JID: ${alert.targetJid}`);
  console.log(`   Alert Preview:\n${alert.text}\n`);

  if (alert.targetJid !== selfJid) {
    throw new Error(`Alert target mismatch: expected ${selfJid}, got ${alert.targetJid}`);
  }
  if (!alert.text.includes('Auto-Scheduled from WhatsApp') || !alert.text.includes('SE3020')) {
    throw new Error('Alert content missing expected auto-schedule confirmation');
  }
  console.log('   ✅ Self-alert verified.\n');

  // 6. Verify Buffer Cleanup (Auto-Purge)
  console.log('6. Verifying Auto-Purge of Raw Messages...');
  const unprocessedAfter = getUnprocessedMessages(groupJid);
  const remainingHistory = getRecentProcessedMessages(groupJid, 10);
  console.log(`   Remaining unprocessed: ${unprocessedAfter.length}`);
  console.log(`   Remaining processed history context: ${remainingHistory.length}`);

  if (unprocessedAfter.length !== 0 || remainingHistory.length !== 1) {
    throw new Error('Buffer status mismatch after processing');
  }
  console.log('   ✅ Buffer marked processed and raw data maintained safely.\n');

  closeDatabase();
  console.log('====================================================');
  console.log('🎉 END-TO-END PIPELINE INTEGRATION TEST PASSED!');
  console.log('====================================================');
}

runPipelineIntegrationTest().catch((err) => {
  console.error('❌ Pipeline Test Failed:', err);
  process.exit(1);
});

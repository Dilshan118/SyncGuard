import fs from 'node:fs';
import path from 'node:path';
import {
  initDatabase,
  closeDatabase,
  insertMessage,
  getUnprocessedMessages,
  getUnprocessedChatsSummary,
  markMessagesProcessed,
  getRecentProcessedMessages,
  purgeProcessedMessages,
  insertSyncedEvent,
  updateSyncedEvent,
  getSyncedEventByGoogleId,
  getUpcomingSyncedEvents,
  clearAllTables
} from './db/database';
import { loadUserProfile } from './config';

async function runDatabaseTests() {
  console.log('====================================================');
  console.log('⚡ Running Phase 1 Database & Configuration Tests...');
  console.log('====================================================\n');

  // 1. Verify Configuration Loading
  console.log('1. Testing User Profile Loading...');
  const profile = loadUserProfile();
  console.log(`   User: ${profile.userName}`);
  console.log(`   Timezone: ${profile.timezone}`);
  console.log(`   Institution: ${profile.universityProfile.institution}`);
  console.log(`   Batch/Group: ${profile.universityProfile.batchGroup}`);
  console.log(`   Modules: ${profile.universityProfile.enrolledModules.map(m => m.code).join(', ')}`);
  if (!profile.userName || profile.universityProfile.enrolledModules.length === 0) {
    throw new Error('Failed to properly parse user profile!');
  }
  console.log('   ✅ User profile loaded and validated with Zod successfully.\n');

  // 2. Initialize Database
  console.log('2. Initializing SQLite Database (./data/syncguard.db)...');
  const db = initDatabase();
  console.log('   ✅ SQLite connection initialized with WAL mode.');

  const dbPath = path.resolve(process.cwd(), './data/syncguard.db');
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database file was not created at ${dbPath}`);
  }
  console.log(`   ✅ Database file confirmed at: ${dbPath}\n`);

  // Clear tables for a clean test run
  clearAllTables();

  // 3. Test Message Buffering
  console.log('3. Testing Message Buffering & Sliding-Window Helpers...');
  const chatJid = '1234567890-group@g.us';
  const chatName = 'SE3020 Project Group';

  insertMessage({
    id: 'msg_001',
    chat_jid: chatJid,
    chat_name: chatName,
    sender_name: 'Alice',
    message_text: 'When is our next viva scheduled?',
    timestamp: Date.now() - 300000
  });

  insertMessage({
    id: 'msg_002',
    chat_jid: chatJid,
    chat_name: chatName,
    sender_name: 'Bob',
    message_text: 'Dr. Silva said Thursday at 10 AM in Lab 3.',
    timestamp: Date.now() - 120000
  });

  const unprocessed = getUnprocessedMessages(chatJid);
  console.log(`   Found ${unprocessed.length} unprocessed messages for chat ${chatName}.`);
  if (unprocessed.length !== 2) {
    throw new Error(`Expected 2 unprocessed messages, got ${unprocessed.length}`);
  }

  const summaries = getUnprocessedChatsSummary();
  console.log(`   Found ${summaries.length} chat(s) with unprocessed messages.`);
  if (summaries[0].unprocessed_count !== 2) {
    throw new Error(`Expected unprocessed count 2, got ${summaries[0].unprocessed_count}`);
  }

  // Mark message 1 as processed and test context retrieval
  markMessagesProcessed(['msg_001']);
  const remainingUnprocessed = getUnprocessedMessages(chatJid);
  const processedContext = getRecentProcessedMessages(chatJid, 5);

  console.log(`   Remaining unprocessed: ${remainingUnprocessed.length}`);
  console.log(`   Processed history context messages: ${processedContext.length}`);
  if (remainingUnprocessed.length !== 1 || processedContext.length !== 1) {
    throw new Error('Message processing state mismatch');
  }

  // Test purgeProcessedMessages: insert 8 more processed messages
  for (let i = 3; i <= 10; i++) {
    const id = `msg_${String(i).padStart(3, '0')}`;
    insertMessage({
      id,
      chat_jid: chatJid,
      chat_name: chatName,
      sender_name: `Sender ${i}`,
      message_text: `Message ${i}`,
      timestamp: Date.now() - (10 - i) * 1000
    });
  }
  markMessagesProcessed([
    'msg_002', 'msg_003', 'msg_004', 'msg_005', 'msg_006',
    'msg_007', 'msg_008', 'msg_009', 'msg_010'
  ]);
  
  // Total processed is now 10 ('msg_001' to 'msg_010'). Purge keeping only the 5 newest.
  const purgedCount = purgeProcessedMessages(chatJid, 5);
  console.log(`   Purged ${purgedCount} old processed messages, keeping newest 5.`);
  const remainingProcessed = getRecentProcessedMessages(chatJid, 10);
  if (purgedCount !== 5 || remainingProcessed.length !== 5) {
    throw new Error(`Expected 5 purged and 5 remaining processed messages, got purged=${purgedCount}, remaining=${remainingProcessed.length}`);
  }
  console.log('   ✅ Message buffer and privacy purge operations verified.\n');

  // 4. Test Synced Events Ledger
  console.log('4. Testing Synced Events Ledger...');
  const now = new Date();
  const startTime = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ahead
  const endTime = new Date(now.getTime() + (2 * 24 + 1) * 60 * 60 * 1000).toISOString();

  const eventId = 'gcal_test_event_123';
  insertSyncedEvent({
    google_event_id: eventId,
    title: '[SE3020] Lab Viva Presentation',
    category: 'VIVA',
    start_time: startTime,
    end_time: endTime,
    source_chat_name: chatName,
    has_conflict: 0,
    conflicting_with: null
  });

  const retrieved = getSyncedEventByGoogleId(eventId);
  if (!retrieved || retrieved.title !== '[SE3020] Lab Viva Presentation') {
    throw new Error('Failed to retrieve inserted event by Google Event ID');
  }
  console.log(`   Inserted and retrieved event: "${retrieved.title}" (${retrieved.category})`);

  // Test updating event (e.g., reschedule with conflict)
  const newStartTime = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const newEndTime = new Date(now.getTime() + (3 * 24 + 1) * 60 * 60 * 1000).toISOString();

  const updated = updateSyncedEvent(eventId, {
    start_time: newStartTime,
    end_time: newEndTime,
    has_conflict: 1,
    conflicting_with: JSON.stringify(['SE3010 SQA Lecture'])
  });

  if (!updated) {
    throw new Error('Failed to update event in database');
  }

  const updatedRecord = getSyncedEventByGoogleId(eventId);
  if (updatedRecord?.has_conflict !== 1 || !updatedRecord.conflicting_with?.includes('SE3010')) {
    throw new Error('Event update fields did not persist correctly');
  }
  console.log(`   Updated event successfully: conflict marked, conflicting with: ${updatedRecord.conflicting_with}`);

  // Test upcoming 14-day events query
  const upcoming = getUpcomingSyncedEvents(14);
  console.log(`   Retrieved ${upcoming.length} upcoming event(s) for the next 14 days.`);
  if (upcoming.length !== 1) {
    throw new Error(`Expected 1 upcoming event, got ${upcoming.length}`);
  }
  console.log('   ✅ Synced events ledger and upcoming queries verified.\n');

  closeDatabase();
  console.log('====================================================');
  console.log('🎉 PHASE 1 TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================');
}

runDatabaseTests().catch((err) => {
  console.error('❌ Phase 1 Database Test Failed:', err);
  process.exit(1);
});

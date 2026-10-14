import cron from 'node-cron';
import { env, loadUserProfile } from './config';
import { initDatabase, closeDatabase, getUpcomingSyncedEvents } from './db/database';
import { hasSavedGoogleToken, getCalendarClient, getOrCreateSyncGuardCalendar } from './calendar/googleClient';
import { setActiveCalendarId, getActiveCalendarId } from './calendar/conflictEngine';
import { startWhatsAppClient, getConnectedSelfJid } from './whatsapp/client';
import { processChatBuffer } from './buffer/batchProcessor';
import { sendDailyBriefing } from './whatsapp/notifier';

async function main() {
  console.log('====================================================');
  console.log('🚀 Starting SyncGuard Autonomous AI Agent...');
  console.log('====================================================\n');

  // 1. Load User Profile and Config
  const userProfile = loadUserProfile();
  console.log(`👤 User: ${userProfile.userName} (${userProfile.timezone})`);
  console.log(`🎓 University: ${userProfile.universityProfile.institution} | Batch: ${userProfile.universityProfile.batchGroup}`);
  console.log(`📚 Modules: ${userProfile.universityProfile.enrolledModules.map(m => m.code).join(', ')}`);
  console.log(`🛡️ Privacy Mode: ${userProfile.privacyAndSafety.monitoringMode} (100% Personal DMs Blocked)`);
  console.log(`📋 Whitelisted Groups: ${userProfile.monitoredChats.whitelistedGroupNames.join(', ')}\n`);

  // 2. Initialize Database
  initDatabase();
  console.log('📦 SQLite Database initialized (data/syncguard.db).');

  // 3. Check Google Calendar Status & Initialize Dedicated Calendar (CAL-01)
  if (hasSavedGoogleToken()) {
    console.log('📅 Google Calendar: Connected (data/google_token.json found).');
    const calClient = getCalendarClient();
    if (calClient) {
      try {
        const targetCalId = await getOrCreateSyncGuardCalendar(calClient);
        setActiveCalendarId(targetCalId);
        console.log(`🛡️ Dedicated Calendar Active: "${targetCalId}"`);
        console.log(`   (Multi-calendar conflict engine active: cross-checking "${targetCalId}" and "primary")\n`);
      } catch (err: any) {
        console.warn(`Could not initialize secondary calendar: ${err.message}. Defaulting to: ${getActiveCalendarId()}\n`);
      }
    }
  } else {
    console.log('⚠️ Google Calendar: No saved token found.');
    console.log('👉 To connect Google Calendar, run: npm run auth:google\n');
  }

  // 4. Start WhatsApp Client (Stealth Mode)
  console.log('📱 Initializing WhatsApp Client in Stealth Mode...');
  const sock = await startWhatsAppClient((connectedSock, selfJid) => {
    console.log(`\n🎉 SyncGuard is actively protecting your schedule for: ${selfJid}`);
    console.log(`Type '!today' or '!week' in your WhatsApp "Message Yourself" chat to view your schedule.\n`);
  });

  // 5. Schedule 3-minute Batch Processor Cron Job
  const batchCronExpr = env.BATCH_INTERVAL_CRON || '*/3 * * * *';
  console.log(`⏱️ Scheduling Sliding-Window Buffer Processor (${batchCronExpr})...`);
  const batchTask = cron.schedule(batchCronExpr, async () => {
    try {
      await processChatBuffer();
    } catch (err) {
      console.error('Error in batch processor cron tick:', err);
    }
  });

  // 6. Schedule Daily Morning Briefing Cron Job
  // Parse "07:30" -> minute: 30, hour: 7 -> "30 7 * * *"
  const briefingTime = userProfile.notifications.dailyBriefingTime || '07:30';
  const [bHourStr, bMinStr] = briefingTime.split(':');
  const bHour = parseInt(bHourStr, 10) || 7;
  const bMin = parseInt(bMinStr, 10) || 30;
  const briefingCronExpr = `${bMin} ${bHour} * * *`;

  console.log(`☀️ Scheduling Daily Morning Briefing at ${briefingTime} (${briefingCronExpr})...`);
  const briefingTask = cron.schedule(briefingCronExpr, async () => {
    try {
      const selfJid = getConnectedSelfJid();
      if (!selfJid) return;

      const today = new Date();
      const startOfDayTs = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
      const endOfDayTs = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999).getTime();

      const upcoming = getUpcomingSyncedEvents(2, new Date(startOfDayTs).toISOString());
      const todayEvents = upcoming.filter(e => {
        const ts = e.start_ts ?? new Date(e.start_time).getTime();
        return ts >= startOfDayTs && ts <= endOfDayTs;
      });

      await sendDailyBriefing(sock, selfJid, todayEvents, userProfile.timezone, userProfile.userName);
      console.log(`📬 Daily morning briefing sent to ${selfJid}.`);
    } catch (err) {
      console.error('Error sending daily morning briefing:', err);
    }
  });

  // 7. Graceful Shutdown Handlers
  const shutdown = () => {
    console.log('\n🛑 Shutting down SyncGuard gracefully...');
    batchTask.stop();
    briefingTask.stop();
    closeDatabase();
    console.log('✅ SQLite database and scheduled tasks closed.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});

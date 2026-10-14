import {
  initDatabase,
  closeDatabase,
  clearAllTables,
  getSyncedEventByGoogleId,
  insertSyncedEvent,
  getUpcomingSyncedEvents
} from './db/database';
import {
  checkConflicts,
  upsertCalendarEvent,
  COLOR_IDS,
  ExtractedScheduleItem
} from './calendar/conflictEngine';
import { MockCalendarService } from './calendar/googleClient';

async function runCalendarTests() {
  console.log('====================================================');
  console.log('⚡ Running Phase 2 Google Calendar & Conflict Engine Tests...');
  console.log('====================================================\n');

  // Initialize DB
  initDatabase();
  clearAllTables();

  const mockCalendar = new MockCalendarService();

  // Test Case 1: Insert an existing time-blocked lecture
  console.log('1. Inserting Baseline Event: "SE3010 SQA Lecture" (10:00 - 12:00)...');
  const lectureItem: ExtractedScheduleItem = {
    action: 'CREATE',
    title: '[SE3010] Software Quality Assurance Lecture',
    category: 'LECTURE',
    is_time_blocked: true,
    start_time: '2026-10-20T10:00:00+05:30',
    end_time: '2026-10-20T12:00:00+05:30',
    location: 'Auditorium A',
    description: 'Weekly lecture on automated testing and QA standards.',
    confidence_score: 0.98,
    reasoning: 'Enrolled module lecture announcement in official chat',
    source_chat_name: 'Y3S1 Official Notices'
  };

  const lectureResult = await upsertCalendarEvent(lectureItem, undefined, mockCalendar);
  console.log(`   Created Event ID: ${lectureResult.googleEventId}`);
  console.log(`   Title: ${lectureResult.title}`);
  console.log(`   Color ID: ${lectureResult.colorId} (Expected: ${COLOR_IDS.LECTURE})`);
  console.log(`   Has Conflict: ${lectureResult.hasConflict}`);

  if (lectureResult.hasConflict || lectureResult.colorId !== COLOR_IDS.LECTURE) {
    throw new Error('Baseline lecture failed creation checks');
  }
  console.log('   ✅ Baseline lecture inserted cleanly.\n');

  // Test Case 2: Insert a non-conflicting afternoon meetup
  console.log('2. Inserting Non-Conflicting Event: "Uni Friends Meetup" (14:00 - 15:00)...');
  const meetupItem: ExtractedScheduleItem = {
    action: 'CREATE',
    title: 'Uni Friends Coffee Meetup',
    category: 'MEETUP',
    is_time_blocked: true,
    start_time: '2026-10-20T14:00:00+05:30',
    end_time: '2026-10-20T15:00:00+05:30',
    location: 'Campus Cafe',
    description: 'Catching up with friends.',
    confidence_score: 0.90,
    reasoning: 'Agreed meetup time in social chat',
    source_chat_name: 'Uni Friends'
  };

  const meetupResult = await upsertCalendarEvent(meetupItem, undefined, mockCalendar);
  console.log(`   Title: ${meetupResult.title}`);
  console.log(`   Color ID: ${meetupResult.colorId} (Expected: ${COLOR_IDS.MEETUP})`);
  console.log(`   Has Conflict: ${meetupResult.hasConflict}`);

  if (meetupResult.hasConflict || meetupResult.colorId !== COLOR_IDS.MEETUP) {
    throw new Error('Meetup should not have conflicts');
  }
  console.log('   ✅ Non-conflicting event scheduled with Yellow color.\n');

  // Test Case 3: Simulate Overlapping Event (Viva clashes with lecture 10:30 - 11:30)
  console.log('3. Testing Conflict Detection: "[SE3020] Viva" (10:30 - 11:30, overlaps lecture)...');
  const vivaItem: ExtractedScheduleItem = {
    action: 'CREATE',
    title: '[SE3020] Lab Viva Presentation',
    category: 'VIVA',
    is_time_blocked: true,
    start_time: '2026-10-20T10:30:00+05:30',
    end_time: '2026-10-20T11:30:00+05:30',
    location: 'Lab 3',
    description: 'Individual demonstration of distributed cache assignment.',
    confidence_score: 0.96,
    reasoning: 'Batch group viva slot assigned in project group',
    source_chat_name: 'SE3020 Project Group'
  };

  const conflictCheck = await checkConflicts(
    vivaItem.start_time,
    vivaItem.end_time,
    vivaItem.is_time_blocked,
    null,
    mockCalendar
  );

  console.log(`   Conflict check detected overlap: ${conflictCheck.hasConflict}`);
  console.log(`   Conflicting Events: ${conflictCheck.conflictingEvents.map(e => e.title).join(', ')}`);

  if (!conflictCheck.hasConflict || conflictCheck.conflictingEvents.length === 0) {
    throw new Error('Expected conflict check to detect collision with SE3010 lecture');
  }

  const vivaResult = await upsertCalendarEvent(vivaItem, conflictCheck, mockCalendar);
  console.log(`   Saved Event Title: "${vivaResult.title}"`);
  console.log(`   Assigned Color ID: ${vivaResult.colorId} (Expected Red: ${COLOR_IDS.CONFLICT})`);
  console.log(`   Has Conflict: ${vivaResult.hasConflict}`);

  if (
    !vivaResult.title.startsWith('⚠️ [CONFLICT]') ||
    vivaResult.colorId !== COLOR_IDS.CONFLICT ||
    !vivaResult.hasConflict
  ) {
    throw new Error('Conflicting event was not properly flagged or colored red in calendar');
  }

  // Verify SQLite ledger records the conflict
  const vivaRecord = getSyncedEventByGoogleId(vivaResult.googleEventId);
  if (!vivaRecord || vivaRecord.has_conflict !== 1 || !vivaRecord.conflicting_with) {
    throw new Error('SQLite ledger did not record the conflict flag');
  }
  console.log(`   SQLite Ledger Conflict Record: has_conflict=${vivaRecord.has_conflict}, details=${vivaRecord.conflicting_with}`);
  console.log('   ✅ Conflict detected, prefixed with ⚠️ [CONFLICT], and colored Tomato Red (11).\n');

  // Test Case 4: Rescheduling the Viva to resolve conflict (UPDATE action)
  console.log('4. Testing Reschedule / Update Awareness: Moving Viva to 15:30 - 16:30...');
  const rescheduledViva: ExtractedScheduleItem = {
    action: 'UPDATE',
    target_google_event_id: vivaResult.googleEventId,
    title: '[SE3020] Lab Viva Presentation',
    category: 'VIVA',
    is_time_blocked: true,
    start_time: '2026-10-20T15:30:00+05:30',
    end_time: '2026-10-20T16:30:00+05:30',
    location: 'Lab 3',
    description: 'Rescheduled viva slot.',
    confidence_score: 0.99,
    reasoning: 'Lecturer announced moved time slot in chat',
    source_chat_name: 'SE3020 Project Group'
  };

  const updateResult = await upsertCalendarEvent(rescheduledViva, undefined, mockCalendar);
  console.log(`   Updated Event Title: "${updateResult.title}"`);
  console.log(`   Updated Color ID: ${updateResult.colorId} (Expected Purple: ${COLOR_IDS.VIVA})`);
  console.log(`   Has Conflict: ${updateResult.hasConflict}`);

  if (
    updateResult.hasConflict ||
    updateResult.title.startsWith('⚠️ [CONFLICT]') ||
    updateResult.colorId !== COLOR_IDS.VIVA
  ) {
    throw new Error('Rescheduled event did not clear conflict status or reset color to Purple');
  }

  const updatedVivaDb = getSyncedEventByGoogleId(vivaResult.googleEventId);
  if (updatedVivaDb?.has_conflict !== 0) {
    throw new Error('Database did not clear conflict flag after reschedule');
  }
  console.log('   ✅ Event rescheduled successfully: conflict resolved, title cleaned, color restored to Purple.\n');

  // Test Case 5: Deadline (is_time_blocked = false) should NOT clash with lectures
  console.log('5. Testing Deadline Distinction (is_time_blocked: false at 11:00 AM during lecture)...');
  const deadlineItem: ExtractedScheduleItem = {
    action: 'CREATE',
    title: '[CS3040] Database Assignment 1 Due',
    category: 'DEADLINE',
    is_time_blocked: false,
    start_time: '2026-10-20T10:30:00+05:30',
    end_time: '2026-10-20T11:00:00+05:30',
    location: 'Online Portal',
    description: 'Submit SQL dump and report to LMS.',
    confidence_score: 0.95,
    reasoning: 'Assignment deadline announcement',
    source_chat_name: 'Y3S1 Official Notices'
  };

  const deadlineResult = await upsertCalendarEvent(deadlineItem, undefined, mockCalendar);
  console.log(`   Deadline Title: "${deadlineResult.title}"`);
  console.log(`   Color ID: ${deadlineResult.colorId} (Expected Orange: ${COLOR_IDS.DEADLINE})`);
  console.log(`   Has Conflict: ${deadlineResult.hasConflict}`);

  if (deadlineResult.hasConflict || deadlineResult.colorId !== COLOR_IDS.DEADLINE) {
    throw new Error('Point-in-time deadline should not cause daytime conflict');
  }

  // CAL-04: Verify transparency is 'transparent' and private.isDeadline is '1'
  const createdDeadlineGEvent = mockCalendar.getAllEvents().find(e => e.id === deadlineResult.googleEventId);
  if (createdDeadlineGEvent?.transparency !== 'transparent') {
    throw new Error('CAL-04 Failed: Deadline event should have transparency === "transparent"');
  }
  if (createdDeadlineGEvent?.extendedProperties?.private?.isDeadline !== '1') {
    throw new Error('CAL-04 Failed: Deadline event should have extendedProperties.private.isDeadline === "1"');
  }
  console.log('   ✅ CAL-04 Verified: Deadline marked transparent with isDeadline private property.\n');

  // Test Case 6: Verify transparent deadline does not block subsequent lecture (CAL-04)
  console.log('6. Testing that a transparent deadline does not block a subsequent lecture (CAL-04)...');
  const labLectureItem: ExtractedScheduleItem = {
    action: 'CREATE',
    title: '[CS3040] Database Lab Session',
    category: 'LECTURE',
    is_time_blocked: true,
    start_time: '2026-10-20T10:30:00+05:30', // Exact same time as deadline
    end_time: '2026-10-20T11:00:00+05:30',
    location: 'Lab 2',
    confidence_score: 0.95,
    reasoning: 'Lab scheduled',
    source_chat_name: 'Y3S1 Official Notices'
  };

  const labConflict = await checkConflicts(
    labLectureItem.start_time,
    labLectureItem.end_time,
    labLectureItem.is_time_blocked,
    null,
    mockCalendar
  );

  // The earlier rescheduled viva was moved to 15:30, and the deadline is transparent.
  // The lecture at 10:00-12:00 was inserted in step 1, so labLectureItem will overlap the baseline lecture.
  // Let's test at 16:30 - 17:30 with another transparent event:
  const eveningDeadline: ExtractedScheduleItem = {
    action: 'CREATE',
    title: '[IT3050] Weekly Quiz Submission Due',
    category: 'DEADLINE',
    is_time_blocked: false,
    start_time: '2026-10-20T17:00:00+05:30',
    end_time: '2026-10-20T17:30:00+05:30',
    confidence_score: 0.95,
    reasoning: 'Quiz deadline',
    source_chat_name: 'Y3S1 Official Notices'
  };
  await upsertCalendarEvent(eveningDeadline, undefined, mockCalendar);

  const eveningStudyItem: ExtractedScheduleItem = {
    action: 'CREATE',
    title: 'Independent Study Block',
    category: 'OTHER',
    is_time_blocked: true,
    start_time: '2026-10-20T16:45:00+05:30',
    end_time: '2026-10-20T17:45:00+05:30',
    confidence_score: 0.90,
    reasoning: 'Personal study block',
    source_chat_name: 'Personal'
  };

  const eveningConflict = await checkConflicts(
    eveningStudyItem.start_time,
    eveningStudyItem.end_time,
    eveningStudyItem.is_time_blocked,
    null,
    mockCalendar
  );

  if (eveningConflict.hasConflict) {
    throw new Error('CAL-04 Failed: Transparent deadline caused a conflict for time-blocked event');
  }
  console.log('   ✅ CAL-04 Verified: Transparent deadline does not block daytime schedule slots.\n');

  // Test Case 7: SEC-01 Event ownership & ledger check before updating/patching
  console.log('7. Testing SEC-01: Untracked event ownership check before UPDATE...');
  const untrackedUpdateItem: ExtractedScheduleItem = {
    action: 'UPDATE',
    target_google_event_id: 'foreign_untracked_personal_event_999',
    title: 'Tampering or Untracked Meeting',
    category: 'MEETUP',
    is_time_blocked: true,
    start_time: '2026-10-21T10:00:00+05:30',
    end_time: '2026-10-21T11:00:00+05:30',
    confidence_score: 0.95,
    reasoning: 'Attempting to patch foreign event',
    source_chat_name: 'External Chat'
  };

  const secResult = await upsertCalendarEvent(untrackedUpdateItem, undefined, mockCalendar);
  if (secResult.actionTaken !== 'CREATED' || secResult.googleEventId === 'foreign_untracked_personal_event_999') {
    throw new Error('SEC-01 Failed: SyncGuard allowed patching an untracked event ID!');
  }
  console.log(`   SEC-01 Handled: Untracked UPDATE safely redirected to CREATED (${secResult.googleEventId}).`);
  console.log('   ✅ SEC-01 Verified: Foreign personal events cannot be patched or corrupted.\n');

  // Test Case 8: CAL-01 Multi-Calendar Conflict Detection
  console.log('8. Testing CAL-01: Multi-Calendar Conflict Detection (Primary vs SyncGuard Dedicated Calendar)...');
  // Insert a personal event onto the 'primary' calendar
  await mockCalendar.insertEvent({
    calendarId: 'primary',
    requestBody: {
      summary: 'Personal Doctor Appointment',
      start: { dateTime: '2026-10-22T14:00:00+05:30' },
      end: { dateTime: '2026-10-22T15:00:00+05:30' }
    }
  });

  // Check conflicts from a secondary "syncguard_dedicated" calendar target
  const multiCalConflict = await checkConflicts(
    '2026-10-22T14:30:00+05:30',
    '2026-10-22T15:30:00+05:30',
    true,
    null,
    mockCalendar,
    'syncguard_dedicated'
  );

  console.log(`   Multi-calendar conflict detected across primary and secondary: ${multiCalConflict.hasConflict}`);
  console.log(`   Clashing event: ${multiCalConflict.conflictingEvents.map(e => e.title).join(', ')}`);
  if (!multiCalConflict.hasConflict || !multiCalConflict.conflictingEvents.some(e => e.title.includes('Doctor Appointment'))) {
    throw new Error('CAL-01 Failed: Personal calendar event on "primary" was not detected when querying secondary calendar');
  }
  console.log('   ✅ CAL-01 Verified: Cross-calendar conflict detection protects primary personal events.\n');

  // Test Case 9: DB-01 Epoch UTC ms Filtering with Mixed Timezone Representations
  console.log('9. Testing DB-01: UTC Epoch Integer Timestamps with Mixed Timezone Strings...');
  const offsetEventId = 'offset_event_test_001';
  insertSyncedEvent({
    google_event_id: offsetEventId,
    title: '[MLOM] Special Weekend Viva Session',
    category: 'VIVA',
    start_time: '2026-10-25T09:00:00+05:30', // UTC: 2026-10-25T03:30:00.000Z
    end_time: '2026-10-25T11:00:00+05:30',
    source_chat_name: 'MLOM and IRWA 2026',
    has_conflict: 0
  });

  // Query using UTC reference time (Z notation)
  const queryRefUtc = '2026-10-25T00:00:00.000Z';
  const epochEvents = getUpcomingSyncedEvents(2, queryRefUtc);
  const foundOffset = epochEvents.find(e => e.google_event_id === offsetEventId);

  if (!foundOffset || foundOffset.start_ts !== new Date('2026-10-25T09:00:00+05:30').getTime()) {
    throw new Error('DB-01 Failed: Epoch query failed to find offset event or start_ts mismatched');
  }
  console.log(`   Found event by UTC range: "${foundOffset.title}" with start_ts=${foundOffset.start_ts}`);
  console.log('   ✅ DB-01 Verified: Epoch timestamps resolve timezone offset comparison bugs reliably.\n');

  closeDatabase();
  console.log('====================================================');
  console.log('🎉 PHASE 2 TESTS PASSED SUCCESSFULLY!');
  console.log('====================================================');
}

runCalendarTests().catch((err) => {
  console.error('❌ Phase 2 Calendar Test Failed:', err);
  process.exit(1);
});

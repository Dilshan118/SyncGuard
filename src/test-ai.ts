import { loadUserProfile } from './config';
import { extractScheduleFromChat } from './ai/extractor';
import { PromptContext } from './ai/prompts';
import { SyncedEventRecord } from './db/database';

async function runAiExtractorTests() {
  console.log('====================================================');
  console.log('⚡ Running Phase 3 AI Extractor & Relevance Tests...');
  console.log('====================================================\n');

  const userProfile = loadUserProfile();
  const referenceTimeIso = '2026-10-14T10:00:00+05:30'; // Wednesday Oct 14, 2026
  const timezone = userProfile.timezone || 'Asia/Colombo';
  const existingEvents: SyncedEventRecord[] = [];

  // =========================================================================
  // Case 1: University Notice with Multiple Subgroups (Relevance Filtering)
  // =========================================================================
  console.log('----------------------------------------------------');
  console.log('📘 Case 1: University Notice with Multiple Subgroups');
  console.log('   (User batchGroup: "Y3.S1.WE.02" | enrolled module: SE3020)');
  console.log('----------------------------------------------------');

  const case1Context: PromptContext = {
    chatName: 'Y3S1 Official Notices',
    referenceTimeIso,
    timezone,
    userProfile,
    existingEvents,
    messages: [
      {
        sender: 'Prof. K. Perera (Lecturer)',
        text: `📢 ATTENTION YEAR 3 SOFTWARE ENGINEERING STUDENTS
Module: SE3020 Distributed Systems - Lab Viva Schedule

Please check your allocated slots carefully based on your registered subgroup:
- Subgroup Y3.S1.WE.01 (Group 01): Wednesday, Oct 21 from 09:00 AM - 10:00 AM at Lab 2.
- Subgroup Y3.S1.WE.02 (Group 02): Thursday, Oct 22 from 10:00 AM - 11:00 AM at Lab 3.

Attendance is compulsory. Bring your student ID card and project documentation.`,
        timestamp: Date.now() - 3600000
      }
    ]
  };

  const case1Result = await extractScheduleFromChat(case1Context);
  console.log('Raw Extracted Output:');
  console.log(JSON.stringify(case1Result, null, 2));

  // Assertions for Case 1
  if (case1Result.extracted_items.length !== 1) {
    throw new Error(`Case 1 failed: Expected exactly 1 extracted item, got ${case1Result.extracted_items.length}`);
  }

  const case1Item = case1Result.extracted_items[0];
  if (!case1Item.title.includes('SE3020') || case1Item.category !== 'VIVA') {
    throw new Error(`Case 1 failed: Expected SE3020 Viva, got "${case1Item.title}" (${case1Item.category})`);
  }

  if (case1Item.description && case1Item.description.includes('WE.01')) {
    throw new Error('Case 1 failed: Extracted notice for wrong subgroup WE.01');
  }

  if (!case1Item.is_time_blocked) {
    throw new Error('Case 1 failed: Viva should be time_blocked');
  }

  console.log('✅ Case 1 Passed: Successfully filtered for user subgroup Y3.S1.WE.02 and ignored subgroup 01.\n');

  // =========================================================================
  // Case 2: Chaotic 8-Message Social Negotiation (Consensus Check)
  // =========================================================================
  console.log('----------------------------------------------------');
  console.log('🌴 Case 2: Chaotic Social Plan Negotiation (8 Messages)');
  console.log('   (Verifying consensus check: Friday rejected, Saturday 9 AM agreed)');
  console.log('----------------------------------------------------');

  const case2Context: PromptContext = {
    chatName: 'Batch Trip 2026',
    referenceTimeIso,
    timezone,
    userProfile,
    existingEvents,
    messages: [
      { sender: 'Kevin', text: 'Guys are we still doing the batch picnic this week?', timestamp: Date.now() - 400000 },
      { sender: 'Nimesha', text: 'Yes!! How about this Friday around 2 PM?', timestamp: Date.now() - 350000 },
      { sender: 'Alex (User)', text: "Can't do Friday afternoon, I have SE3010 lecture and assignments to wrap up.", timestamp: Date.now() - 300000 },
      { sender: 'Dinesh', text: "Friday doesn't work for me either, lab session till 4 PM.", timestamp: Date.now() - 250000 },
      { sender: 'Nimesha', text: 'What about Saturday morning then? Say 9:00 AM at Kosgama Nature Park?', timestamp: Date.now() - 200000 },
      { sender: 'Kevin', text: 'Saturday 9 AM works great for me! Weather looks sunny too.', timestamp: Date.now() - 150000 },
      { sender: 'Alex (User)', text: "Saturday 9 AM is perfect, I'm free all day.", timestamp: Date.now() - 100000 },
      { sender: 'Dinesh', text: 'Locked in! Saturday 9 AM at Kosgama. See you all there!', timestamp: Date.now() - 50000 }
    ]
  };

  const case2Result = await extractScheduleFromChat(case2Context);
  console.log('Raw Extracted Output:');
  console.log(JSON.stringify(case2Result, null, 2));

  // Assertions for Case 2
  if (case2Result.extracted_items.length !== 1) {
    throw new Error(`Case 2 failed: Expected 1 agreed picnic event, got ${case2Result.extracted_items.length}`);
  }

  const case2Item = case2Result.extracted_items[0];
  if (case2Item.category !== 'PICNIC') {
    throw new Error(`Case 2 failed: Expected PICNIC category, got ${case2Item.category}`);
  }

  const startDate = new Date(case2Item.start_time);
  const endDate = new Date(case2Item.end_time);
  const durationHours = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60);

  console.log(`   Agreed Time: ${case2Item.start_time} - ${case2Item.end_time} (${durationHours} hours)`);
  if (durationHours < 3) {
    throw new Error(`Case 2 failed: Picnic duration should use user profile default (4 hours), got ${durationHours}`);
  }

  console.log('✅ Case 2 Passed: Correctly ignored rejected Friday suggestion and extracted agreed Saturday picnic.\n');

  // =========================================================================
  // Case 3: Project Deadline Announcement (Non-Time-Blocked)
  // =========================================================================
  console.log('----------------------------------------------------');
  console.log('⏰ Case 3: Project Deadline Announcement');
  console.log('   (Verifying point-in-time deadline with is_time_blocked: false)');
  console.log('----------------------------------------------------');

  const case3Context: PromptContext = {
    chatName: 'IT3050 FYP Group',
    referenceTimeIso,
    timezone,
    userProfile,
    existingEvents,
    messages: [
      {
        sender: 'Dr. Fernando (Coordinator)',
        text: `FINAL YEAR PROJECT (IT3050) REMINDER:
Phase 1 Proposal Submission is strictly due this Friday before 11:59 PM.
The LMS submission link will close automatically. Late submissions will receive an immediate penalty. Ensure your project repository URL and group charter are included in the PDF.`,
        timestamp: Date.now() - 1000000
      }
    ]
  };

  const case3Result = await extractScheduleFromChat(case3Context);
  console.log('Raw Extracted Output:');
  console.log(JSON.stringify(case3Result, null, 2));

  // Assertions for Case 3
  if (case3Result.extracted_items.length !== 1) {
    throw new Error(`Case 3 failed: Expected 1 deadline item, got ${case3Result.extracted_items.length}`);
  }

  const case3Item = case3Result.extracted_items[0];
  if (case3Item.category !== 'DEADLINE') {
    throw new Error(`Case 3 failed: Expected DEADLINE category, got ${case3Item.category}`);
  }

  if (case3Item.is_time_blocked !== false) {
    throw new Error('Case 3 failed: Deadlines MUST have is_time_blocked = false');
  }

  if (!case3Item.end_time.includes('23:59')) {
    throw new Error(`Case 3 failed: Due time should be 23:59, got ${case3Item.end_time}`);
  }

  console.log('✅ Case 3 Passed: Correctly identified deadline with is_time_blocked: false at 23:59.\n');

  // =========================================================================
  // Case 4: Deduplication & Update Awareness
  // =========================================================================
  console.log('----------------------------------------------------');
  console.log('🔄 Case 4: Rescheduling Existing Event (UPDATE action)');
  console.log('----------------------------------------------------');

  const existingViva: SyncedEventRecord = {
    google_event_id: 'existing_viva_123',
    title: '[SE3020] Lab Viva Presentation',
    category: 'VIVA',
    start_time: '2026-10-22T10:00:00+05:30',
    end_time: '2026-10-22T11:00:00+05:30',
    source_chat_name: 'SE3020 Project Group',
    has_conflict: 0
  };

  const case4Context: PromptContext = {
    chatName: 'SE3020 Project Group',
    referenceTimeIso,
    timezone,
    userProfile,
    existingEvents: [existingViva],
    messages: [
      {
        sender: 'Prof. K. Perera',
        text: 'Attention Group 02 (Weekend 2.2): The SE3020 Lab Viva scheduled for Oct 22 at 10:00 AM is moved to 2:00 PM (14:00) at Lab 3 due to a faculty meeting.',
        timestamp: Date.now() - 50000
      }
    ]
  };

  const case4Result = await extractScheduleFromChat(case4Context);
  console.log('Raw Extracted Output:');
  console.log(JSON.stringify(case4Result, null, 2));

  const case4Item = case4Result.extracted_items[0];
  if (!case4Item || case4Item.action !== 'UPDATE' || case4Item.target_google_event_id !== 'existing_viva_123') {
    throw new Error('Case 4 failed: Expected action UPDATE with target_google_event_id matching existing event');
  }
  console.log('✅ Case 4 Passed: Recognized reschedule, set action = UPDATE and preserved target_google_event_id.\n');

  // =========================================================================
  // Case 5: "MLOM and IRWA 2026" Group Filtering (Weekend 2.2 vs Weekend 1.1)
  // =========================================================================
  console.log('----------------------------------------------------');
  console.log('🔬 Case 5: MLOM & IRWA Group - Subgroup Filtering');
  console.log('   (Verifying Weekend 2.2 extracted, Weekend 1.1 ignored)');
  console.log('----------------------------------------------------');

  const case5ContextA: PromptContext = {
    chatName: 'MLOM and IRWA 2026',
    referenceTimeIso,
    timezone,
    userProfile,
    existingEvents,
    messages: [
      {
        sender: 'Dr. Jayalath (Lecturer)',
        text: `📌 MLOM & IRWA Lab Viva Presentation Schedule:
- Weekend Group 1.1 (WE 1.1): Sunday, Oct 25 from 09:00 AM - 11:00 AM at Lab 01
- Weekend Group 2.2 (WE 2.2): Sunday, Oct 25 from 09:00 AM - 11:00 AM at Lab 03

Please be present on time with your project source code.`,
        timestamp: Date.now() - 60000
      }
    ]
  };

  const case5ResultA = await extractScheduleFromChat(case5ContextA);
  console.log('MLOM & IRWA Multi-group Notice Output:');
  console.log(JSON.stringify(case5ResultA, null, 2));

  if (case5ResultA.extracted_items.length !== 1) {
    throw new Error(`Case 5A failed: Expected exactly 1 item for Weekend 2.2, got ${case5ResultA.extracted_items.length}`);
  }

  const case5ItemA = case5ResultA.extracted_items[0];
  const targets22 =
    case5ItemA.description.includes('2.2') ||
    case5ItemA.reasoning.includes('2.2') ||
    case5ItemA.title.includes('2.2');
  if (!targets22) {
    throw new Error('Case 5A failed: Extracted item did not target Weekend 2.2');
  }
  console.log('✅ Case 5A Passed: Multi-group notice filtered strictly for Weekend 2.2.\n');

  // Case 5B: Notice for Weekend 1.1 only (should return 0 items for this user)
  const case5ContextB: PromptContext = {
    chatName: 'MLOM and IRWA 2026',
    referenceTimeIso,
    timezone,
    userProfile,
    existingEvents,
    messages: [
      {
        sender: 'Coordinator',
        text: 'Announcement: Weekend 1.1 only - Extra tutorial session on Friday at 4 PM.',
        timestamp: Date.now() - 30000
      }
    ]
  };

  const case5ResultB = await extractScheduleFromChat(case5ContextB);
  if (case5ResultB.extracted_items.length !== 0) {
    throw new Error(`Case 5B failed: Expected 0 items for Weekend 1.1 notice, got ${case5ResultB.extracted_items.length}`);
  }
  console.log('✅ Case 5B Passed: Notice exclusively for Weekend 1.1 correctly ignored (0 items extracted).\n');

  // =========================================================================
  // Case 6: "4 Outliers" Project Group (Meeting Extraction)
  // =========================================================================
  console.log('----------------------------------------------------');
  console.log('👥 Case 6: "4 Outliers" Project Group Meeting');
  console.log('   (Verifying project sync call extraction)');
  console.log('----------------------------------------------------');

  const case6Context: PromptContext = {
    chatName: '4 Outliers',
    referenceTimeIso,
    timezone,
    userProfile,
    existingEvents,
    messages: [
      { sender: 'Kasun', text: 'Hey team, can we meet this Sunday at 8 PM on Teams to review the project demo?', timestamp: Date.now() - 120000 },
      { sender: 'Dinithi', text: 'Sunday 8 PM works for me, I have finished the slides.', timestamp: Date.now() - 90000 },
      { sender: 'Alex', text: 'Sounds good to me too, see you on Teams at 8 PM.', timestamp: Date.now() - 60000 },
      { sender: 'Kasun', text: 'Done! Locked for Sunday 8 PM.', timestamp: Date.now() - 30000 }
    ]
  };

  const case6Result = await extractScheduleFromChat(case6Context);
  console.log('4 Outliers Extracted Output:');
  console.log(JSON.stringify(case6Result, null, 2));

  if (case6Result.extracted_items.length !== 1) {
    throw new Error(`Case 6 failed: Expected 1 project sync meeting, got ${case6Result.extracted_items.length}`);
  }

  const case6Item = case6Result.extracted_items[0];
  if (case6Item.category !== 'MEETUP') {
    throw new Error(`Case 6 failed: Expected MEETUP category, got ${case6Item.category}`);
  }
  console.log('✅ Case 6 Passed: Successfully extracted agreed project sync meeting for 4 Outliers.\n');

  console.log('====================================================');
  console.log('🎉 ALL AI EXTRACTION & RELEVANCE TESTS PASSED!');
  console.log('====================================================');
}

runAiExtractorTests().catch((err) => {
  console.error('❌ Phase 3 AI Extractor Test Failed:', err);
  process.exit(1);
});

import { z } from 'zod';
import { UserProfile } from '../config';
import { SyncedEventRecord } from '../db/database';

export const ExtractedItemSchema = z.object({
  action: z.enum(['CREATE', 'UPDATE', 'IGNORE']),
  target_google_event_id: z.string().nullable().optional().default(null),
  title: z.string().min(1, 'Title cannot be empty'),
  category: z.enum(['LECTURE', 'VIVA', 'DEADLINE', 'MEETUP', 'PICNIC', 'OTHER']),
  is_time_blocked: z.boolean(),
  start_time: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'start_time must be ISO 8601 string'),
  end_time: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'end_time must be ISO 8601 string'),
  location: z.string().optional().default('Unknown'),
  description: z.string().optional().default(''),
  confidence_score: z.number().min(0).max(1),
  reasoning: z.string(),
  source_chat_name: z.string().optional()
});

export const ExtractedScheduleResponseSchema = z.object({
  extracted_items: z.array(ExtractedItemSchema)
});

export type ExtractedItem = z.infer<typeof ExtractedItemSchema>;
export type ExtractedScheduleResponse = z.infer<typeof ExtractedScheduleResponseSchema>;

export interface PromptContext {
  referenceTimeIso?: string;
  timezone?: string;
  userProfile: UserProfile;
  existingEvents: SyncedEventRecord[];
  chatName: string;
  messages: Array<{
    sender: string;
    text: string;
    timestamp?: string | number;
  }>;
  historyContext?: Array<{
    sender: string;
    text: string;
  }>;
}

/**
 * Returns the day of the week for a given date in the specified timezone
 */
function getDayOfWeek(date: Date, timezone: string): string {
  try {
    return date.toLocaleDateString('en-US', { weekday: 'long', timeZone: timezone });
  } catch {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return days[date.getUTCDay()];
  }
}

/**
 * Returns contextual instructions for a specific WhatsApp group
 */
export function getChatSpecificRule(chatName: string, userProfile: UserProfile): string {
  const normName = (chatName || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, '')
    .trim()
    .toLowerCase();

  // 1. Check custom configured rules in user_profile.json
  const customRules = userProfile.monitoredChats.groupSpecificRules || {};
  for (const [key, rule] of Object.entries(customRules)) {
    const normKey = key.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF\u2060]/g, '').trim().toLowerCase();
    if (normName === normKey || normName.includes(normKey) || normKey.includes(normName)) {
      return String(rule);
    }
  }

  // 2. Built-in defaults for user's primary groups
  if (normName.includes('mlom') || normName.includes('irwa')) {
    return "Enrolled courses group for MLOM & IRWA. Filter STRICTLY for Weekend Group 2.2 ('Weekend 2.2', 'WE 2.2', 'Group 2.2', 'Batch 2.2', 'WE.02.02'). Only extract lectures, lab sessions, or viva slots that match Weekend 2.2 or are general to all students. IGNORE all entries exclusively for Weekday groups or other Weekend subgroups (such as Weekend 1.1, Weekend 2.1).";
  }

  if (normName.includes('outlier') || normName.includes('project')) {
    return "User's academic project group ('4 Outliers'). Extract all group syncs, team meetings, Zoom/Teams calls, submission deadlines, task milestones, and presentation rehearsals agreed or scheduled by members.";
  }

  if (normName.includes('october') || normName.includes('octomber') || normName.includes('2023')) {
    return "SLIIT October 2023 intake batch community group. Extract academic notices, exam dates, registration deadlines, and university announcements relevant to October 2023 / Year 3.";
  }

  return "Scan for actionable schedules, classes, vivas, deadlines, or meetups relevant to the user's profile.";
}

/**
 * Builds the comprehensive System Prompt for LLM extraction
 */
export function buildSystemPrompt(context: {
  referenceTimeIso: string;
  timezone: string;
  userProfile: UserProfile;
  existingEvents: SyncedEventRecord[];
  chatName?: string;
}): string {
  const refDate = new Date(context.referenceTimeIso);
  const dayOfWeek = getDayOfWeek(refDate, context.timezone);

  const formattedExistingEvents = context.existingEvents.map(e => ({
    google_event_id: e.google_event_id,
    title: e.title,
    category: e.category,
    start_time: e.start_time,
    end_time: e.end_time,
    source_chat_name: e.source_chat_name
  }));

  const chatRule = context.chatName ? getChatSpecificRule(context.chatName, context.userProfile) : '';

  return `You are an elite personal scheduling assistant for a university student.
Current Reference Time: ${context.referenceTimeIso} (${dayOfWeek}), Timezone: ${context.timezone}.

USER PROFILE:
${JSON.stringify(context.userProfile, null, 2)}
${chatRule ? `\nCURRENT GROUP FILTER RULE ("${context.chatName}"):\n${chatRule}\n` : ''}
ALREADY SCHEDULED EVENTS (Next 14 Days):
${JSON.stringify(formattedExistingEvents, null, 2)}

TASK:
Analyze the provided WhatsApp chat transcript and extract any actionable schedule items.

STRICT RULES:
1. RELEVANCE & SUBGROUP FILTER:
   - For course groups with subgroup divisions (e.g. "MLOM and IRWA 2026"): The user belongs EXCLUSIVELY to Weekend 2.2 ("Weekend 2.2", "WE 2.2", "Group 2.2", "Batch 2.2", "WE.02.02"). Extract ONLY items for Weekend 2.2 (or general all-group notices). If a schedule or slot is exclusively for Weekday or another weekend subgroup (like 1.1 or 2.1), IGNORE IT COMPLETELY and return empty extracted_items.
   - For project groups (e.g. "4 Outliers"): Track all team meetings, calls, submission deadlines, and milestone reviews agreed upon by members.
   - For batch groups (e.g. "SLIIT OCTOMBER 2023"): Track general academic notices, exams, and university deadlines.
   - If a notice is exclusively for a different group or module the user doesn't take, IGNORE IT COMPLETELY.
   - Ignore notices containing words in ignoreKeywords unless specifically targeted to user's batchGroup.
2. CONSENSUS CHECK FOR SOCIAL PLANS & MEETINGS:
   - For meetups, team meetings, or picnics, do NOT extract hypothetical questions ("Can we meet Friday?") unless there is clear agreement, confirmation, or an established plan settled in the chat.
3. EVENT CLASSIFICATION & DURATION:
   - LECTURE / VIVA / EXAM / MEETING / MEETUP / PICNIC: Set is_time_blocked = true. If end_time is not explicitly stated, infer a sensible duration based on user_profile.json (e.g., 1 hour for meetings/vivas, 2 hours for lectures, 4 hours for picnics).
   - DEADLINE (Assignment/Project submissions): Set is_time_blocked = false. Set start_time to 30 minutes before the due time and end_time to the exact due time.
4. DEDUPLICATION & UPDATES:
   - Compare extracted items against ALREADY SCHEDULED EVENTS.
   - If the exact event is already scheduled at the same time, set action = "IGNORE".
   - If the chat reschedules or changes the time/venue of an existing event, set action = "UPDATE" and include the target_google_event_id.
   - If it is a brand new event, set action = "CREATE".
5. OUTPUT FORMAT:
   - Return valid JSON matching the exact schema:
     {
       "extracted_items": [
         {
           "action": "CREATE | UPDATE | IGNORE",
           "target_google_event_id": "string or null",
           "title": "Clear, concise title",
           "category": "LECTURE | VIVA | DEADLINE | MEETUP | PICNIC | OTHER",
           "is_time_blocked": true | false,
           "start_time": "YYYY-MM-DDTHH:mm:ss+HH:MM",
           "end_time": "YYYY-MM-DDTHH:mm:ss+HH:MM",
           "location": "Room / Zoom / Unknown",
           "description": "Summary of details",
           "confidence_score": 0.0 to 1.0,
           "reasoning": "Explanation"
         }
       ]
     }
`;
}

/**
 * Builds the User Prompt containing the chat transcript and optional history context
 */
export function buildUserPrompt(
  chatName: string,
  messages: Array<{ sender: string; text: string; timestamp?: string | number }>,
  historyContext?: Array<{ sender: string; text: string }>,
  userProfile?: UserProfile
): string {
  let prompt = `CHAT SOURCE: "${chatName}"\n`;

  if (userProfile) {
    const specificRule = getChatSpecificRule(chatName, userProfile);
    prompt += `SPECIFIC GROUP RULE: ${specificRule}\n\n`;
  } else {
    prompt += `\n`;
  }

  if (historyContext && historyContext.length > 0) {
    prompt += `--- PREVIOUS CONTEXT (Already processed messages for reference) ---\n`;
    for (const msg of historyContext) {
      prompt += `[${msg.sender}]: ${msg.text}\n`;
    }
    prompt += `------------------------------------------------------------------\n\n`;
  }

  prompt += `--- NEW UNPROCESSED MESSAGES TO ANALYZE ---\n`;
  for (const msg of messages) {
    const timeStr = msg.timestamp ? ` [${new Date(msg.timestamp).toLocaleTimeString()}]` : '';
    prompt += `[${msg.sender}${timeStr}]: ${msg.text}\n`;
  }
  prompt += `--------------------------------------------\n\n`;

  prompt += `Extract any relevant, confirmed, or updated schedule items for the user according to the instructions. Respond ONLY with valid JSON.`;

  return prompt;
}

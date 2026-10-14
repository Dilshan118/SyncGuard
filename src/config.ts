import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load environment variables
dotenv.config();

// User Profile Schema
export const ModuleSchema = z.object({
  code: z.string(),
  name: z.string()
});

export const UniversityProfileSchema = z.object({
  institution: z.string().default('University'),
  year: z.number().int().min(1).max(6).default(3),
  semester: z.number().int().min(1).max(2).default(1),
  batchGroup: z.string().default('Weekend 2.2'),
  batchGroupAliases: z.array(z.string()).default([
    'Weekend 2.2',
    'WE 2.2',
    'WE.02.02',
    'Group 2.2',
    'Batch 2.2',
    'WE2.2',
    'Weekend Group 2.2',
    'Y3.S2.WE.02.02'
  ]),
  specialization: z.string().default('Data Science'),
  enrolledModules: z.array(ModuleSchema).default([]),
  ignoreKeywords: z.array(z.string()).default([])
});

export const PrivacyAndSafetySchema = z.object({
  blockAllPersonalDirectMessages: z.boolean().default(true),
  monitoringMode: z.enum(['WHITELIST_ONLY', 'ALL_EXCEPT_MUTED']).default('WHITELIST_ONLY'),
  deleteRawMessagesAfterProcessing: z.boolean().default(true),
  stealthModeNoOnlineStatus: z.boolean().default(true),
  neverSendReadReceipts: z.boolean().default(true)
});

export const SocialPreferencesSchema = z.object({
  trackMeetups: z.boolean().default(true),
  trackPicnicsAndTrips: z.boolean().default(true),
  defaultEventDurationMinutes: z.number().int().positive().default(60),
  defaultPicnicDurationMinutes: z.number().int().positive().default(240)
});

export const MonitoredChatsSchema = z.object({
  mode: z.enum(['ALL_EXCEPT_MUTED', 'WHITELIST_ONLY']).default('WHITELIST_ONLY'),
  whitelistedGroupNames: z.array(z.string()).default([]),
  whitelistedGroupJids: z.array(z.string()).default([]),
  blacklistedGroupNames: z.array(z.string()).default([]),
  groupSpecificRules: z.record(z.string(), z.string()).optional().default({})
});

export const NotificationsConfigSchema = z.object({
  dailyBriefingTime: z.string().default('07:30'),
  alertOnEveryAddedEvent: z.boolean().default(true),
  alertOnConflictsImmediately: z.boolean().default(true)
});

export const UserProfileSchema = z.object({
  userName: z.string().default('User'),
  timezone: z.string().default('Asia/Colombo'),
  privacyAndSafety: PrivacyAndSafetySchema.default({
    blockAllPersonalDirectMessages: true,
    monitoringMode: 'WHITELIST_ONLY',
    deleteRawMessagesAfterProcessing: true,
    stealthModeNoOnlineStatus: true,
    neverSendReadReceipts: true
  }),
  universityProfile: UniversityProfileSchema,
  socialPreferences: SocialPreferencesSchema,
  monitoredChats: MonitoredChatsSchema,
  notifications: NotificationsConfigSchema
});

export type UserProfile = z.infer<typeof UserProfileSchema>;
export type PrivacyAndSafetyConfig = z.infer<typeof PrivacyAndSafetySchema>;
export type EnrolledModule = z.infer<typeof ModuleSchema>;

// Environment schema
const EnvSchema = z.object({
  AI_PROVIDER: z.enum(['gemini', 'anthropic', 'mock']).default('gemini'),
  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),
  ANTHROPIC_API_KEY: z.string().optional().default(''),
  GOOGLE_CLIENT_ID: z.string().optional().default(''),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(''),
  GOOGLE_REDIRECT_URI: z.string().default('http://localhost:3000/oauth2callback'),
  GOOGLE_CALENDAR_ID: z.string().default('primary'),
  DATABASE_PATH: z.string().default('./data/syncguard.db'),
  GOOGLE_TOKEN_PATH: z.string().default('./data/google_token.json'),
  USER_PROFILE_PATH: z.string().default('./config/user_profile.json'),
  AUTH_INFO_PATH: z.string().default('./data/auth_info_baileys'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.string().default('info'),
  BATCH_INTERVAL_CRON: z.string().default('*/3 * * * *'),
  DAILY_BRIEFING_CRON: z.string().default('30 7 * * *')
});

export const env = EnvSchema.parse(process.env);

/**
 * Loads and validates the user profile from JSON file
 */
export function loadUserProfile(filePath: string = env.USER_PROFILE_PATH): UserProfile {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolvedPath)) {
    console.warn(`User profile file not found at ${resolvedPath}, falling back to defaults.`);
    return UserProfileSchema.parse({
      userName: 'Alex',
      timezone: 'Asia/Colombo',
      privacyAndSafety: {
        blockAllPersonalDirectMessages: true,
        monitoringMode: 'WHITELIST_ONLY',
        deleteRawMessagesAfterProcessing: true,
        stealthModeNoOnlineStatus: true,
        neverSendReadReceipts: true
      },
      universityProfile: {
        institution: 'University',
        year: 3,
        semester: 1,
        batchGroup: 'Y3.S1.WE.02',
        specialization: 'Software Engineering',
        enrolledModules: [
          { code: 'SE3010', name: 'Software Quality Assurance' },
          { code: 'SE3020', name: 'Distributed Systems' },
          { code: 'CS3040', name: 'Database Systems' },
          { code: 'IT3050', name: 'Final Year Project' }
        ],
        ignoreKeywords: ['Year 1', 'Year 2', 'Y1S1', 'Y2S2', 'Repeat Exam']
      },
      socialPreferences: {
        trackMeetups: true,
        trackPicnicsAndTrips: true,
        defaultEventDurationMinutes: 60,
        defaultPicnicDurationMinutes: 240
      },
      monitoredChats: {
        mode: 'ALL_EXCEPT_MUTED',
        whitelistedGroupNames: ['Y3S1 Official Notices', 'SE3020 Project Group'],
        blacklistedGroupNames: ['Meme Dump', 'Buy & Sell']
      },
      notifications: {
        dailyBriefingTime: '07:30',
        alertOnEveryAddedEvent: true,
        alertOnConflictsImmediately: true
      }
    });
  }

  try {
    const rawData = fs.readFileSync(resolvedPath, 'utf-8');
    const parsedJson = JSON.parse(rawData);
    return UserProfileSchema.parse(parsedJson);
  } catch (error) {
    console.error(`Failed to load or parse user profile at ${resolvedPath}:`, error);
    throw error;
  }
}

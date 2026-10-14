import { UserProfile, loadUserProfile } from '../config';

export interface PrivacyEvaluationResult {
  allowed: boolean;
  isSelfCommand: boolean;
  command?: string;
}

export interface IncomingMessageContext {
  remoteJid: string;
  selfJid: string;
  groupName?: string;
  text: string;
  fromMe?: boolean;
}

/**
 * Normalizes WhatsApp JIDs by removing device suffixes and lowercasing.
 * E.g., '94771234567:14@s.whatsapp.net' -> '94771234567@s.whatsapp.net'
 */
export function normalizeJid(jid?: string | null): string {
  if (!jid) return '';
  const trimmed = jid.trim().toLowerCase();
  // Strip device identifier: e.g. '12345:2@s.whatsapp.net' -> '12345@s.whatsapp.net'
  return trimmed.replace(/:.*@/, '@');
}

/**
 * Gatekeeper function that inspects every incoming WhatsApp message in memory BEFORE
 * it is ever logged, stored in SQLite, or forwarded to the AI.
 */
export function evaluateIncomingMessage(
  context: IncomingMessageContext,
  userProfile: UserProfile = loadUserProfile()
): PrivacyEvaluationResult {
  const { remoteJid, selfJid, groupName, text, fromMe } = context;

  const normalizedRemote = normalizeJid(remoteJid);
  const normalizedSelf = normalizeJid(selfJid);

  // 1. RULE 1 — Self-Chat Command Check
  // Check if message is from or to the user's own "Message Yourself" chat
  const isSelfChat = normalizedRemote === normalizedSelf || (fromMe && !remoteJid.endsWith('@g.us'));
  if (isSelfChat) {
    const trimmedText = (text || '').trim();
    if (trimmedText.startsWith('!')) {
      return {
        allowed: false,
        isSelfCommand: true,
        command: trimmedText
      };
    }
    // Any other regular self-notes are ignored without processing as group event
    return { allowed: false, isSelfCommand: false };
  }

  // 2. RULE 2 — Hard Block All Personal 1-on-1 Chats
  // Strictly block personal DMs (@s.whatsapp.net, @lid), statuses (status@broadcast), and newsletters (@newsletter)
  const isGroup = remoteJid.endsWith('@g.us');
  if (!isGroup) {
    // CRITICAL: Never log the sender name, JID, or message contents to console!
    return { allowed: false, isSelfCommand: false };
  }

  // 3. RULE 3 — Strict Group Whitelist Only
  const { monitoredChats, privacyAndSafety } = userProfile;
  const monitoringMode = privacyAndSafety.monitoringMode || monitoredChats.mode || 'WHITELIST_ONLY';

  const blacklistedNames = monitoredChats.blacklistedGroupNames || [];
  const whitelistedNames = monitoredChats.whitelistedGroupNames || [];
  const whitelistedJids = monitoredChats.whitelistedGroupJids || [];
  const allWhitelistedEntries = [...whitelistedNames, ...whitelistedJids];

  const normalizeText = (t: string) =>
    (t || '').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF\u2060]/g, '').trim().toLowerCase();

  const cleanGroupNameNorm = normalizeText(groupName || '');

  // Check blacklist first
  if (cleanGroupNameNorm && blacklistedNames.some(b => normalizeText(b) === cleanGroupNameNorm)) {
    return { allowed: false, isSelfCommand: false };
  }

  // Check whitelist if WHITELIST_ONLY mode
  if (monitoringMode === 'WHITELIST_ONLY') {
    const isJidWhitelisted = allWhitelistedEntries.map(normalizeJid).includes(normalizedRemote);
    const isNameWhitelisted = cleanGroupNameNorm
      ? allWhitelistedEntries.some(w => {
          const normW = normalizeText(w);
          if (!normW) return false;
          return (
            normW === cleanGroupNameNorm ||
            cleanGroupNameNorm.includes(normW) ||
            normW.includes(cleanGroupNameNorm)
          );
        })
      : false;

    if (!isJidWhitelisted && !isNameWhitelisted) {
      return { allowed: false, isSelfCommand: false };
    }
  }

  return { allowed: true, isSelfCommand: false };
}

/**
 * Redacts sensitive personal and financial information (credit card numbers,
 * OTP codes, passwords, and API secrets) before saving messages to SQLite.
 */
export function redactSensitiveInfo(text: string): string {
  if (!text) return '';

  let sanitized = text;

  // 1. Credit / Debit Card Numbers (13-19 digits, optional spaces or dashes)
  // Matches: 4532 0150 1234 5678 or 4532-0150-1234-5678 or 4532015012345678
  sanitized = sanitized.replace(/\b(?:\d[ -]*?){13,19}\b/g, match => {
    // Only redact if stripped digits count is between 13 and 19
    const digits = match.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19) {
      return '[REDACTED_CARD]';
    }
    return match;
  });

  // 2. OTP Verification Codes (4 to 8 digits with contextual keywords like OTP, code, pin, verification)
  sanitized = sanitized.replace(
    /\b(?:otp|code|pin|verification\s*code|passcode)\b\s*[:=-]?\s*(\d{4,8})\b/gi,
    (match, code) => match.replace(code, '[REDACTED_OTP]')
  );

  // Standalone high-entropy 6-digit OTP codes (common format: "Your code is 482910")
  sanitized = sanitized.replace(/\b(\d{6})\b/g, (match, code, offset, str) => {
    // Check if surrounded by time indicators like 202610 or date/phone numbers
    const prevText = str.slice(Math.max(0, offset - 15), offset).toLowerCase();
    if (prevText.includes('phone') || prevText.includes('tel') || prevText.includes('+')) {
      return match;
    }
    if (prevText.includes('code') || prevText.includes('otp') || prevText.includes('pin') || prevText.includes('is')) {
      return '[REDACTED_OTP]';
    }
    return match;
  });

  // 3. Passwords and Secret Keys
  sanitized = sanitized.replace(
    /\b(?:password|passwd|pwd|secret|api_key|token)\b\s*[:=]\s*(\S+)/gi,
    (match, secret) => match.replace(secret, '[REDACTED_SECRET]')
  );

  return sanitized;
}

import {
  normalizeJid,
  evaluateIncomingMessage,
  redactSensitiveInfo
} from './whatsapp/privacyFilter';
import { loadUserProfile } from './config';

async function runPrivacyTests() {
  console.log('====================================================');
  console.log('🛡️ Running Privacy & Personal Chat Firewall Tests...');
  console.log('====================================================\n');

  const userProfile = loadUserProfile();
  const selfJid = '94771234567:12@s.whatsapp.net';

  // 1. Test normalizeJid helper
  console.log('1. Testing normalizeJid()...');
  const normalizedSelf = normalizeJid(selfJid);
  const normalizedDirect = normalizeJid('94779876543@s.whatsapp.net');
  const normalizedGroup = normalizeJid('120363011111@g.us');

  console.log(`   Normalized self JID: ${normalizedSelf}`);
  if (normalizedSelf !== '94771234567@s.whatsapp.net') {
    throw new Error(`Expected normalized self JID without device suffix, got: ${normalizedSelf}`);
  }
  console.log('   ✅ normalizeJid() successfully strips device suffixes.\n');

  // 2. Test Rule 1: Self-Chat Commands
  console.log('2. Testing Self-Chat Command Detection (Rule 1)...');
  const selfCommandRes = evaluateIncomingMessage({
    remoteJid: '94771234567:12@s.whatsapp.net',
    selfJid,
    text: '!today',
    fromMe: true
  }, userProfile);

  console.log(`   Command result: allowed=${selfCommandRes.allowed}, isSelfCommand=${selfCommandRes.isSelfCommand}, command=${selfCommandRes.command}`);
  if (selfCommandRes.allowed || !selfCommandRes.isSelfCommand || selfCommandRes.command !== '!today') {
    throw new Error('Self-chat command !today was not recognized properly');
  }

  const selfWeekRes = evaluateIncomingMessage({
    remoteJid: '94771234567@s.whatsapp.net',
    selfJid,
    text: '!week',
    fromMe: true
  }, userProfile);

  if (selfWeekRes.allowed || !selfWeekRes.isSelfCommand || selfWeekRes.command !== '!week') {
    throw new Error('Self-chat command !week was not recognized properly');
  }

  // Non-command message in self-chat (just note to self)
  const selfNoteRes = evaluateIncomingMessage({
    remoteJid: '94771234567@s.whatsapp.net',
    selfJid,
    text: 'Remember to buy groceries',
    fromMe: true
  }, userProfile);
  if (selfNoteRes.allowed || selfNoteRes.isSelfCommand) {
    throw new Error('Self-chat non-command note should be rejected without processing as group event');
  }
  console.log('   ✅ Self-chat command parsing verified.\n');

  // 3. Test Rule 2: Hard Block All Personal 1-on-1 Chats
  console.log('3. Testing Hard Block on Personal DMs, Statuses, and Newsletters (Rule 2)...');
  
  // Personal DM
  const dmRes = evaluateIncomingMessage({
    remoteJid: '94779876543@s.whatsapp.net',
    selfJid,
    text: 'Hey Alex, are you free tomorrow?',
    fromMe: false
  }, userProfile);

  console.log(`   Personal DM: allowed=${dmRes.allowed} (Expected: false)`);
  if (dmRes.allowed) {
    throw new Error('SECURITY VIOLATION: Personal DM was not blocked!');
  }

  // Status broadcast
  const statusRes = evaluateIncomingMessage({
    remoteJid: 'status@broadcast',
    selfJid,
    text: 'Check out my new story!',
    fromMe: false
  }, userProfile);

  console.log(`   Status Broadcast: allowed=${statusRes.allowed} (Expected: false)`);
  if (statusRes.allowed) {
    throw new Error('SECURITY VIOLATION: Status broadcast was not blocked!');
  }

  // Newsletter
  const newsletterRes = evaluateIncomingMessage({
    remoteJid: '120363022222@newsletter',
    selfJid,
    text: 'Daily tech newsletter update',
    fromMe: false
  }, userProfile);

  if (newsletterRes.allowed) {
    throw new Error('SECURITY VIOLATION: Newsletter was not blocked!');
  }
  console.log('   ✅ 100% of personal DMs, status broadcasts, and newsletters are blocked in memory.\n');

  // 4. Test Rule 3: Group Whitelisting & Blacklisting
  console.log('4. Testing Group Whitelist & Blacklist Filters (Rule 3)...');

  // Whitelisted Group
  const whitelistedGroupRes = evaluateIncomingMessage({
    remoteJid: '120363011111@g.us',
    selfJid,
    groupName: 'Y3S1 Official Notices',
    text: 'SE3020 Lab Viva schedule released.',
    fromMe: false
  }, userProfile);

  console.log(`   Whitelisted Group ("Y3S1 Official Notices"): allowed=${whitelistedGroupRes.allowed} (Expected: true)`);
  if (!whitelistedGroupRes.allowed) {
    throw new Error('Whitelisted group was incorrectly blocked');
  }

  // Blacklisted Group
  const blacklistedGroupRes = evaluateIncomingMessage({
    remoteJid: '120363088888@g.us',
    selfJid,
    groupName: 'Meme Dump',
    text: 'Check this hilarious meme haha',
    fromMe: false
  }, userProfile);

  console.log(`   Blacklisted Group ("Meme Dump"): allowed=${blacklistedGroupRes.allowed} (Expected: false)`);
  if (blacklistedGroupRes.allowed) {
    throw new Error('SECURITY VIOLATION: Blacklisted group was not blocked!');
  }

  // Non-Whitelisted Group (Random university society)
  const randomGroupRes = evaluateIncomingMessage({
    remoteJid: '120363099999@g.us',
    selfJid,
    groupName: 'Random Unofficial Society',
    text: 'Join our debate competition tomorrow at 5 PM',
    fromMe: false
  }, userProfile);

  console.log(`   Non-Whitelisted Group ("Random Unofficial Society"): allowed=${randomGroupRes.allowed} (Expected: false)`);
  if (randomGroupRes.allowed) {
    throw new Error('SECURITY VIOLATION: Non-whitelisted group was allowed in WHITELIST_ONLY mode!');
  }
  console.log('   ✅ Group whitelist and blacklist rules verified.\n');

  // 5. Test Rule 4: PII Redaction
  console.log('5. Testing PII Redaction (redactSensitiveInfo)...');
  const sampleWithCard = 'Please pay the bus fee with card 4532 0150 1234 5678 or 4111-2222-3333-4444 thanks!';
  const redactedCard = redactSensitiveInfo(sampleWithCard);
  console.log(`   Original: "${sampleWithCard}"`);
  console.log(`   Redacted: "${redactedCard}"`);
  if (redactedCard.includes('4532') || redactedCard.includes('1234 5678') || redactedCard.includes('4111')) {
    throw new Error('Card numbers were not cleanly redacted');
  }
  if (!redactedCard.includes('[REDACTED_CARD]')) {
    throw new Error('Missing [REDACTED_CARD] replacement');
  }

  const sampleWithOtp = 'Your verification code is 482910. Do not share your OTP 8921 with anyone.';
  const redactedOtp = redactSensitiveInfo(sampleWithOtp);
  console.log(`   Original: "${sampleWithOtp}"`);
  console.log(`   Redacted: "${redactedOtp}"`);
  if (redactedOtp.includes('482910') || redactedOtp.includes('8921')) {
    throw new Error('OTP codes were not redacted');
  }
  if (!redactedOtp.includes('[REDACTED_OTP]')) {
    throw new Error('Missing [REDACTED_OTP] replacement');
  }

  const sampleWithPassword = 'Host database login password: MySuperSecretPass!123 for Lab 3.';
  const redactedPassword = redactSensitiveInfo(sampleWithPassword);
  console.log(`   Original: "${sampleWithPassword}"`);
  console.log(`   Redacted: "${redactedPassword}"`);
  if (redactedPassword.includes('MySuperSecretPass!123')) {
    throw new Error('Password was not redacted');
  }
  if (!redactedPassword.includes('[REDACTED_SECRET]')) {
    throw new Error('Missing [REDACTED_SECRET] replacement');
  }
  console.log('   ✅ PII Redactor successfully sanitized cards, OTPs, and passwords.\n');

  console.log('====================================================');
  console.log('🎉 ALL PRIVACY FIREWALL TESTS PASSED!');
  console.log('====================================================');
}

runPrivacyTests().catch((err) => {
  console.error('❌ Privacy Firewall Test Failed:', err);
  process.exit(1);
});

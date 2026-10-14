import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config';

const authDir = path.resolve(process.cwd(), env.AUTH_INFO_PATH);

console.log('====================================================');
console.log('🧹 WhatsApp Authentication Reset Utility');
console.log('====================================================\n');

if (fs.existsSync(authDir)) {
  fs.rmSync(authDir, { recursive: true, force: true });
  console.log(`✅ Successfully purged session credentials from:\n   ${authDir}\n`);
} else {
  console.log(`ℹ️ No session directory found at:\n   ${authDir}\n`);
}

console.log('👉 Next time you start SyncGuard (npm start), a fresh QR code will be generated.');
console.log('====================================================');

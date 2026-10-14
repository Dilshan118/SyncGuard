import fs from 'node:fs';
import path from 'node:path';

const targetPkgPath = path.resolve(process.cwd(), 'node_modules/whatsapp-rust-bridge/package.json');

if (fs.existsSync(targetPkgPath)) {
  try {
    const pkg = JSON.parse(fs.readFileSync(targetPkgPath, 'utf8'));
    if (pkg.exports && pkg.exports['.']) {
      let modified = false;
      if (!pkg.exports['.'].require) {
        pkg.exports['.'].require = './dist/index.js';
        modified = true;
      }
      if (!pkg.exports['.'].default) {
        pkg.exports['.'].default = './dist/index.js';
        modified = true;
      }
      if (modified) {
        fs.writeFileSync(targetPkgPath, JSON.stringify(pkg, null, 4), 'utf8');
        console.log('✅ Successfully patched whatsapp-rust-bridge exports for Node 26 / CommonJS compatibility.');
      }
    }
  } catch (err) {
    console.warn('Could not patch whatsapp-rust-bridge:', err);
  }
}

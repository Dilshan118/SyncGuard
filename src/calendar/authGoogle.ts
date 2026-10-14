import http from 'node:http';
import url from 'node:url';
import { getOAuth2Client, generateAuthUrl, saveGoogleTokens } from './googleClient';
import { env } from '../config';

async function main() {
  console.log('====================================================');
  console.log('🔐 Google Calendar OAuth2 Setup Helper');
  console.log('====================================================\n');

  const oauth2Client = getOAuth2Client();
  if (!oauth2Client) {
    console.error('❌ Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env.');
    console.error('Please create your OAuth 2.0 Credentials in Google Cloud Console:');
    console.error('1. Go to https://console.cloud.google.com/apis/credentials');
    console.error('2. Create an "OAuth 2.0 Client ID" with Application type: Web application');
    console.error(`3. Set Authorized redirect URIs to: ${env.GOOGLE_REDIRECT_URI}`);
    console.error('4. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your .env file.');
    process.exit(1);
  }

  const port = env.PORT || 3000;
  const redirectUrl = new URL(env.GOOGLE_REDIRECT_URI);
  const callbackPath = redirectUrl.pathname || '/oauth2callback';

  const authUrl = generateAuthUrl();

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = url.parse(req.url || '', true);

      if (parsedUrl.pathname === callbackPath) {
        const code = parsedUrl.query.code as string;
        const error = parsedUrl.query.error as string;

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`<h3>Authentication Failed: ${error}</h3>`);
          console.error(`❌ Authentication error: ${error}`);
          server.close();
          process.exit(1);
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h3>Missing authorization code</h3>');
          return;
        }

        console.log('🔄 Exchanging authorization code for tokens...');
        const { tokens } = await oauth2Client.getToken(code);
        saveGoogleTokens(tokens, env.GOOGLE_TOKEN_PATH);

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <div style="font-family: system-ui, -apple-system, sans-serif; text-align: center; margin-top: 50px;">
            <h2 style="color: #10b981;">✅ SyncGuard Successfully Connected to Google Calendar!</h2>
            <p>Tokens saved to <code>${env.GOOGLE_TOKEN_PATH}</code>.</p>
            <p>You can close this browser tab and return to the terminal.</p>
          </div>
        `);

        console.log(`\n🎉 Success! Tokens saved to: ${env.GOOGLE_TOKEN_PATH}`);
        console.log('You can now run SyncGuard with real Google Calendar synchronization.');

        setTimeout(() => {
          server.close();
          process.exit(0);
        }, 1000);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    } catch (err) {
      console.error('Error handling oauth callback:', err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error');
      server.close();
      process.exit(1);
    }
  });

  server.listen(port, () => {
    console.log(`📡 Local callback listener listening on port ${port}...`);
    console.log('\n👉 Open the following URL in your browser to authorize Google Calendar:\n');
    console.log(`\x1b[36m${authUrl}\x1b[0m\n`);
    console.log('Waiting for approval in browser...');
  });
}

main().catch((err) => {
  console.error('Error during OAuth flow:', err);
  process.exit(1);
});

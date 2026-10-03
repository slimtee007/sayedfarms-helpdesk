// Each browser-test run uses a disposable database, never backend/db.json.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'helpdesk-mobile-'));
Object.assign(process.env, {
  PORT: '5100', DATA_FILE: join(dir, 'db.json'), NODE_ENV: 'development',
  JWT_SECRET: 'mobile-tests-only-not-for-production',
  ADMIN_EMAIL: 'admin@mobile.test', ADMIN_PASSWORD: 'MobileTest!234',
  SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', RATE_LIMIT_SCALE: '100',
  PBX_ENABLED: 'true', PBX_TRANSPORT: 'webhook', PBX_IT_EXTENSIONS: '204',
});
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
await import('../../backend/server.js');

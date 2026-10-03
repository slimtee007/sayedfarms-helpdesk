import { Buffer } from 'node:buffer';
import { test, expect } from '@playwright/test';

const password = 'MobileTest!234';
const email = () => `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
async function login(page, account = 'admin@mobile.test', pass = password) {
  await page.goto('/');
  await page.getByLabel('Email Address', { exact: true }).fill(account);
  await page.getByLabel('Password', { exact: true }).fill(pass);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByTitle('Sign Out')).toBeVisible();
}
async function fits(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
}
async function dialogFits(page) {
  const dialog = page.getByRole('dialog').last();
  await expect(dialog).toBeVisible();
  const box = await dialog.locator(':scope > *').first().boundingBox();
  const viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  await fits(page);
  return dialog;
}
async function workspace(page, name) {
  const menu = page.getByRole('button', { name: 'Show workspaces' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('navigation', { name: 'Workspaces' }).getByRole('link', { name, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (error) => { throw error; });
});

test('authentication, search, request attachment, ticket chat, cancellation and logout', async ({ page }) => {
  await page.goto('/');
  await fits(page);
  await page.getByRole('button', { name: 'Sign up', exact: true }).click();
  await page.getByLabel('Full Name').fill('Mobile Employee');
  await page.getByLabel('Email Address').fill(email());
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create Account', exact: true }).click();
  await expect(page.getByTitle('Sign Out')).toBeVisible();
  await fits(page);
  await page.getByLabel('Search request types').fill('no-such-request');
  await expect(page.getByRole('status')).toContainText('No request types found');
  await page.getByLabel('Search request types').fill('hardware');
  await expect(page.getByRole('button', { name: /^Logins and Accounts/ })).toHaveCount(0);
  await page.getByRole('button', { name: /^Computers/ }).click();
  await page.getByRole('heading', { name: 'Report broken hardware', exact: true }).click();
  const dialog = await dialogFits(page);
  await dialog.locator('input[type=text]').fill('Mobile screen issue');
  await dialog.getByPlaceholder('Provide extra detail about your issue...').fill('Display flickers when using the workstation.');
  await dialog.locator('select').nth(0).selectOption({ label: 'IT Admin' });
  await dialog.locator('select').nth(2).selectOption('Urgent');
  await dialog.locator('input[type=file]').setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64') });
  const created = page.waitForResponse((r) => r.url().endsWith('/api/tickets') && r.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Create Request' }).click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const ticket = await response.json();
  expect(ticket.image).toContain('data:image/png');
  expect(ticket.priority).toBe('Urgent');
  expect(ticket.assigned_to_id).toBeTruthy();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /My Requests/ }).click();
  await expect(page.getByText('Mobile screen issue', { exact: true })).toBeVisible();
  await fits(page);
  await page.getByRole('button', { name: 'Chat', exact: true }).click();
  const chat = await dialogFits(page);
  await chat.locator('input').fill('Please help with this screen');
  await chat.getByRole('button', { name: 'Send message' }).click();
  await expect(chat.getByText('Please help with this screen')).toBeVisible();
  await chat.getByRole('button', { name: 'Close ticket chat' }).click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Cancel Request' }).click();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
  await page.getByTitle('Sign Out').click();
  await expect(page.getByRole('button', { name: 'Sign In', exact: true })).toBeVisible();
});

test('agent navigation, all workspace layouts, reports and CSV downloads', async ({ page }) => {
  await login(page);
  for (const [name, heading] of [
    ['Queues & Tickets', 'Service Desk Queues'], ['Call Log', 'PBX Call Log'],
    ['Call Reports', 'PBX Call Report'], ['MTTR Reports', 'Resolution Time (MTTR)'],
    ['IT Assets', 'Asset Inventory'], ['Asset Reports', 'Asset Stock Report'], ['User Management', 'User Directory'],
  ]) {
    await workspace(page, name);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await fits(page);
    if (name.includes('Reports')) {
      const csv = page.getByRole('button', { name: /CSV/ }).first();
      await expect(csv).toBeEnabled();
      const download = page.waitForEvent('download');
      await csv.click();
      expect((await download).suggestedFilename()).toMatch(/\.csv$/);
    }
  }
});

test('live chat fits the screen and sends a real message', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Live Chat Console' }).click();
  await fits(page);
  const panel = page.locator('.live-chat > div');
  const box = await panel.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  await page.getByPlaceholder('Type reply as IT Agent...').fill('Mobile chat check');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(panel.getByText('Mobile chat check')).toBeVisible();
  await page.getByRole('button', { name: 'Close live chat' }).click();
});

test('asset creation dialog scrolls, saves and deletes', async ({ page }) => {
  await login(page);
  await workspace(page, 'IT Assets');
  await page.getByRole('button', { name: 'Add IT Asset' }).click();
  const dialog = await dialogFits(page);
  await dialog.getByPlaceholder('MacBook Pro 16 M2').fill('Mobile test asset');
  await dialog.getByPlaceholder('SN-8942-X1').fill(`QA-${Date.now()}`);
  await dialog.getByRole('button', { name: /Save|Add Asset|Create/ }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const row = page.getByRole('row').filter({ hasText: 'Mobile test asset' });
  await expect(row).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await row.locator('button').last().click();
  await expect(row).toHaveCount(0);
});

test('password reset: invalid login, development OTP, change email and new password', async ({ page, request }) => {
  const account = email();
  expect((await request.post('/api/auth/signup', { data: { name: 'Reset Employee', email: account, password } })).ok()).toBe(true);
  await page.goto('/');
  await page.getByLabel('Email Address').fill(account);
  await page.getByLabel('Password', { exact: true }).fill('incorrect');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByText(/Invalid email or password/i)).toBeVisible();
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await page.getByPlaceholder('name@sayedfarms.com').fill(account);
  const otpResponse = page.waitForResponse((r) => r.url().endsWith('/api/auth/forgot-password'));
  await page.getByRole('button', { name: 'Send Verification Code' }).click();
  const { devOtp } = await (await otpResponse).json();
  expect(devOtp).toBeTruthy();
  await fits(page);
  await page.getByRole('button', { name: 'Change Email' }).click();
  await expect(page.getByText(devOtp, { exact: true })).toHaveCount(0);
  const nextOtpResponse = page.waitForResponse((r) => r.url().endsWith('/api/auth/forgot-password'));
  await page.getByRole('button', { name: 'Send Verification Code' }).click();
  const nextOtp = (await (await nextOtpResponse).json()).devOtp;
  await page.getByPlaceholder('Enter 6-digit OTP').fill(nextOtp);
  await page.getByPlaceholder('Enter new password').fill('ChangedPassword!234');
  await page.getByRole('button', { name: 'Reset Password', exact: true }).click();
  await expect(page.getByText(/Password updated successfully/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign In', exact: true })).toBeVisible();
  await login(page, account, 'ChangedPassword!234');
});

test('PBX: manual call, notes, outcome, search, directory and parser preview', async ({ page }) => {
  await login(page);
  await workspace(page, 'Call Log');
  await page.getByRole('button', { name: 'Log a call', exact: true }).click();
  const dialog = await dialogFits(page);
  await dialog.getByLabel('Extension', { exact: true }).fill('204');
  const caller = String(Date.now()).slice(-10);
  await dialog.getByLabel('Caller number (external)', { exact: true }).fill(caller);
  await dialog.getByPlaceholder('Printer in the accounts office is not printing.').fill('Mobile PBX issue');
  await dialog.getByRole('button', { name: 'Log call', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const row = page.getByRole('row').filter({ hasText: caller }).first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Notes', exact: true }).click();
  const notes = await dialogFits(page);
  await notes.locator('textarea').fill('Checked and repaired from mobile');
  await notes.getByRole('button', { name: 'Save notes' }).click();
  await expect(row).toContainText('Checked and repaired from mobile');
  await row.getByTitle('Was the issue raised on this call solved?').selectOption('Solved');
  await expect(row.getByTitle('Was the issue raised on this call solved?')).toHaveValue('Solved');
  await page.getByPlaceholder('Search caller, number, notes…').fill(caller);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('main tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Show extension directory' }).click();
  await page.getByLabel('Extension', { exact: true }).fill(caller.slice(-5));
  await page.getByLabel('Department', { exact: true }).fill('Mobile QA');
  await page.getByRole('button', { name: 'Map extension' }).click();
  const extension = page.getByRole('row').filter({ hasText: 'Mobile QA' });
  await expect(extension).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await extension.getByTitle('Remove', { exact: true }).click();
  await expect(extension).toHaveCount(0);
  await page.getByRole('button', { name: 'Test a record' }).click();
  const parser = await dialogFits(page);
  await parser.locator('textarea').fill("21/09/25 14:32:10 204 01 +2348031234567 0'12 00:03'45 AN");
  await parser.getByRole('button', { name: 'Read records' }).click();
  await expect(parser.getByText(/1 record\(s\) understood/)).toBeVisible();
  await dialogFits(page);
});

test('user management promotion, ticket dispatch, resolution and restricted agent navigation', async ({ page, request }) => {
  const account = email();
  const created = await request.post('/api/auth/signup', { data: { name: 'Dispatch QA', email: account, password } });
  const employee = await created.json();
  const title = `Dispatch ticket ${Date.now()}`;
  expect((await request.post('/api/tickets', { headers: { Authorization: `Bearer ${employee.token}` }, data: { title, description: 'Dispatch test', category: 'Hardware', priority: 'Medium' } })).ok()).toBe(true);
  await login(page);
  await workspace(page, 'User Management');
  const row = page.getByRole('row').filter({ hasText: account });
  await row.locator('select').first().selectOption('agent');
  await expect(row.getByTitle('Ticket access level')).toBeVisible();
  await workspace(page, 'Queues & Tickets');
  const ticket = page.getByRole('row').filter({ hasText: title });
  await ticket.getByTitle('Reassign this ticket').selectOption(employee.user.id);
  await expect(ticket.getByTitle('Reassign this ticket')).toHaveValue(employee.user.id);
  await ticket.getByRole('button', { name: 'Quick Resolve' }).click();
  await expect(ticket.locator('select').first()).toHaveValue('Resolved');
  await page.getByTitle('Sign Out').click();
  await login(page, account);
  await expect(page.getByRole('heading', { name: 'My Assigned Tickets' })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: title })).toBeVisible();
  const menu = page.getByRole('button', { name: 'Show workspaces' });
  if (await menu.isVisible()) await menu.click();
  await expect(page.getByRole('link', { name: 'User Management', exact: true })).toHaveCount(0);
  await expect(page.getByTitle('Reassign this ticket')).toHaveCount(0);
  await fits(page);
});

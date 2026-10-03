# Mobile review & feature verification

**Reviewed:** 2026-10-03  
**Verdict:** Tested core workflows pass after fixes. This is not a certification
that every feature works on every physical device or production integration.

## Results

| Check | Result |
| --- | --- |
| Backend API / Socket.IO / PBX regression suite | **75 / 75 passed** |
| Browser workflow suite | **28 / 28 passed** (7 workflows × 4 viewport sizes) |
| Production frontend build | Passed |
| Frontend lint | 0 errors; 11 remaining warnings in existing application code |
| Dependency audit | Frontend: 0 vulnerabilities; backend: 1 high-severity vulnerable dependency (`nodemailer`) |

Browser execution used Chromium 153 in this sandbox with mobile/touch emulation
at **320×568**, **393×851**, and tablet **768×1024**, plus desktop **1440×900**.
Playwright-managed browser downloads were blocked here, so an externally supplied
Chromium executable was used. The committed suite defaults to Playwright's own
Chromium and supports `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` as an override.
Screenshots of the 390px agent queue, navigation and asset form were also inspected.
Tests used a scratch database and local test accounts, not production data.

## Fixed during this review

1. **Desktop sidebar occupied phone content space.** Workspaces now collapse
   behind a touch-friendly toggle on narrow screens and close on link selection.
   Desktop navigation remains visible.
2. **Headers, report controls and chart content overflowed.** Headers and MTTR
   controls wrap; the hourly-call chart scrolls inside its own container; report
   grid children can shrink. Browser tests check document-level horizontal overflow.
3. **Dialogs exceeded small/short viewports.** Dialogs now have a dynamic-height
   limit and internal scrolling. Phone forms stack two-column fields and keep
   file inputs inside the panel.
4. **Chat panels were wider than small phones.** Floating chats use viewport-bound
   width/height; message inputs can shrink and long message text wraps. Dialogs
   appear above the floating chat launcher. Close/send icon buttons have labels.
5. **Small form text and touch targets.** Phone inputs use 16px text to avoid iOS
   focus zoom, with 44px-high inputs/buttons and wider icon-only buttons. Physical
   iOS keyboard behavior still needs device verification.
6. **Portal search did nothing.** It now filters the available request categories
   and their descriptions, with a no-results message. Its placeholder no longer
   promises article search (there is no article search service here).
7. **Password reset retained stale development codes after Change Email.** The
   code, entered OTP and new password are cleared; OTP supports numeric input and
   one-time-code autofill.
8. **Distinct manually entered calls were rejected as duplicates.** Incoming
   manual calls with different caller numbers but the same minute, extension and
   duration collided. Dedupe now also considers caller and direction for manual
   records, while preserving existing keys and exact-replay rejection. Added a
   backend regression test.
9. **PBX tests depended on the day of the month.** Fixtures generated DD/MM/YY
   records but the test server defaulted to MM/DD/YY. On October 3, a call could
   be interpreted as March 10. Test configuration now matches its fixture format;
   production date-parsing defaults are unchanged.

Ticket tables intentionally retain horizontal scrolling rather than dropping
columns/actions. Their summaries have a minimum readable width and a phone-only
swipe hint.

## Browser workflows exercised

- Signup, invalid sign-in, successful sign-in, logout, employee vs agent routing.
- Password reset using the **development OTP**, change-email state, new-password login.
- Portal request-type search and no-results handling.
- Request creation with an image, urgency and direct assignment to an agent;
  per-ticket message submission; request cancellation.
- Agent navigation across queues, call log, call reports, MTTR, assets, asset
  reports and user management; report CSV downloads.
- Live chat message submission and receipt of the server echo.
- Asset creation, scrolling the form to its submit action, and deletion.
- Manual PBX call logging, call notes, solved outcome, search, extension mapping
  and removal, parser dry-run.
- Employee promotion to agent, ticket reassignment and quick resolution; regular
  agents see their assigned queue without user-management/reassignment controls.

The backend suite additionally tests authorization boundaries, live ticket-chat
routing between users, reset expiry/restart behavior, asset statuses/categories,
stock thresholds, report calculations/exports, PBX simulation, TCP transports,
call deduplication, persistence and ticket/call resolution synchronization.

## Remaining risks / verification required

- **Dependency security:** `npm audit` identifies Nodemailer advisories, including
  high-severity address-parser denial-of-service issues. The audit's proposed
  fix is a major upgrade (10.0.13 at review time). This review does not silently
  apply that upgrade; upgrade and validate SMTP behavior before production release.
- **Real email delivery:** SMTP is not configured in this sandbox. Development
  reset codes work, but inbox delivery, spam handling and provider authentication
  were not verified.
- **Physical Panasonic PBX:** Parsers, simulated calls and local TCP tests pass;
  the site's real feed, credentials, time zone and console date format need an
  onsite check. Set `PBX_DATE_FORMAT` / `PBX_DAY_FIRST` to match the console.
- **Physical devices / Safari:** Chromium emulation is not an iPhone Safari test.
  Check keyboard opening, rotation, safe areas, image picking/camera and scrolling
  on real Android and iOS devices. Native print / Save as PDF was not exercised.
- **Not exhaustively covered in the browser:** clipboard invitation copying,
  every inline-edit combination, network disconnect/reconnect, and session expiry.
  API coverage is broader than UI coverage, but does not replace these checks.
- **Accessibility follow-up:** full keyboard/focus-trap and screen-reader audits
  were not performed. Some legacy clickable request rows and unlabeled fields
  remain outside the improved authentication/chat controls.
- **Existing code warnings:** effect dependencies, state-in-effect and an
  initialization warning remain. Lint passes with warnings, not a clean slate.
- The sidebar's “All services operational” text is static, not a health check;
  do not use it as proof of SMTP/PBX availability.

## Reproduce

```bash
npm ci --prefix backend
npm test --prefix backend
npm ci --prefix frontend
cd frontend
npx playwright install --with-deps chromium
npm run test:mobile
npm run build
npm run lint
```

Browser tests start their own API on 5100 and Vite on 5174; those ports must be
free. Failure traces/screenshots are written to ignored `frontend/test-results/`.
The CI workflow now includes the browser suite; its remote run was not triggered
as part of this local review.

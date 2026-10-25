# TG Entertainment: Netlify and Supabase

The production configuration uses Netlify for the website, PWA and API functions, and Supabase for Postgres and uploaded files. The deployment budget is $0. No paid Render service or disk is required or provisioned.

## Architecture

Netlify builds the repository with base directory promote, command npm run build, and publish directory dist. Modern functions serve /api/* and /media/uploads/*, with a minute-based maintenance function for reminders, retry jobs and billing.

The API uses a loopback HTTP adapter to preserve Express routing, cookies, binary output and permission checks. Postgres I/O runs in a worker to preserve existing synchronous booking/payment transactions. A shared advisory lock coordinates writes across instances; job leases prevent concurrent senders claiming the same pending notification.

Public media uses the public Storage bucket. Payment proofs and private client deliveries use a private bucket and 60-second signed links issued after authorization. Private content stays outside the service-worker cache.

Files upload directly to signed, size-limited private staging buckets, avoiding Netlify's buffered request limit. The original API validates and processes each file before publishing it. Consumed staging locations retain an empty object until their signed token expires, preventing replay.

Notification delivery starts after writes through context.waitUntil. Visible pages refresh every 15 seconds in serverless mode; the local server retains SSE. Device Web Push is independent of page refresh and requires visitor permission.

Production credentials are not shared with deploy previews. Configure separate staging infrastructure before enabling previews.

## Runtime variables

Set these in the Netlify project's production Functions environment:

| Variable | Purpose |
| --- | --- |
| DATABASE_URL | Private tg_app role on the Supabase transaction pooler, port 6543 |
| SUPABASE_URL | Project HTTPS API origin |
| SUPABASE_SERVICE_ROLE_KEY | Server-only Storage credential |
| APP_URL | Public HTTPS website origin |
| BASE_DOMAIN | Website hostname without scheme or path |
| TENANT_ROUTING | path for the initial Netlify address |
| NODE_ENV | production |
| TRUST_PROXY | 1 for the controlled loopback adapter |
| VAPID_SUBJECT | Real operator contact email |
| AWS_LAMBDA_JS_RUNTIME | nodejs24.x; configure through Netlify, not TOML |

The Supabase extension's SUPABASE_DATABASE_URL is also accepted as the API origin. Use Other with no public variable prefix. Never use a VITE_ prefix for credentials. Postgres TLS verifies the certificate and hostname; DATABASE_SSL_CA can supply a trusted provider CA if needed.

The private schema enables RLS and grants no browser access. Only the private backend role accesses records; the API enforces tenant, staff, guest-link and global-administrator permissions.

## Existing data and limits

The existing administrator, password hash, Web Push signing keys, branding, services, event, booking and proof records were copied to the dedicated project. All uploaded files were verified against their original SHA-256 checksums. The local database, uploads and backups remain outside source control.

Localhost sessions, rate-limit counters and origin-bound browser push subscriptions/jobs are not transferred. Sign in and enable notifications on the final HTTPS address. Fans need no account.

The schema generator is node scripts/supabase-schema.mjs. A trusted database administrator provisions the private role, grants/policies and login credentials. Never commit a real password. Run Supabase advisors after schema changes.

General uploads are limited to 200 MiB per business. The project limit is 800 MiB, including active reservations, with 64 MiB reserved for payment-proof headroom. Proof uploads remain available when a business fills its general-media allowance. MEDIA_BUSINESS_BYTES and MEDIA_PROJECT_BYTES override them. Upload processing needs temporary headroom. These limits protect free storage and do not enable billing or charge anyone.

Free provider quotas and inactivity policies apply. Unlimited media, bandwidth and uninterrupted service above those allowances are not included. Techverse retains control of billing activation, invoices and screenshot approval.

## Publish and verify

Connect the private GitHub repository Techverse-Global-Industry/Entertain to the Netlify project and deploy main using the repository-root netlify.toml. Uploading dist alone omits the backend and scheduled function.

Verify the actual deployed HTTPS address:

- /api/health and bootstrap return API data.
- /p/mchenry displays the saved brand, profile, manifest and PNG icon.
- The existing administrator can sign in and open /dashboard/mchenry.
- Public uploads, private proofs and private download permissions work.
- Booking availability, transfer review, free/paid tickets and staff check-in work.
- Supported real devices receive notifications after granting permission.

Techverse can generate a separate owner invitation for Henry. Do not share the global-administrator login with a business owner.

Separate promoter origins need owned domains/subdomains and HTTPS ingress. Initial /p/slug addresses share browser storage and notification permission. A Netlify project address does not supply arbitrary nested promoter subdomains.

## Local development

The local server continues using SQLite and .data/uploads. node scripts/backup.mjs backs up that installation. Local recovery scripts do not change Supabase accounts.

npm test verifies the business stories and cloud adapters; npm run build builds the frontend. Netlify's cloud build must package and validate production functions before publication is considered complete.

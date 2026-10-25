# Deploying Promote on Netlify

Netlify serves the built website and PWA. A persistent Node.js service runs the existing API, SQLite database, uploaded media and scheduled notification/billing work. The current backend is not a Netlify Function: it needs a mounted data volume and a process that remains running.

## Deployment layout

- Netlify builds `promote` with Node.js 24, runs `npm run build`, and publishes `promote/dist`.
- The local build plugin configures signed proxy rules for `/api/*` and `/media/uploads/*`. These rules run before the SPA fallback. API requests, private payment screenshots and uploaded videos reach the Node service at the same public website origin.
- Netlify signs proxied requests with HS256. The API verifies the signature, expiration, Netlify project ID and public origin before accepting a forwarded host. Session cookies stay Secure and HttpOnly. Private API responses use `Cache-Control: no-store`.
- Built-in flyers, application assets, the service worker and offline page are published as static files. Private data, backups, passwords, sessions and uploaded payment proofs stay outside the publish directory.
- The build fails if a persistent backend or proxy signing key is missing. Preview deploys require an explicitly configured staging backend.

## Hosting needed

Use one persistent Node.js 24 service with a mounted data volume. The included Dockerfile uses `/app/data`; the Render Blueprint uses the native Node runtime and `/var/data`. The same service handles HTTP, uploaded media and the existing scheduler; no separate worker is needed for this version. Configure its health check as `/api/health`.

An existing VPS/container host can run this. A Render Starter service with a 1 GB persistent disk is another option; confirm its current price and workspace before provisioning. Do not use an ephemeral disk or a sleeping free instance for the live database and scheduled alerts.

Netlify account access and a backend host have not been configured for this project yet. This document and `netlify.toml` prepare deployment; they do not mean a production site is already published.

## Paid Render backend

The repository's [render.yaml](../render.yaml) defines one new `tg-entertainment-api` web service in Frankfurt. It uses paid `0.5c-512mb` compute, Node.js 24.22.1, and a 1 GB persistent disk mounted at `/var/data`. `DATA_DIR` points at that mount. Paid compute avoids the free plan's idle spin-down screen.

Pricing checked on 25 October 2026: $7/month compute plus $0.25/month for the disk, before taxes, bandwidth and any workspace charges. This initial disk is for Henry's demonstration and must be sized for actual media usage before wider onboarding. Committing this file does not provision resources or start charges.

Create the Netlify project first. During Blueprint setup, supply its actual HTTPS origin as `APP_URL`, its hostname as `BASE_DOMAIN`, its project ID as `NETLIFY_SITE_ID`, and a securely generated shared `PROMOTE_PROXY_SECRET` of at least 32 characters. Put the same key in Netlify's Builds and Runtime scopes. Keep secret values out of source control and chat.

The connected Render creation tool cannot attach persistent disks. Apply this complete Blueprint in the Render Dashboard after approving the cost. Review the new service and disk together; the existing `tg-promote-demo` and `tg-arena-preview` services are separate projects.

[Open the backend Blueprint](https://dashboard.render.com/blueprint/new?repo=https://github.com/Techverse-Global-Industry/Entertain)

Transfer the current database snapshot and uploaded files securely to `/var/data` before inviting Henry to sign in. Do not commit or publish the backup. An empty deployment has no copy of the current administrator, saved profile changes or booking/payment records.

## Environment configuration

In Netlify, set:

| Variable | Value |
| --- | --- |
| `PROMOTE_BACKEND_URL` | The actual HTTPS backend origin, without a path |
| `PROMOTE_PROXY_SECRET` | A random value of at least 32 characters, shared with the backend |

The signing key must be available in both **Builds** and **Runtime** scopes. Do not use a `VITE_` prefix for this key or put its value in source files. It is referenced by name in proxy rules and never added to browser JavaScript.

Configure the backend using `.env.netlify.example`. Set `APP_URL` to the real public HTTPS Netlify origin, `BASE_DOMAIN` to that origin's hostname, and `NETLIFY_SITE_ID` to the Netlify project ID. Both hosts must use the same signing key. `DATA_DIR` must point at the mounted volume. Set a real Web Push contact email.

## Initial addresses and separate promoter domains

Set `TENANT_ROUTING=path` for the first `*.netlify.app` address. MC Henry then opens at `/p/mchenry`, and the app does not redirect visitors to unconnected subdomains. The address displayed in the workspace and registration form follows this setting.

For independent business origins and installations, connect a domain Techverse owns, configure its wildcard DNS/HTTPS and hosting ingress, then use `TENANT_ROUTING=subdomain`. A `*.netlify.app` project address does not provide arbitrary nested promoter subdomains. Several branded profiles on one origin share browser storage and notification permission; choose the final domains before inviting fans to install.

## Preserve the current administrator and uploaded files

Create a fresh consistent backup with `node scripts/backup.mjs`. Transfer the SQLite snapshot and accompanying `uploads` folder securely to the backend's mounted data directory before opening production to visitors. Preserve the database's Web Push keys. Do not commit the database or place a backup in `dist` or `public`.

Check that the migrated administrator, Henry's saved branding, existing event, and uploaded pictures appear correctly. If the backend starts with an empty database, it will require new administrator setup; it will not automatically contain the existing login or records.

## Build and publish

Run the normal checks locally:

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run test:e2e
```

Create or select the intended Netlify project, add its environment variables, and deploy from the repository root so `netlify.toml` is used. With an authenticated CLI, use `netlify deploy --build --prod`. Uploading `dist` through a generic drag-and-drop deployment bypasses the build plugin and does not configure the API routes.

After publication, verify the actual HTTPS URL: public profile, administrator login, saved branding, upload preview and media delivery, booking submission, payment proof review, free/paid ticket flows, private-ticket retrieval and staff check-in. Check service-worker updates and notification delivery on real Android/iOS devices.

Netlify proxy requests have a documented 26-second timeout. The dashboards reconnect SSE and also refresh periodically; browser push delivery comes from the persistent backend. Verify streamed video/range requests and larger uploads on the actual deployment before sharing it widely.

## References

- [Netlify rewrites and signed proxies](https://docs.netlify.com/manage/routing/redirects/rewrites-proxies/)
- [Netlify build plugins](https://docs.netlify.com/extend/install-and-use/)
- [Netlify environment variable scopes](https://docs.netlify.com/build/environment-variables/overview/)
- [Render persistent disks](https://render.com/docs/disks)

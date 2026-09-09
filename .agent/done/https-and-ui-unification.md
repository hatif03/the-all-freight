# Fix production /ops mixed-content failure; unify UI to the light theme

## What happened

User reported `/ops` failing to load in production (Chrome's own "This page couldn't load" interstitial, not a React error). Both the page and the backend returned 200 via curl — the failure was browser-side: the Vercel site is HTTPS, but `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_WS_URL` pointed at plain `http://`/`ws://` on the GCE VM's `:8000`. Browsers block or fail that combination ("mixed content").

## Fix: real TLS in front of the backend

- Installed Caddy on the VM, reverse-proxying `localhost:8000`.
- Used a [nip.io](https://nip.io) hostname (`136-119-139-202.nip.io`, resolves publicly to the VM's static IP) so Caddy could obtain a genuine Let's Encrypt certificate with no owned domain — confirmed via `openssl s_client`, not just "it loaded."
- Opened firewall 80/443 (`allow-ops-room-https`).
- Verified both HTTPS (`curl https://.../health`) and WSS (PowerShell's native WebSocket client, since neither `ws` npm package nor a rebuildable local Python venv were available in-session) actually connect and stream data — not just that the cert exists.
- Updated Vercel's `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_WS_URL` to the HTTPS/WSS URL and redeployed; confirmed the new URL is actually baked into the deployed JS bundle (grepped the specific chunk, not just assumed the env var took effect).

## Fix: unify /ops's UI with the rest of the app

The user wants the whole app to look like the landing page — `/ops` had its own dark "war room" palette (`--ops-bg`, `--ops-surface`, etc. in `globals.css`) distinct from the light planning-flow theme.

Because the ops console consistently uses semantic Tailwind classes tied to those CSS custom properties (`bg-ops-surface`, `border-ops-line`, `text-ops-mute`, ...) rather than hardcoded colors, the fix was a single small edit: **remapped the `--ops-*` variables in `globals.css` to alias the existing light-theme tokens** (`--ops-bg: var(--background)`, `--ops-surface: var(--panel)`, etc.) instead of touching every class name across `src/app/ops/page.tsx` and `src/components/VesselMap.tsx`. Verified first that neither file had hardcoded dark-theme-only colors that would resist this (they didn't — the only hardcoded hex values were already semantic: danger red, ok green, accent-2 blue, warn amber, which read fine on either background).

Also switched `VesselMap.tsx`'s MapLibre basemap style from CartoDB's dark-matter to its light positron style, so the map itself matches the now-light surrounding chrome.

## Verification

- `npx tsc --noEmit` clean.
- Local dev server compiled `/ops` with no errors after the change.
- Deployed to Vercel; both `/` and `/ops` return 200 in production.
- No headless-browser tool was available in this session (no `chromium-cli`, no `ws` npm package, local Python venv locked by running processes) — the CSS-variable-remap approach was chosen specifically because it's low-risk by construction (pure color substitution, no logic/markup change), not because visual output was screenshotted. Worth an actual look in a browser to confirm it reads well.

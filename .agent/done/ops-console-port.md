# Port ops console to `/ops`

## What
Port `freight-room-main/frontend/app/console/page.tsx` (war-room dashboard: vessel
map, live room feed, options list, approve/reject gate, dossier link) into
`src/app/ops/page.tsx` for this app (Next 16 / React 19 / Tailwind v4).

## Plan
- Extract the MapLibre vessel/anchorage map into `src/components/VesselMap.tsx`
  (mirrors the `RouteMap.tsx` component-extraction convention already used here).
- New page uses the shared `Header` for branding/nav (already links to `/ops`);
  add a slim ops-specific status/context bar below it (incident id, port, phase,
  live-AIS pill, room-bus connection pill, refresh button) instead of a second
  logo — avoids two stacked brand headers.
- Reuse existing theme tokens (`accent`, `accent-2`, `ok`, `warn`, `danger`,
  `border`, `muted`) for all semantic colors that map directly (live→ok,
  action→accent-2, warn→warn, alert→danger). Add a small new set of dark
  "ops" surface/text tokens to `globals.css` (`ops-bg`, `ops-surface`,
  `ops-line`, `ops-ink`, `ops-mute`, `ops-faint`) since the console is a
  distinct dark "war room" surface not present in the light planning-flow
  theme — not the whole reference palette, just what's used.
- Add one new blink keyframe/utility for status dots; reuse the existing
  `.pulse-ring` keyframe for the live-AIS ping instead of adding another.
- Rename all "Band"/"Freight Room" wording to generic room-bus terms
  ("room feed", "room bus connected") per the no-reference-name rule.
- Add "Refresh live tariff" button calling `POST /admin/tariffs/refresh`,
  showing `{loaded, source_url}` inline for a few seconds.
- Confirm `service/backend/main.py` CORS is already correct (it is — no change).

## Verify
- `npx tsc --noEmit` clean.
- grep for forbidden reference names in `src/app/ops` and `src/components` empty.
- `npm run dev` renders `/ops` without a backend running.

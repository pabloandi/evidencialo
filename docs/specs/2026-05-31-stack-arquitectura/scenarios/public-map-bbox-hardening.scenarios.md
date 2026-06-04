---
name: public-map-bbox-hardening
created_by: orchestrator
created_at: 2026-06-04T00:00:00Z
step: 11
note: additive scenarios from the step11 quality review (edge-case CRITICAL geography/geometry index bypass + in-RPC invariants + deterministic truncation). Sibling holdout to public-map-bbox.scenarios.md.
---

# Scenarios — public map bbox hardening (review findings)

The first cut compared the geography `location` against a GEOMETRY envelope,
which forces a `location::geometry` cast and defeats the geography GIST index
(`reports_location_gix`) — turning the bbox read into a full table scan, the
exact thing the design exists to avoid. It also put the area cap only in the HTTP
`parseBbox` (the anon key can call the RPC directly, bypassing it) and capped at
2000 rows with no ORDER BY (silent, non-deterministic truncation). Hold alongside
SCEN-001..004.

---

## SCEN-H01: the bbox query is served by the GIST index, not a sequential scan
**Given**: the `reports_in_view` function and the geography GIST index `reports_location_gix` on `reports.location`
**When**: the bbox predicate is planned (the indexable side must be geography, matching the index type)
**Then**: the query uses the index — `EXPLAIN` shows an Index/Bitmap-Index scan on `reports_location_gix`, NOT a Seq Scan on `reports`
**Evidence**: pgTAP — `set enable_seqscan = off; explain (format text) select * from public.reports_in_view(...)` output contains a scan on `reports_location_gix` (i.e. the predicate is index-eligible; a geometry-cast predicate would be unable to use the geography index)

## SCEN-H02: the RPC enforces the bbox invariants itself (not only the HTTP layer)
**Given**: a caller invoking `reports_in_view` DIRECTLY (e.g. with the anon key, bypassing the route's `parseBbox`)
**When**: it passes an out-of-range, inverted (min>=max), or oversized (>5° span) bounding box
**Then**: the function refuses it (raises an error) rather than running an unbounded/whole-world scan — the database is the security boundary, with the HTTP `parseBbox` 400 as the fast first line
**Evidence**: pgTAP — `select reports_in_view(-180,-90,180,90)` (a >5° world box) raises an exception (`throws_ok`); an inverted box likewise; a valid city box still returns rows

## SCEN-H03: a dense viewport truncates deterministically and signals it
**Given**: more visible reports inside the box than the result cap (use an injectable/small cap for the test)
**When**: the bbox read runs
**Then**: the returned rows are the NEWEST by `created_at` (deterministic order, so a cached response is stable and meaningful), and the caller is told the result was truncated (a response header or flag — not silent loss)
**Evidence**: integration — with a small cap and N>cap matching reports, the response is ordered newest-first AND carries a truncation signal (e.g. an `X-Result-Truncated: true` header); when under the cap, no truncation signal is present

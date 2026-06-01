-- 0001_extensions.sql
-- Enable PostGIS for geolocation. Reports carry a geography(Point) location and
-- the public map queries them by bounding box (GIST index, step 03 + 11).
--
-- PostGIS lives in the dedicated `extensions` schema (Supabase best practice —
-- keeps `public` clean and is flagged by the schema linter otherwise).

create extension if not exists postgis with schema extensions;

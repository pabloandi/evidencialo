-- 0013_solver_enum.sql
-- Subsystem B (solvers): add the `solver` actor to the user_role enum.
--
-- This is ALONE in its own migration on purpose. Postgres forbids using a newly
-- added enum value in the SAME transaction that adds it (ERROR: unsafe use of
-- new value), and Supabase runs each migration file in one transaction. So the
-- value is added here; everything that references the `'solver'` literal
-- (private.is_solver(), grant_solver, RLS) lives in 0014.
alter type public.user_role add value if not exists 'solver';

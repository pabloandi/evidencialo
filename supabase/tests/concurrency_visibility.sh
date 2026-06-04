#!/usr/bin/env bash
# SCEN-H01 concurrency proof for the visibility trigger (step08 hardening).
#
# pgTAP runs in a single transaction and cannot express concurrency, so this
# harness drives TWO overlapping psql sessions against the local DB to prove the
# `for no key update` lock closes the dual-writer READ COMMITTED race:
#
#   Tx1: BEGIN; UPDATE media A -> 'processed'        (holds the report row lock)
#   Tx2: BEGIN; UPDATE media B -> 'processed'        (BLOCKS on the row lock)
#   Tx1: COMMIT                                       (releases; Tx2 unblocks)
#   Tx2: COMMIT                                       (re-reads committed sibling)
#   assert: is_visible = true  (report NOT stranded invisible)
#
# Without the lock both transactions would compute is_visible=false under READ
# COMMITTED and the report would be stranded. We also assert Tx2 actually
# blocked (proving serialization, not luck): pg_stat_activity shows it waiting
# on a lock while Tx1 is still open.
#
# Usage: bash supabase/tests/concurrency_visibility.sh
set -euo pipefail

DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
PSQL=(psql "$DB_URL" -v ON_ERROR_STOP=1 -qtA)

R='30000000-0000-0000-0000-0000000000c1'  # report
A='30000000-0000-0000-0000-0000000000a1'  # media A
B='30000000-0000-0000-0000-0000000000b1'  # media B

cleanup() {
  "${PSQL[@]}" -c "delete from public.reports where id = '$R';" >/dev/null 2>&1 || true
  rm -f /tmp/vis_tx1.fifo
}
trap cleanup EXIT

# --- Seed: report with two pending media (autocommit) ----------------------
"${PSQL[@]}" <<SQL
delete from public.reports where id = '$R';
insert into public.reports (id, category_id, location, is_visible)
select '$R', c.id, 'SRID=4326;POINT(-74.08 4.70)'::extensions.geography, false
from public.categories c where c.slug = 'bache';
insert into public.report_media (id, report_id, storage_path, type, processing_state) values
  ('$A', '$R', 'c1/a.jpg', 'image', 'pending'),
  ('$B', '$R', 'c1/b.jpg', 'image', 'pending');
SQL

born_visible=$("${PSQL[@]}" -c "select is_visible from public.reports where id = '$R';")
echo "seed: is_visible (born) = $born_visible   (expect f)"

# --- Tx1: open, update A, hold the lock; a FIFO gates its COMMIT -----------
rm -f /tmp/vis_tx1.fifo
mkfifo /tmp/vis_tx1.fifo

(
  # The cat blocks reading the FIFO until the main script writes to it, which
  # keeps Tx1's transaction open (lock held) until we say go.
  {
    echo "begin;"
    echo "update public.report_media set processing_state = 'processed' where id = '$A';"
    cat /tmp/vis_tx1.fifo >/dev/null   # block here (gate only), holding the lock
    echo "commit;"
  } | "${PSQL[@]}" >/tmp/vis_tx1.out 2>&1
) &
TX1_PID=$!

# Give Tx1 time to acquire the row lock.
sleep 1

# --- Tx2: start in the background; it will BLOCK on the for-no-key-update lock
(
  "${PSQL[@]}" <<SQL >/tmp/vis_tx2.out 2>&1
begin;
update public.report_media set processing_state = 'processed' where id = '$B';
commit;
SQL
) &
TX2_PID=$!

# Give Tx2 time to reach the lock wait.
sleep 1

# --- Prove Tx2 is actually BLOCKED waiting on a lock (not finished) ---------
blocked=$("${PSQL[@]}" -c "
  select count(*) from pg_stat_activity
  where state = 'active' and wait_event_type = 'Lock'
    and query ilike '%report_media%processed%where id = ''$B''%';")
echo "Tx2 blocked on lock while Tx1 open = $blocked   (expect >= 1)"

# --- Release Tx1 -> it commits -> Tx2 unblocks -> Tx2 commits ---------------
echo "go" > /tmp/vis_tx1.fifo
wait $TX1_PID
wait $TX2_PID

# --- Assert final state -----------------------------------------------------
final=$("${PSQL[@]}" -c "select is_visible from public.reports where id = '$R';")
echo "final: is_visible = $final   (expect t)"

if [[ "$final" == "t" && "$blocked" -ge 1 ]]; then
  echo "RESULT: PASS  (SCEN-H01 — concurrent dual-writer publish, lock serialized)"
  exit 0
else
  echo "RESULT: FAIL  (final=$final blocked=$blocked)"
  exit 1
fi

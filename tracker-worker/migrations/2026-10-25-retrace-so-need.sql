-- Oct 25, 2026: Retrace's sales-order link backfill. Serial history names a sales order (FSO…) but leaves the WO number blank; the link
-- (inv_so_wo) comes from label details or a WO upload. The sweep hands the collector sales orders with no link (soNeed); this table keeps
-- the ones in flight (claimed) and the ones whose label details really had no WorkOrderId (none_at), so they aren't asked again for a day.
-- New table only, safe to apply twice. Apply BEFORE deploying the Worker (the sweep tolerates a missing table, but then asks again every pass):
--   npx wrangler d1 execute aethernet-tracker --remote --file migrations/2026-10-25-retrace-so-need.sql
CREATE TABLE IF NOT EXISTS inv_so_need (
  store INTEGER NOT NULL, sales_order TEXT NOT NULL,
  claimed_until TEXT,                  -- handed to a browser until then (a failed read comes back after it)
  none_at TEXT,                        -- label details were read for real and carried no WorkOrderId for this sales order
  PRIMARY KEY (store, sales_order)
);

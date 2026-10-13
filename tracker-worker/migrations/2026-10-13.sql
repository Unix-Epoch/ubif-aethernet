-- Portal's work order status names (from Portal's own code: ubif-util-store's status enum).
-- Status IDs alone appear in status histories (auditTrail) and change rows; join this table for names.
CREATE TABLE IF NOT EXISTS statuses (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
INSERT OR REPLACE INTO statuses (id, name) VALUES
  (1, 'Initial check-in'), (2, 'Need to order'), (3, 'Awaiting item'), (4, 'Awaiting device'), (5, 'Awaiting diagnostics'),
  (6, 'Awaiting partner approval'), (7, 'Awaiting callback'), (8, 'Ready for work'), (9, 'Diagnostics'), (10, 'Work in progress'),
  (11, 'Quality check'), (12, 'Repair summary'), (13, 'Ready for pickup'), (14, 'Sale complete'), (15, 'Closed'),
  (17, 'Device abandoned'), (22, 'Request buyout/replacement'), (23, 'Transferred to depot'), (24, 'Ready for Diag'),
  (25, 'Cancelled'), (26, 'Send to depot'), (27, 'Shipped by depot');

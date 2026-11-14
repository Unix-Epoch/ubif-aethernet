-- Nov 14, 2026: Portal's list row facts for the phone's work order cards. issues: JSON list of Portal's issue names
-- (deviceIssues, e.g. ["Screen"]); attention: Portal's attentionState when warning or urgent, else NULL. Sent by scripts
-- from this change on; rows from older scripts keep NULL issues (unknown, not "none").
ALTER TABLE workorders ADD COLUMN issues TEXT;
ALTER TABLE workorders ADD COLUMN attention TEXT;

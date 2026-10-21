-- Oct 21, 2026: Assize rules as node graphs, edited and published on the admin site (page 'rules' · src/assize.js).
-- New tables only. Apply: npx wrangler d1 execute aethernet-tracker --remote --file migrations/2026-10-21-assize-rules.sql
-- One row per rule and scope: 'all' (every store) or a store number as text ('914', that store's override).
CREATE TABLE IF NOT EXISTS assize_rules (
  rule TEXT NOT NULL,                  -- kebab-case rule id (Assize's code rules, or a graph-only rule made on the admin site)
  scope TEXT NOT NULL,                 -- 'all' or a store number as text
  draft TEXT,                          -- graph JSON being edited · NULL = none
  draft_errors TEXT,                   -- JSON list of the draft's errors (drafts may be invalid · publishing refuses them)
  draft_by TEXT, draft_at TEXT,
  published TEXT,                      -- graph JSON Assize runs · NULL = the code rule (or nothing, for a graph-only rule)
  published_version INTEGER NOT NULL DEFAULT 0,
  published_by TEXT, published_at TEXT,
  enabled INTEGER,                     -- 1 on, 0 off (raises nothing, code or graph), NULL = follow 'all' (for 'all': on)
  note TEXT,
  created_by TEXT, created_at TEXT,
  PRIMARY KEY (rule, scope)
);
-- Every publish (with its graph, so any version can come back) and every other change to a rule.
CREATE TABLE IF NOT EXISTS assize_rule_history (
  id INTEGER PRIMARY KEY,
  rule TEXT NOT NULL, scope TEXT NOT NULL,
  version INTEGER,                     -- publish: the new version · revert: the version copied into the draft
  graph TEXT,                          -- publish: the graph published · NULL for the other actions
  by_email TEXT, at TEXT NOT NULL, note TEXT,
  action TEXT NOT NULL                 -- publish | revert | delete | enable | disable | inherit | create
);
CREATE INDEX IF NOT EXISTS arh_rule ON assize_rule_history (rule, id);

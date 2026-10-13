-- Live database, Oct 12, 2026: RFP value without partner credits; two-step "gone".
ALTER TABLE workorders ADD COLUMN cart_value REAL;
ALTER TABLE workorders ADD COLUMN gone_seen_at TEXT;
ALTER TABLE workorders ADD COLUMN service_outcome TEXT;
UPDATE workorders SET cart_value = (SELECT ROUND(SUM(COALESCE(json_extract(value, '$.netPrice'), json_extract(value, '$.price'), 0) * ABS(COALESCE(json_extract(value, '$.quantity'), 1))), 2)
  FROM json_each(json_extract(plain, '$.cart.items')) WHERE UPPER(COALESCE(json_extract(value, '$.sku'), '')) != 'PCEXEMPT') WHERE json_extract(plain, '$.cart') IS NOT NULL;

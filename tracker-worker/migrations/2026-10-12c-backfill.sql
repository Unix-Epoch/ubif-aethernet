-- Backfill last_cart_value / last_cart_tax / sold_at from stored snapshots' plain parts.
UPDATE workorders SET
  last_cart_value = (SELECT (SELECT ROUND(SUM(COALESCE(json_extract(i.value, '$.netPrice'), json_extract(i.value, '$.price'), 0) * ABS(COALESCE(json_extract(i.value, '$.quantity'), 1))), 2)
      FROM json_each(json_extract(s.plain, '$.cart.items')) i WHERE UPPER(COALESCE(json_extract(i.value, '$.sku'), '')) != 'PCEXEMPT')
    FROM snapshots s WHERE s.store = workorders.store AND s.wo = workorders.wo AND json_array_length(json_extract(s.plain, '$.cart.items')) > 0 ORDER BY s.id DESC LIMIT 1),
  last_cart_tax = (SELECT json_extract(s.plain, '$.cart.payment.tax')
    FROM snapshots s WHERE s.store = workorders.store AND s.wo = workorders.wo AND json_array_length(json_extract(s.plain, '$.cart.items')) > 0 ORDER BY s.id DESC LIMIT 1),
  sold_at = CASE WHEN json_extract(plain, '$.workorder.statusId') = 14 THEN json_extract(plain, '$.workorder.updatedAt') END; -- the Sale complete version's updatedAt (Portal's status history stops before it)

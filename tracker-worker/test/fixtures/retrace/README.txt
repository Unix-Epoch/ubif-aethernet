Retrace fixtures: hand-written copies of Portal's answers as captured at store 914 on Oct 23, 2026.
Same field names, envelopes and value kinds; every id, label, staff name, PO / sales order / journal number and
price is made up. Staff IP addresses (WO events' metadata) are TEST-NET placeholders, there to prove they are dropped.
Used by test/retrace.test.mjs.

inventory-lookup.json is the exception: its envelope and row fields are as captured from live Portal at store 914 on Oct 24, 2026
({ "$id", "OnHandItemDetails": [rows], "TotalRecords", "ErrorMessage", "Success", "DebugMessage" }; rows "$id", ItemNumber, ProductName, SiteId, WarehouseId,
OnHandQuantity, InTransitQuantity, ReservedQuantity, SalesOnOrder, AvailableQuantity, BackOrderedQyantity, SalesPrice, RetailCategory, VanNickName, LocalPrice,
ModifiedDateTime). The values here are still sample (and Success / ModifiedDateTime are guesses; the capture showed them truncated).
Portal also lists quantity-only SKUs there (e.g. 900348, "Generic - Liquid Glass (Individual)", 9,995 in stock, no labels); the tests build those inline.

wo-salesorder.json: GET /api/workorder/{wo}/salesorder/{csuCartId} (Oct 26, 2026). Top-level keys and line keys are the ones captured live by Garrett
for a sold WO at 914 on Oct 25, 2026 (vault "Retrace and Tracker Interop" → "Sold work order parts"): salesId, salesLines, cartId, salesDate, storeId,
payment { amountPaid, subtotal, discount, tax, total }, paymentTypes; lines lineId, lineNumber, productId, name, price, grossAmount, quantity, serial,
serialStatus, sku, lineType, isChild, parentLineId, isScanned, program, originalLineId. Part lines carry serial + serialStatus "Sold"; labor / credit
lines an empty serial; the BB0001 buyback line a B- serial (Available). Every VALUE here is made up, and the value kinds of lineId, productId,
lineType for a part line, salesDate's format and storeId's type are GUESSES until a raw answer is saved over this file.

label-details.json no longer has a SerialNumber: the real answer names no label (captured Oct 26, 2026). Its values are still made up
(the WorkOrderId-filled case is synthetic: both live samples had WorkOrderId ""). label-details-live.json and rma-orders-live.json are the
live captures of Oct 26, 2026 (dev tools probes): keys exact, null where the capture showed no value; nothing else is filled in.

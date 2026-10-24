Retrace fixtures: hand-written copies of Portal's answers as captured at store 914 on Oct 23, 2026.
Same field names, envelopes and value kinds; every id, label, staff name, PO / sales order / journal number and
price is made up. Staff IP addresses (WO events' metadata) are TEST-NET placeholders, there to prove they are dropped.
Used by test/retrace.test.mjs.

inventory-lookup.json is the exception: its envelope and row fields are as captured from live Portal at store 914 on Oct 24, 2026
({ "$id", "OnHandItemDetails": [rows], "TotalRecords", "ErrorMessage", "Success", "DebugMessage" }; rows "$id", ItemNumber, ProductName, SiteId, WarehouseId,
OnHandQuantity, InTransitQuantity, ReservedQuantity, SalesOnOrder, AvailableQuantity, BackOrderedQyantity, SalesPrice, RetailCategory, VanNickName, LocalPrice,
ModifiedDateTime). The values here are still sample (and Success / ModifiedDateTime are guesses; the capture showed them truncated).
Portal also lists quantity-only SKUs there (e.g. 900348, "Generic - Liquid Glass (Individual)", 9,995 in stock, no labels); the tests build those inline.

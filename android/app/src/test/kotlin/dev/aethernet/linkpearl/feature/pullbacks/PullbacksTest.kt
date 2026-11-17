package dev.aethernet.linkpearl.feature.pullbacks

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.nio.file.Files

/** Pullbacks: the .xlsx reader/writer, the list rules (the same as Aethernet's Elusive Jump and scan_serials.py), a run, the view model. Fake data. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class PullbacksTest {
    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    /** A PowerBI-style export: a filter row and a blank row above the header, a qualified Serial header, entities, Total + filter rows. */
    private val export: List<List<Any?>> = listOf(
        listOf("Applied filters: owner is Someone"), emptyList(),
        listOf("Store", "SKU", "Description", "'Unique Serials'[Serial]", "Return Units", "Return Value", "Consignment Status"),
        listOf("Test Store #900", 100002.0, "Phone B Screen", "S-2", 1.0, 12.422999999999998, 1.0),
        listOf("Test Store #900", 100001.0, "iPad 11&quot; Glass &amp; LCD", "s-1", 1.0, 40.0, 1.0),
        listOf("Other Store #901", 100003.0, "Phone C Battery", "S-3", 1.0, 3.25, 0.0),
        listOf("Test Store #900", 100004.0, "No serial", null, 1.0, 1.0, 1.0),
        listOf("Total", null, null, null, 3.0, 55.75, 2.0),
    )
    private fun exportBytes() = Pullbacks.writeXlsx(export, emptyList(), "Export")

    @Test fun xlsxRoundTrip() {
        val rows = Pullbacks.readXlsx(Pullbacks.writeXlsx(listOf(listOf("A", "B", "C"), listOf("x & <y>", 12.422999999999998, null), listOf(true, 0.0, "z")), listOf(null, Pullbacks.Fill.Ok), "S"))
        assertEquals(listOf(listOf("A", "B", "C"), listOf("x & <y>", 12.422999999999998), listOf(true, 0.0, "z")), rows)
    }

    @Test fun prefixedPowerBiXml() {
        // PowerBI writes <x:row>/<x:c> without cell references; the reader drops the prefix and counts cells in order.
        val zip = java.io.ByteArrayOutputStream()
        java.util.zip.ZipOutputStream(zip).use { z ->
            fun put(n: String, t: String) { z.putNextEntry(java.util.zip.ZipEntry(n)); z.write(t.toByteArray()); z.closeEntry() }
            put("xl/workbook.xml", "﻿<x:workbook xmlns:x=\"m\"><x:sheets><x:sheet name=\"Export\" sheetId=\"1\" r:id=\"R1\" xmlns:r=\"r\" /></x:sheets></x:workbook>")
            put("xl/_rels/workbook.xml.rels", "<Relationships><Relationship Type=\"w\" Target=\"/xl/worksheets/sheet1.xml\" Id=\"R1\" /></Relationships>")
            put("xl/worksheets/sheet1.xml", "<x:worksheet><x:sheetData><x:row><x:c t=\"inlineStr\"><x:is><x:t>Serial</x:t></x:is></x:c><x:c t=\"inlineStr\"><x:is><x:t>SKU</x:t></x:is></x:c></x:row>" +
                "<x:row><x:c t=\"inlineStr\"><x:is><x:t>A-1</x:t></x:is></x:c><x:c s=\"8\"><x:v>104184</x:v></x:c></x:row></x:sheetData></x:worksheet>")
        }
        assertEquals(listOf(listOf("Serial", "SKU"), listOf("A-1", 104184.0)), Pullbacks.readXlsx(zip.toByteArray()))
    }

    @Test fun exportRules() {
        val list = Pullbacks.parse(Pullbacks.readXlsx(exportBytes()))
        assertEquals(false, list.results)
        assertEquals(listOf("Test Store #900" to 2, "Other Store #901" to 1), Pullbacks.stores(list.items))
        val mine = Pullbacks.forStore(list.items, "Test Store #900")
        assertEquals(listOf("iPad 11\" Glass & LCD", "Phone B Screen"), mine.map { it.description })
        assertEquals("100001", mine[0].skuText)
        assertEquals("900", Pullbacks.storeNum("Test Store #900"))
    }

    @Test fun resultsFileLayoutAndReadBack() {
        val list = Pullbacks.parse(Pullbacks.readXlsx(exportBytes())).let { it.copy(items = Pullbacks.forStore(it.items, "Test Store #900")) }
        val s = PbSession("Pullback Serials.xlsx", "Test Store #900", list).scan("S-1", now = "2026-11-16T15:00:00").skip()
        val back = Pullbacks.readXlsx(Pullbacks.results(s.list))
        assertEquals(listOf("Store", "SKU", "Description", "'Unique Serials'[Serial]", "Return Units", "Return Value", "Consignment Status",
            "Scanned Serial", "Match", "Status", "Scanned At", "Backend Status", "Backend Message", "Backend At"), back[0])
        assertEquals(listOf("Test Store #900", 100001.0, "iPad 11\" Glass & LCD", "s-1", 1.0, 40.0, 1.0, "S-1", "YES", "matched", "2026-11-16T15:00:00"), back[1].take(11))
        assertEquals("skipped", back[2][9])
        val again = Pullbacks.parse(back)
        assertTrue(again.results)
        assertEquals(PbStatus.Matched, again.items[0].status)
        assertEquals("Pullback Serials - 900 - Scan Results.xlsx", Pullbacks.fileName("Pullback Serials.xlsx", "Test Store #900"))
        assertEquals("Pullback Serials - 900 - Scan Results.xlsx", Pullbacks.fileName("Pullback Serials - 900 - Scan Results.xlsx", "Test Store #900"))
    }

    @Test fun scanOrder() {
        // The same list as Aethernet's test-client/pullbacks.mjs "scan order".
        val input = listOf(
            "iPhone 12 Back Camera (Non OEM)", "iPhone 11 Charging Port Flex, Black (Non OEM)", "Galaxy S22 - 128GB - Black - Renewed 2",
            "iPhone 11 Pro Glass/LCD, Select LCD Non OEM", "iPad Air 2 Battery (Non-OEM)", "iPhone 6 Glass/ LCD, White, Select Non-OEM",
            "iPhone 12 Wifi Flex", "iPhone 13 Ear Speaker Sensor Flex", "Samsung Galaxy S23 Ultra Back Glass, Lavender, GH97-28420D",
            "iPhone 7 Proximity Sensor/Front Camera/Front Mic Flex (Non OEM)", "iPhone 7 Dock Connector Flex, Black", "iPhone 11 Front Camera (Non OEM)",
        )
        val out = listOf(
            "iPhone 6 Glass/ LCD, White, Select Non-OEM", "iPhone 11 Pro Glass/LCD, Select LCD Non OEM", "iPad Air 2 Battery (Non-OEM)",
            "iPhone 7 Dock Connector Flex, Black", "iPhone 11 Charging Port Flex, Black (Non OEM)", "iPhone 11 Front Camera (Non OEM)",
            "iPhone 12 Back Camera (Non OEM)", "iPhone 13 Ear Speaker Sensor Flex", "iPhone 7 Proximity Sensor/Front Camera/Front Mic Flex (Non OEM)",
            "iPhone 12 Wifi Flex", "Samsung Galaxy S23 Ultra Back Glass, Lavender, GH97-28420D", "Galaxy S22 - 128GB - Black - Renewed 2",
        )
        assertEquals(out, input.mapIndexed { i, d -> PbItem("S #1", 100.0 + i, d, "X-$i") }.sortedWith(Pullbacks.scanOrder).map { it.description })
        val same = listOf(PbItem("S #1", 2.0, "iPhone 11 Battery", "B"), PbItem("S #1", 2.0, "iPhone 11 Battery", "A"), PbItem("S #1", 1.0, "iPhone 11 Battery", "C"))
        assertEquals(listOf("C", "A", "B"), same.sortedWith(Pullbacks.scanOrder).map { it.serial })
        assertEquals("cameras", Pullbacks.category("iPhone 16 Front Camera Module With Flex (Non OEM)"))
    }

    @Test fun csv() {
        val list = Pullbacks.parse(Pullbacks.readCsv("Store,SKU,Description,Serial\r\n\"Test Store #900\",1,\"A, b\",S-9\r\n"))
        assertEquals("A, b", list.items[0].description)
        assertEquals("S-9", list.items[0].serial)
    }

    @Test fun badFiles() {
        assertEquals("No Serial column in this file.", runCatching { Pullbacks.parse(listOf(listOf("A", "B"))) }.exceptionOrNull()?.message)
        assertEquals("This isn't an .xlsx file.", runCatching { Pullbacks.readXlsx(ByteArray(10)) }.exceptionOrNull()?.message)
    }

    @Test fun scanning() {
        val list = PbList(listOf("Store", "SKU", "Description", "Serial"), listOf(
            PbItem("S #1", 1.0, "A", "A-1"), PbItem("S #1", 2.0, "B", "B-2"), PbItem("S #1", 3.0, "C", "C-3")))
        var s = PbSession("f.xlsx", "S #1", list)
        assertEquals(0, s.idx)
        s = s.scan(" a-1 ")                            // trimmed, case-insensitive
        assertEquals(PbStatus.Matched, s.items[0].status); assertEquals(1, s.idx); assertTrue(s.lastOk)
        s = s.scan("WRONG")
        assertEquals(PbMsg.Mismatch, s.msg); assertEquals(1, s.idx)
        s = s.acceptAnyway()
        assertEquals(PbStatus.Overridden, s.items[1].status); assertEquals("WRONG", s.items[1].scanned); assertEquals("OVERRIDE", s.items[1].match)
        s = s.skip()
        assertNull(s.idx); assertTrue(s.complete)
        s = s.undo()
        assertEquals(2, s.idx); assertEquals(PbStatus.Pending, s.items[2].status); assertEquals(PbMsg.Reverted, s.msg)
        s = s.skip().scanSkipped()
        assertEquals(2, s.idx)
        assertEquals(PbMsg.Empty, s.scan("  ").msg)
    }

    @Test fun viewModelPicksThePhonesStoreAndSaves() {
        val store = MemoryPbStore()
        val vm = PullbackViewModel(store, myStores = listOf(901), io = Dispatchers.Main)
        vm.open("Pullback Serials.xlsx", exportBytes())
        val st = vm.state.value as PbUi.Stores
        assertEquals("Other Store #901", st.stores.first().first)
        assertEquals("Other Store #901", st.selected)
        vm.pickStore("Test Store #900")
        assertEquals(52.422999999999998, (vm.state.value as PbUi.Stores).value!!, 1e-9)
        vm.start()
        val scanning = vm.state.value as PbUi.Scanning
        assertEquals(2, scanning.s.total)
        vm.scan("s-1")
        assertEquals(1, store.saved!!.done)
        assertEquals("Pullback Serials - 900 - Scan Results.xlsx", vm.results()!!.first)
    }

    @Test fun fileStoreResumes() {
        val dir = Files.createTempDirectory("pb").toFile()
        val fs = FilePbStore(dir)
        val list = Pullbacks.parse(Pullbacks.readXlsx(exportBytes())).let { it.copy(items = Pullbacks.forStore(it.items, "Test Store #900")) }
        fs.save(PbSession("x.xlsx", "Test Store #900", list).scan("S-1"))
        val back = fs.load()!!
        assertEquals(1, back.idx); assertEquals(listOf(0), back.history); assertEquals(1, back.done)
        fs.clear(); assertNull(fs.load())
    }
}

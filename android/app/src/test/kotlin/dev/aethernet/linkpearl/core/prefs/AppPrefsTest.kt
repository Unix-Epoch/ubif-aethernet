package dev.aethernet.linkpearl.core.prefs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppPrefsTest {
    @Test fun darkAndLightIgnoreThePhone() {
        assertTrue(Appearance.Dark.isDark(systemDark = false)); assertTrue(Appearance.Dark.isDark(true))
        assertFalse(Appearance.Light.isDark(systemDark = true)); assertFalse(Appearance.Light.isDark(false))
    }

    @Test fun followPhoneUsesThePhone() {
        assertTrue(Appearance.System.isDark(true)); assertFalse(Appearance.System.isDark(false))
    }

    @Test fun storedKeysRoundTripAndUnknownMeansDark() {
        Appearance.entries.forEach { assertEquals(it, Appearance.fromKey(it.key)) }
        assertEquals(Appearance.Dark, Appearance.fromKey(null)); assertEquals(Appearance.Dark, Appearance.fromKey("purple"))
    }

    @Test fun memoryPrefsReadBackSynchronously() {
        val p = MemoryAppPrefs(Appearance.Light)
        assertEquals(Appearance.Light, p.appearanceNow())
    }
}

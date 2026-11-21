package nz.joshp.sink.ui

internal fun editorLoadText(pageReady: Boolean, loadedNote: String?, current: String): String? =
    if (pageReady && loadedNote != null) current else null

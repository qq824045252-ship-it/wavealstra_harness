package com.mybuddy.remote

import android.content.ClipboardManager
import android.content.Context
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "RemoteClipboard")
class RemoteClipboardPlugin : Plugin() {
    @PluginMethod
    fun readText(call: PluginCall) {
        activity.runOnUiThread {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            val clip = clipboard.primaryClip
            val text = if (clip != null && clip.itemCount > 0) clip.getItemAt(0).coerceToText(context)?.toString() ?: "" else ""
            call.resolve(JSObject().apply { put("text", text) })
        }
    }
}

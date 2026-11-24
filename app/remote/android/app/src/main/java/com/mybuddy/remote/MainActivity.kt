package com.mybuddy.remote

import android.content.res.Configuration
import android.os.Bundle
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.capacitorjs.plugins.app.AppPlugin
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(AppPlugin::class.java)
        registerPlugin(RemoteCredentialPlugin::class.java)
        registerPlugin(RemoteClipboardPlugin::class.java)
        super.onCreate(savedInstanceState)

        // Edge-to-edge：WebView 内容延伸到系统栏下方，留白由 Web 端 safe-area 处理
        WindowCompat.setDecorFitsSystemWindows(window, false)
        applySystemBarAppearance()

        // 确保 WebView 能够响应触控焦点唤起软键盘
        bridge?.webView?.apply {
            isFocusableInTouchMode = true
            isFocusable = true
        }
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applySystemBarAppearance()
    }

    private fun applySystemBarAppearance() {
        val darkIcons = resources.getBoolean(R.bool.window_uses_dark_system_icons)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = darkIcons
            isAppearanceLightNavigationBars = darkIcons
        }
    }
}

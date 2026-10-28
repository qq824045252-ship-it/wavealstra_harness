package com.mybuddy.remote

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
        // Claude 暖浅色 UI：状态栏 / 导航栏图标强制深色（黑/深灰），在米白背景下清晰可辨
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }

        // 确保 WebView 能够响应触控焦点唤起软键盘
        bridge?.webView?.apply {
            isFocusableInTouchMode = true
            isFocusable = true
        }
    }
}

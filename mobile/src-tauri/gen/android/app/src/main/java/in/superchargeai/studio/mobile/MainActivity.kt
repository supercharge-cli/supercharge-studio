package `in`.superchargeai.studio.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private var keepingAlive = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Edge-to-edge ignores adjustResize, so shrink the content above the keyboard ourselves.
    // The web page then only sees a shorter viewport and nothing gets panned off screen.
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      val nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
      v.setPadding(0, 0, 0, if (insets.isVisible(WindowInsetsCompat.Type.ime())) maxOf(0, ime - nav) else 0)
      insets
    }
    window.decorView.post { setup(window.decorView) }
  }

  // Called before the first page load, so the bridge is there from the start.
  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(Bridge(), "SuperchargeAndroid")
  }

  override fun onResume() {
    super.onResume()
    window.decorView.post { setup(window.decorView) }
    // Tell the page right away so it checks the link and reconnects without waiting.
    webView?.evaluateJavascript("window.dispatchEvent(new Event('supercharge:resume'))", null)
  }

  override fun onDestroy() {
    setKeepAlive(false)
    super.onDestroy()
  }

  private fun setup(view: View) {
    if (view is WebView) {
      view.settings.setSupportZoom(false)
      view.settings.builtInZoomControls = false
      view.settings.displayZoomControls = false
    }
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) setup(view.getChildAt(i))
    }
  }

  private fun setKeepAlive(on: Boolean) {
    if (on == keepingAlive) return
    keepingAlive = on
    val i = Intent(this, KeepAliveService::class.java)
    if (!on) { stopService(i); return }
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 42)
    }
    try { ContextCompat.startForegroundService(this, i) } catch (e: Exception) { keepingAlive = false }
  }

  inner class Bridge {
    @JavascriptInterface
    fun keepAlive(on: Boolean) { runOnUiThread { setKeepAlive(on) } }
  }
}

package `in`.superchargeai.studio.mobile

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    window.decorView.post { disableZoom(window.decorView) }
  }

  override fun onResume() {
    super.onResume()
    window.decorView.post { disableZoom(window.decorView) }
  }

  private fun disableZoom(view: View) {
    if (view is WebView) {
      view.settings.setSupportZoom(false)
      view.settings.builtInZoomControls = false
      view.settings.displayZoomControls = false
    }
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) disableZoom(view.getChildAt(i))
    }
  }
}

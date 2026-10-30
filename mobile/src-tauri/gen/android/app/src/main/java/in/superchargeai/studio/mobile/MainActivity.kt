package `in`.superchargeai.studio.mobile

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import org.json.JSONObject
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var webView: WebView? = null
  private var keepingAlive = false
  private var pendingChat: String? = null
  /** Back while a chat is working: leave the page running in the background instead of closing it. */
  private val backToHome = object : OnBackPressedCallback(false) {
    override fun handleOnBackPressed() { moveTaskToBack(true) }
  }

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
    onBackPressedDispatcher.addCallback(this, backToHome)
    pendingChat = intent?.getStringExtra(EXTRA_CHAT)
    takeAnswer(intent)
    live = this
  }

  /** An Allow / Deny tapped on a notification while the app was closed: answer once the page is up. */
  private fun takeAnswer(i: Intent?) {
    val key = i?.getStringExtra(QuickActions.EXTRA_KEY) ?: return
    pendingAnswer = "{key:" + JSONObject.quote(key) + ",allow:" + i.getBooleanExtra(QuickActions.EXTRA_ALLOW, false) + "}"
    i.removeExtra(QuickActions.EXTRA_KEY)
  }

  private val replying = HashSet<String>()

  /** Hand stored notification replies to the page (each once at a time). */
  private fun sendReplies() { for (r in QuickActions.replies(this)) if (replying.add(r)) sendReply(r, 20) }

  /**
   * Retries until the page's reply listener is mounted (cold start), up to ~10s. The stored reply
   * is dropped only once the page took it; otherwise it waits for the next resume.
   */
  private fun sendReply(json: String, tries: Int) {
    val js = "window.__scReply?(window.dispatchEvent(new CustomEvent('supercharge:reply',{detail:$json})),1):0"
    val w = webView ?: run { replying.remove(json); return }
    w.evaluateJavascript(js) { r ->
      when {
        r == "1" -> { QuickActions.removeReply(applicationContext, json); replying.remove(json) }
        tries > 0 -> w.postDelayed({ sendReply(json, tries - 1) }, 500)
        else -> replying.remove(json)
      }
    }
  }

  private fun sendAnswer(json: String) {
    webView?.evaluateJavascript("window.dispatchEvent(new CustomEvent('supercharge:answer',{detail:$json}))", null)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    intent.getStringExtra(EXTRA_CHAT)?.let { pendingChat = it }
    takeAnswer(intent)
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
    pendingChat?.let { id ->
      pendingChat = null
      val js = "window.dispatchEvent(new CustomEvent('supercharge:open-chat',{detail:" + JSONObject.quote(id) + "}))"
      // Give a cold-started page a moment to mount its listener.
      webView?.postDelayed({ webView?.evaluateJavascript(js, null) }, 400)
    }
    // Replies typed into notifications while the app was closed.
    sendReplies()
    pendingAnswer?.let { a ->
      pendingAnswer = null
      // The page re-asks pending approvals after it reconnects; it keeps this answer until then.
      webView?.postDelayed({ sendAnswer(a) }, 400)
    }
  }

  override fun onDestroy() {
    if (live === this) live = null
    if (keepingAlive && !isChangingConfigurations) KeepAliveService.handoff(applicationContext)
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
    backToHome.isEnabled = on
    val i = Intent(this, KeepAliveService::class.java)
    if (!on) { stopService(i); KeepAliveService.reset(); return }
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 42)
    }
    try { ContextCompat.startForegroundService(this, i) } catch (e: Exception) { keepingAlive = false; backToHome.isEnabled = false }
  }

  /** Agent alert ("Agent updates" channel); tapping it opens that chat. `key` adds Allow / Deny buttons. */
  private fun showAlert(chat: String, title: String, body: String, sound: Boolean, key: String? = null) {
    if (Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 42)
      return
    }
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val channel = if (sound) ALERTS else ALERTS_QUIET
    if (Build.VERSION.SDK_INT >= 26) {
      nm.createNotificationChannel(NotificationChannel(channel, if (sound) "Agent updates" else "Agent updates (silent)",
        if (sound) NotificationManager.IMPORTANCE_HIGH else NotificationManager.IMPORTANCE_LOW).apply {
        description = "Replies finished, errors and approval requests"
        if (!sound) setSound(null, null)
      })
    }
    val open = PendingIntent.getActivity(this, chat.hashCode(),
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP).putExtra(EXTRA_CHAT, chat),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    @Suppress("DEPRECATION")
    val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, channel) else Notification.Builder(this).setPriority(if (sound) Notification.PRIORITY_HIGH else Notification.PRIORITY_LOW)
    val n = b.setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(Notification.BigTextStyle().bigText(body))
      .setAutoCancel(true)
      .setContentIntent(open)
    if (key != null) {
      val id = chat.hashCode()
      n.addAction(Notification.Action.Builder(android.graphics.drawable.Icon.createWithResource(this, R.mipmap.ic_launcher), "Allow", QuickActions.answerIntent(this, key, true, id)).build())
      n.addAction(Notification.Action.Builder(android.graphics.drawable.Icon.createWithResource(this, R.mipmap.ic_launcher), "Deny", QuickActions.answerIntent(this, key, false, id)).build())    } else {
      // Finished / failed: reply right from the notification.
      n.addAction(QuickActions.replyAction(this, chat, chat.hashCode()))
    }
    val built = n.build()
    try { nm.notify(chat.hashCode(), built) } catch (e: Exception) { /* blocked */ }
  }

  private fun emitUpdate(json: String) {
    runOnUiThread { webView?.evaluateJavascript("window.dispatchEvent(new CustomEvent('supercharge:update',{detail:$json}))", null) }
  }

  inner class Bridge {
    @JavascriptInterface
    fun keepAlive(on: Boolean) { runOnUiThread { setKeepAlive(on) } }

    /** Live line on the keep-alive notification; a non-empty `key` adds Allow / Deny for that approval. */
    @JavascriptInterface
    fun status(chat: String, title: String, text: String, key: String) { runOnUiThread { KeepAliveService.update(applicationContext, chat, title, text, key) } }

    @JavascriptInterface
    fun notify(chat: String, title: String, body: String, sound: Boolean) { runOnUiThread { showAlert(chat, title, body, sound) } }

    /** Approval alert with Allow / Deny buttons; `key` comes back in the supercharge:answer event. */
    @JavascriptInterface
    fun notifyPermission(chat: String, key: String, title: String, body: String, sound: Boolean) { runOnUiThread { showAlert(chat, title, body, sound, key) } }

    /** Home-screen widget state (JSON: working, waiting, linked, title). */
    @JavascriptInterface
    fun widget(json: String) { QuickActions.saveWidget(applicationContext, json) }

    /** Background APK download for the in-app update (see AppUpdate). */
    @JavascriptInterface
    fun downloadUpdate(url: String, manifest: String, name: String) { AppUpdate.download(applicationContext, url, manifest, name) { emitUpdate(it) } }

    @JavascriptInterface
    fun installUpdate() { runOnUiThread { AppUpdate.install(this@MainActivity) { emitUpdate(it) } } }
  }

  private var pendingAnswer: String? = null

  companion object {
    private var live: MainActivity? = null

    /** Hand a notification answer to the running page; false when the app isn't open. */
    fun answer(key: String, allow: Boolean): Boolean {
      val a = live ?: return false
      val w = a.webView ?: return false
      w.post { a.sendAnswer("{key:" + JSONObject.quote(key) + ",allow:" + allow + "}") }
      return true
    }
    /** A notification reply was stored: hand it to the running page now; false when the app isn't open. */
    fun deliverReplies(): Boolean {
      val a = live ?: return false
      val w = a.webView ?: return false
      w.post { a.sendReplies() }
      return true
    }
    const val EXTRA_CHAT = "supercharge_open_chat"
    private const val ALERTS = "supercharge-agent-updates"
    const val ALERTS_QUIET = "supercharge-agent-updates-quiet"
  }
}

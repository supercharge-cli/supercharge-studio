package `in`.superchargeai.studio.mobile

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import android.widget.RemoteViews
import org.json.JSONArray
import org.json.JSONObject

/**
 * Phone quick actions: Allow / Deny and Reply on notifications, the home-screen widget and the
 * quick-settings tile.
 * An answer goes to the page over the open link when the app is alive; otherwise the app opens and
 * answers once it has reconnected (the computer asks again on reconnect).
 */
object QuickActions {
  const val ACTION_ANSWER = "in.superchargeai.studio.mobile.ANSWER"
  const val EXTRA_KEY = "supercharge_answer_key"
  const val EXTRA_ALLOW = "supercharge_answer_allow"
  const val EXTRA_NOTE = "supercharge_answer_note"
  const val ACTION_REPLY = "in.superchargeai.studio.mobile.REPLY"
  const val EXTRA_REPLY = "supercharge_reply_text"
  const val EXTRA_REPLY_CHAT = "supercharge_reply_chat"
  private const val PREFS = "supercharge-widget"

  /** Reply action for a finished / failed chat; RemoteInput needs a mutable PendingIntent. */
  fun replyAction(ctx: Context, chat: String, note: Int): Notification.Action {
    val pi = PendingIntent.getBroadcast(ctx, ("reply" + chat).hashCode(),
      Intent(ctx, ReplyReceiver::class.java).setAction(ACTION_REPLY).putExtra(EXTRA_REPLY_CHAT, chat).putExtra(EXTRA_NOTE, note),
      PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val input = RemoteInput.Builder(EXTRA_REPLY).setLabel("Reply to Supercharge").build()
    return Notification.Action.Builder(android.graphics.drawable.Icon.createWithResource(ctx, R.drawable.ic_tile), "Reply", pi)
      .addRemoteInput(input).setAllowGeneratedReplies(false).build()
  }

  /** Replies typed while the app was closed; the page sends them once it is up (oldest first). */
  fun saveReply(ctx: Context, chat: String, text: String) {
    val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val a = try { JSONArray(p.getString("replies", "[]")) } catch (e: Exception) { JSONArray() }
    a.put(JSONObject().put("chat", chat).put("text", text))
    p.edit().putString("replies", a.toString()).apply()
  }

  fun replies(ctx: Context): List<String> {
    val a = try { JSONArray(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("replies", "[]")) } catch (e: Exception) { JSONArray() }
    return (0 until a.length()).map { a.getJSONObject(it).toString() }
  }

  /** Drop a stored reply once the page has taken it. */
  fun removeReply(ctx: Context, json: String) {
    val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val left = JSONArray()
    var dropped = false
    for (r in replies(ctx)) if (!dropped && r == json) dropped = true else left.put(JSONObject(r))
    p.edit().putString("replies", left.toString()).apply()
  }

  /** One status line for the widget and the tile. */
  fun statusLine(s: JSONObject): String {
    val working = s.optInt("working")
    val waiting = s.optInt("waiting")
    return when {
      waiting > 0 -> "$waiting approval${if (waiting == 1) "" else "s"} waiting"
      working > 0 -> "$working chat${if (working == 1) "" else "s"} working"
      s.optBoolean("linked") -> "All quiet"
      else -> "Not linked"
    }
  }

  fun answerIntent(ctx: Context, key: String, allow: Boolean, note: Int): PendingIntent =
    PendingIntent.getBroadcast(ctx, (key + allow).hashCode(),
      Intent(ctx, AnswerReceiver::class.java).setAction(ACTION_ANSWER).putExtra(EXTRA_KEY, key).putExtra(EXTRA_ALLOW, allow).putExtra(EXTRA_NOTE, note),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

  /** Widget state from the page: {"working":n,"waiting":n,"title":"…"}. */
  fun saveWidget(ctx: Context, json: String) {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("state", json).apply()
    val m = AppWidgetManager.getInstance(ctx)
    val ids = m.getAppWidgetIds(ComponentName(ctx, StudioWidget::class.java))
    if (ids.isNotEmpty()) StudioWidget.render(ctx, m, ids)
    try { TileService.requestListeningState(ctx, ComponentName(ctx, StudioTile::class.java)) } catch (e: Exception) { /* tile not added */ }
  }

  fun widgetState(ctx: Context): JSONObject =
    try { JSONObject(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("state", "{}") ?: "{}") } catch (e: Exception) { JSONObject() }
}

class AnswerReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) {
    val key = intent.getStringExtra(QuickActions.EXTRA_KEY) ?: return
    val allow = intent.getBooleanExtra(QuickActions.EXTRA_ALLOW, false)
    (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(intent.getIntExtra(QuickActions.EXTRA_NOTE, 0))
    if (MainActivity.answer(key, allow)) return
    // App closed: open it with the answer (newer Android versions may block this; the alert is then just dismissed).
    try {
      ctx.startActivity(Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        .putExtra(QuickActions.EXTRA_KEY, key).putExtra(QuickActions.EXTRA_ALLOW, allow))
    } catch (e: Exception) { /* background start not allowed */ }
  }
}

/** Reply typed into a notification: hand it to the running page, or keep it until the app opens. */
class ReplyReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) {
    val chat = intent.getStringExtra(QuickActions.EXTRA_REPLY_CHAT) ?: return
    val note = intent.getIntExtra(QuickActions.EXTRA_NOTE, 0)
    val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(QuickActions.EXTRA_REPLY)?.toString()?.trim().orEmpty()
    val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (text.isEmpty()) { nm.cancel(note); return }
    // Stored first, dropped once the page takes it, so nothing is lost if the page isn't ready.
    QuickActions.saveReply(ctx, chat, text)
    val sent = MainActivity.deliverReplies()
    // Replace the alert (this also stops the reply spinner): sent, or waiting for the app to open.
    val open = PendingIntent.getActivity(ctx, chat.hashCode(),
      Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra(MainActivity.EXTRA_CHAT, chat),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, MainActivity.ALERTS_QUIET) else @Suppress("DEPRECATION") Notification.Builder(ctx)
    b.setSmallIcon(R.drawable.ic_tile)
      .setContentTitle(if (sent) "Reply sent" else "Tap to send your reply")
      .setContentText(text)
      .setAutoCancel(true)
      .setContentIntent(open)
    if (sent) b.setTimeoutAfter(4000)
    try { nm.notify(note, b.build()) } catch (e: Exception) { /* blocked */ }
  }
}

/** Quick-settings tile: agent status, lit while chats work or wait; tap opens the app. */
class StudioTile : TileService() {
  override fun onStartListening() {
    val t = qsTile ?: return
    val s = QuickActions.widgetState(this)
    t.label = "Supercharge"
    t.state = if (s.optInt("working") > 0 || s.optInt("waiting") > 0) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
    if (Build.VERSION.SDK_INT >= 29) t.subtitle = QuickActions.statusLine(s)
    t.updateTile()
  }

  override fun onClick() {
    val i = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(PendingIntent.getActivity(this, 8, i, PendingIntent.FLAG_IMMUTABLE))
    else @Suppress("DEPRECATION") startActivityAndCollapse(i)
  }
}

/** Home-screen widget: what the agent is doing, and a tap to open the app (or the waiting approval). */
class StudioWidget : AppWidgetProvider() {
  override fun onUpdate(ctx: Context, m: AppWidgetManager, ids: IntArray) = render(ctx, m, ids)

  companion object {
    fun render(ctx: Context, m: AppWidgetManager, ids: IntArray) {
      val s = QuickActions.widgetState(ctx)
      val line = QuickActions.statusLine(s)
      val open = PendingIntent.getActivity(ctx, 7, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      for (id in ids) {
        val v = RemoteViews(ctx.packageName, R.layout.widget_studio)
        v.setTextViewText(R.id.widget_status, line)
        v.setTextViewText(R.id.widget_detail, s.optString("title", ""))
        v.setOnClickPendingIntent(R.id.widget_root, open)
        m.updateAppWidget(id, v)
      }
    }
  }
}

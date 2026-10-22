package `in`.superchargeai.studio.mobile

import android.app.NotificationManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import org.json.JSONObject

/**
 * Phone quick actions: Allow / Deny buttons on approval notifications, and the home-screen widget.
 * An answer goes to the page over the open link when the app is alive; otherwise the app opens and
 * answers once it has reconnected (the computer asks again on reconnect).
 */
object QuickActions {
  const val ACTION_ANSWER = "in.superchargeai.studio.mobile.ANSWER"
  const val EXTRA_KEY = "supercharge_answer_key"
  const val EXTRA_ALLOW = "supercharge_answer_allow"
  const val EXTRA_NOTE = "supercharge_answer_note"
  private const val PREFS = "supercharge-widget"

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

/** Home-screen widget: what the agent is doing, and a tap to open the app (or the waiting approval). */
class StudioWidget : AppWidgetProvider() {
  override fun onUpdate(ctx: Context, m: AppWidgetManager, ids: IntArray) = render(ctx, m, ids)

  companion object {
    fun render(ctx: Context, m: AppWidgetManager, ids: IntArray) {
      val s = QuickActions.widgetState(ctx)
      val working = s.optInt("working"), waiting = s.optInt("waiting")
      val line = when {
        waiting > 0 -> "$waiting approval${if (waiting == 1) "" else "s"} waiting"
        working > 0 -> "$working chat${if (working == 1) "" else "s"} working"
        s.optBoolean("linked") -> "All quiet"
        else -> "Not linked"
      }
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

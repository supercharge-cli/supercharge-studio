package `in`.superchargeai.studio.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder

/**
 * Foreground service (type dataSync) that keeps the app's link to the computer open while a turn runs
 * with the app in the background. Its ongoing notification shows what the agent is doing right now
 * ("Thinking…", "Running: …", "Editing …"), with Allow / Deny while it waits for an approval.
 * The page stops it as soon as no chat is working.
 */
class KeepAliveService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    try {
      val n = build(this)
      if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else startForeground(ID, n)
      running = true
    } catch (e: Exception) {
      stopSelf() // not allowed right now (e.g. started from the background); the app just reconnects on resume
    }
    return START_NOT_STICKY
  }

  /** Swiped away from recents: the page (and its link) goes with it, but the turn goes on on the computer. */
  override fun onTaskRemoved(rootIntent: Intent?) {
    handoff(this)
    stopSelf()
  }

  override fun onTimeout(startId: Int) { stopSelf() } // Android 15+ daily limit for this service type

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  companion object {
    private const val CHANNEL = "supercharge-live"
    private const val ID = 4201
    private const val HANDOFF = 4202
    @Volatile private var running = false
    private var chat = ""
    private var title = "Supercharge"
    private var text = "Working…"
    private var key = ""

    /** New live status from the page; shown right away while the service runs, else used when it starts. Repeats are skipped. */
    fun update(ctx: Context, chat: String, title: String, text: String, key: String) {
      if (chat == this.chat && title == this.title && text == this.text && key == this.key) return
      this.chat = chat; this.title = title; this.text = text; this.key = key
      if (!running) return
      try { manager(ctx).notify(ID, build(ctx)) } catch (e: Exception) { /* notifications blocked */ }
    }

    /** Back to the plain line once no chat is working. */
    fun reset() { chat = ""; title = "Supercharge"; text = "Working…"; key = "" }

    /** The app closed mid-turn: say plainly that the computer keeps going and how to follow it. */
    fun handoff(ctx: Context) {
      if (!running || chat.isEmpty()) return
      @Suppress("DEPRECATION")
      val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, channel(ctx)) else Notification.Builder(ctx)
      val n = b.setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle("Still working on your computer")
        .setContentText("$title keeps running there. Open Supercharge to follow it.")
        .setStyle(Notification.BigTextStyle().bigText("$title keeps running on your computer. Open Supercharge to follow it."))
        .setAutoCancel(true)
        .setContentIntent(openChat(ctx, chat))
        .build()
      try { manager(ctx).notify(HANDOFF, n) } catch (e: Exception) { /* notifications blocked */ }
    }

    private fun manager(ctx: Context) = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun channel(ctx: Context): String {
      if (Build.VERSION.SDK_INT >= 26) {
        manager(ctx).deleteNotificationChannel("supercharge-connection") // the old silent channel, replaced by this one
        manager(ctx).createNotificationChannel(NotificationChannel(CHANNEL, "Live status", NotificationManager.IMPORTANCE_LOW).apply {
          description = "What the agent is doing while Supercharge runs in the background"
          setShowBadge(false)
          setSound(null, null)
        })
      }
      return CHANNEL
    }

    private fun openChat(ctx: Context, chat: String): PendingIntent =
      PendingIntent.getActivity(ctx, 0, Intent(ctx, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        .also { if (chat.isNotEmpty()) it.putExtra(MainActivity.EXTRA_CHAT, chat) },
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    private fun build(ctx: Context): Notification {
      @Suppress("DEPRECATION")
      val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(ctx, channel(ctx)) else Notification.Builder(ctx).setPriority(Notification.PRIORITY_LOW)
      b.setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle(title)
        .setContentText(text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setShowWhen(false)
        .setContentIntent(openChat(ctx, chat))
      if (key.isNotEmpty()) {
        // Same answer path as the approval alert; tapping one also dismisses that alert.
        val note = chat.hashCode()
        val icon = Icon.createWithResource(ctx, R.mipmap.ic_launcher)
        b.addAction(Notification.Action.Builder(icon, "Allow", QuickActions.answerIntent(ctx, key, true, note)).build())
        b.addAction(Notification.Action.Builder(icon, "Deny", QuickActions.answerIntent(ctx, key, false, note)).build())
      }
      return b.build()
    }
  }
}

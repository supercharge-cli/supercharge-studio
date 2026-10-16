package `in`.superchargeai.studio.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/** Quiet foreground service that keeps the app's connection alive while a reply is streaming. */
class KeepAliveService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26) {
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "Connection", NotificationManager.IMPORTANCE_MIN).apply {
        description = "Shown while Supercharge keeps a chat connected in the background"
        setShowBadge(false)
      })
    }
    val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    @Suppress("DEPRECATION")
    val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this).setPriority(Notification.PRIORITY_MIN)
    val n = b.setSmallIcon(R.mipmap.ic_launcher)
      .setContentTitle("Supercharge connected")
      .setContentText("Keeping your chat connected")
      .setOngoing(true)
      .setContentIntent(open)
      .build()
    try {
      if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else startForeground(ID, n)
    } catch (e: Exception) {
      stopSelf() // not allowed right now (e.g. started from the background); the app just reconnects on resume
    }
    return START_NOT_STICKY
  }

  override fun onTimeout(startId: Int) { stopSelf() } // Android 15+ daily limit for this service type

  companion object {
    private const val CHANNEL = "supercharge-connection"
    private const val ID = 4201
  }
}

package `in`.superchargeai.studio.mobile

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * In-app update: downloads the release APK in the background, checks it against the
 * release's SHA256SUMS and hands it to the system installer (the user confirms; the
 * update is signed with the same key, so it replaces the app in place).
 * Progress goes to the page as `supercharge:update` events: {p}, {ready}, {err}.
 */
object AppUpdate {
  private const val PREFIX = "https://github.com/supercharge-cli/supercharge-studio/releases/download/"
  @Volatile private var running = false

  private fun file(ctx: Context) = File(File(ctx.cacheDir, "updates").apply { mkdirs() }, "update.apk")

  /** Hex SHA256 for `name` in a `sha256sum` listing. */
  fun expectedSha(sums: String, name: String): String? = sums.lineSequence().mapNotNull { l ->
    val p = l.trim().split(Regex("\\s+"))
    if (p.size >= 2 && p[1].trimStart('*') == name && p[0].length == 64) p[0].lowercase() else null
  }.firstOrNull()

  private fun open(u: String) = (URL(u).openConnection() as HttpURLConnection).apply {
    instanceFollowRedirects = true
    connectTimeout = 20000
    readTimeout = 60000
    setRequestProperty("User-Agent", "supercharge-studio")
  }

  fun download(ctx: Context, url: String, sums: String, name: String, emit: (String) -> Unit) {
    if (running) return
    running = true
    Thread {
      try {
        require(url.startsWith(PREFIX) && sums.startsWith(PREFIX) && !url.contains("..")) { "not a release download" }
        val want = expectedSha(open(sums).inputStream.use { it.readBytes().toString(Charsets.UTF_8) }, name)
          ?: error("$name is not listed in SHA256SUMS")
        val out = file(ctx)
        val tmp = File(out.path + ".part")
        val c = open(url)
        val total = c.contentLengthLong
        val md = MessageDigest.getInstance("SHA-256")
        var done = 0L
        var last = 0L
        c.inputStream.use { inp ->
          tmp.outputStream().use { o ->
            val buf = ByteArray(65536)
            while (true) {
              val n = inp.read(buf)
              if (n < 0) break
              o.write(buf, 0, n)
              md.update(buf, 0, n)
              done += n
              if (done - last >= 262144 && total > 0) {
                last = done
                emit("{\"p\":${done.toDouble() / total}}")
              }
            }
          }
        }
        val got = md.digest().joinToString("") { "%02x".format(it) }
        if (got != want) {
          tmp.delete()
          error("checksum mismatch, the download was discarded")
        }
        out.delete()
        check(tmp.renameTo(out)) { "could not save the update" }
        emit("{\"ready\":true,\"hide\":0}")
      } catch (e: Exception) {
        emit("{\"p\":null,\"err\":" + JSONObject.quote("Download failed: " + (e.message ?: e.toString())) + ",\"hide\":0}")
      } finally {
        running = false
      }
    }.start()
  }

  /** Opens the system installer, or the "install unknown apps" setting first if it is off. */
  fun install(a: Activity, emit: (String) -> Unit) {
    val f = file(a)
    if (!f.exists()) return emit("{\"ready\":false,\"err\":\"The update file is gone. Reopen the app to download it again.\"}")
    if (!a.packageManager.canRequestPackageInstalls()) {
      emit("{\"err\":\"Allow installs from Supercharge Studio, then tap Restart again.\"}")
      a.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.packageName)))
      return
    }
    val uri = FileProvider.getUriForFile(a, a.packageName + ".fileprovider", f)
    a.startActivity(
      Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    )
  }
}

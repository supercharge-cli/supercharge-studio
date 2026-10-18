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
 * In-app update: downloads the release APK over HTTPS in the background, checks it against
 * the sha256 the same release's latest.json lists for it (no entry: refused) and hands it
 * to the system installer (the user confirms; the
 * update is signed with the same key, so it replaces the app in place).
 * Progress goes to the page as `supercharge:update` events: {p}, {ready}, {err}.
 */
object AppUpdate {
  private const val PREFIX = "https://github.com/supercharge-cli/supercharge-studio/releases/download/"
  @Volatile private var running = false

  private fun file(ctx: Context) = File(File(ctx.cacheDir, "updates").apply { mkdirs() }, "update.apk")

  /** Lowercase hex sha256 that latest.json lists for `name`, only if its URL is `url`. */
  fun expectedSha(manifest: String, name: String, url: String): String? = try {
    val p = JSONObject(manifest).getJSONObject("packages").getJSONObject(name)
    val h = p.getString("sha256")
    if (p.getString("url") == url && h.length == 64 && h.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) h.lowercase() else null
  } catch (e: Exception) { null }

  /** HTTPS only, including where redirects lead. */
  private fun open(u: String) = (URL(u).openConnection() as HttpURLConnection).apply {
    instanceFollowRedirects = true
    connectTimeout = 20000
    readTimeout = 60000
    setRequestProperty("User-Agent", "supercharge-studio")
    check(u.startsWith("https://")) { "not an HTTPS download" }
    connect()
    check(url.protocol == "https" && responseCode in 200..299) { "download failed ($responseCode)" }
  }

  /** `manifest` is the URL of the same release's latest.json. */
  fun download(ctx: Context, url: String, manifest: String, name: String, emit: (String) -> Unit) {
    if (running) return
    running = true
    Thread {
      try {
        val tag = url.removePrefix(PREFIX).substringBefore('/')
        require(url.startsWith(PREFIX) && !url.contains("..") && tag.isNotEmpty() && url == "$PREFIX$tag/$name" && manifest == "$PREFIX$tag/latest.json") { "not a release download" }
        val want = expectedSha(open(manifest).inputStream.use { it.readBytes().toString(Charsets.UTF_8) }, name, url)
          ?: error("$name is not listed in latest.json, refusing to install")
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

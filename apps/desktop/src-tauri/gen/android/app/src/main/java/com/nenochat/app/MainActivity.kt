package com.nenochat.app

import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Base64
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  companion object {
    private const val LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
    private const val REQUEST_LOCAL_NETWORK = 7101
    private const val RECORD_AUDIO_PERMISSION = "android.permission.RECORD_AUDIO"
    private const val REQUEST_RECORD_AUDIO = 7102
    private const val PREFS = "nenochat.native"
    private const val KEY_ASKED = "localNetworkRequested"

    /** 本地网络权限自 Android 17（API 37）引入，低版本由 INTERNET 隐式放行 */
    private const val MIN_LOCAL_NETWORK_API = 37
  }

  /** 原生录音器状态；只允许同一时刻一段录音 */
  private var voiceRecorder: MediaRecorder? = null
  private var voiceFile: File? = null
  private var voiceStartedAt: Long = 0

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // 边到边绘制时，把状态栏、导航栏、刘海与输入法占用的区域让给 WebView，
    // 否则页面顶部会被状态栏盖住、键盘弹出时输入框也看不见。
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      insets
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    // 关掉原生缩放、边缘光晕与滚动回弹，让 WebView 行为更接近原生控件
    webView.settings.apply {
      setSupportZoom(false)
      builtInZoomControls = false
      displayZoomControls = false
    }
    webView.overScrollMode = View.OVER_SCROLL_NEVER
    webView.isLongClickable = false
    webView.setBackgroundColor(Color.TRANSPARENT)

    // 局域网权限没有浏览器层的请求入口，由页面通过这座桥向原生侧索要
    this.webView = webView
    webView.addJavascriptInterface(LocalNetworkBridge(), "NenoLocalNetwork")
    // WebView 里 getUserMedia 需要 WebChromeClient 接管权限弹窗，与 Tauri 自身的
    // chrome client 冲突，所以语音消息的录音走原生 MediaRecorder 桥
    webView.addJavascriptInterface(VoiceBridge(), "NenoVoiceBridge")
  }

  private fun supportsLocalNetwork() = Build.VERSION.SDK_INT >= MIN_LOCAL_NETWORK_API

  private fun localNetworkGranted(): Boolean =
    ContextCompat.checkSelfPermission(this, LOCAL_NETWORK_PERMISSION) ==
      PackageManager.PERMISSION_GRANTED

  /**
   * 授权状态：
   * granted 已授权；prompt 还能弹系统框；denied 已被拒绝，只能去设置页开；
   * unsupported 系统低于 Android 17，本地网络不受限。
   */
  private fun localNetworkStatus(): String {
    if (!supportsLocalNetwork()) return "unsupported"
    if (localNetworkGranted()) return "granted"
    val asked = getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_ASKED, false)
    val canAskAgain =
      ActivityCompat.shouldShowRequestPermissionRationale(this, LOCAL_NETWORK_PERMISSION)
    return if (asked && !canAskAgain) "denied" else "prompt"
  }

  private fun requestLocalNetwork() {
    if (!supportsLocalNetwork()) {
      deliverLocalNetworkState("unsupported")
      return
    }
    if (localNetworkGranted()) {
      deliverLocalNetworkState("granted")
      return
    }
    // 记下问过一次，用于区分「从未询问」和「拒绝且不再弹框」
    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_ASKED, true).apply()
    ActivityCompat.requestPermissions(
      this,
      arrayOf(LOCAL_NETWORK_PERMISSION),
      REQUEST_LOCAL_NETWORK
    )
  }

  override fun onRequestPermissionsResult(
    requestCode: Int,
    permissions: Array<out String>,
    grantResults: IntArray
  ) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != REQUEST_LOCAL_NETWORK) return
    // 系统弹窗的结果只能异步拿到，回传给页面里等待中的 Promise
    deliverLocalNetworkState(localNetworkStatus())
  }

  private fun deliverLocalNetworkState(state: String) {
    val target = webView ?: return
    val script = "window.__nenoLocalNetworkResult&&window.__nenoLocalNetworkResult('$state')"
    target.post { target.evaluateJavascript(script, null) }
  }

  private fun openAppSettings() {
    val intent = Intent(
      Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
      Uri.fromParts("package", packageName, null)
    )
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    startActivity(intent)
  }

  /** 供设置页展示的环境信息，排查局域网连不通时区分系统层与安装包问题 */
  private fun diagnosticsJson(): String {
    val webviewPackage = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      WebView.getCurrentWebViewPackage()
    } else {
      null
    }
    return JSONObject().apply {
      put("sdk", Build.VERSION.SDK_INT)
      put("release", Build.VERSION.RELEASE)
      put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
      put("appVersion", BuildConfig.VERSION_NAME)
      put("permissionDeclared", PermissionHelper.hasDefinedPermission(this@MainActivity, LOCAL_NETWORK_PERMISSION))
      put("permissionGranted", localNetworkGranted())
      put("status", localNetworkStatus())
      put("asked", getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_ASKED, false))
      put(
        "canAskAgain",
        supportsLocalNetwork() &&
          ActivityCompat.shouldShowRequestPermissionRationale(this@MainActivity, LOCAL_NETWORK_PERMISSION)
      )
      put("webviewPackage", webviewPackage?.packageName ?: "")
      put("webviewVersion", webviewPackage?.versionName ?: "")
    }.toString()
  }

  /** 暴露给页面的本地网络权限桥，方法在 JavaBridge 线程被调用 */
  private inner class LocalNetworkBridge {
    @JavascriptInterface
    fun status(): String = this@MainActivity.localNetworkStatus()

    @JavascriptInterface
    fun request() {
      runOnUiThread { requestLocalNetwork() }
    }

    @JavascriptInterface
    fun openSettings() {
      runOnUiThread { openAppSettings() }
    }

    @JavascriptInterface
    fun diagnostics(): String = diagnosticsJson()
  }

  /* ------------------------------ 语音消息录音 ------------------------------ */

  private fun micPermissionGranted(): Boolean =
    ContextCompat.checkSelfPermission(this, RECORD_AUDIO_PERMISSION) ==
      PackageManager.PERMISSION_GRANTED

  private fun requestMicPermission() {
    ActivityCompat.requestPermissions(this, arrayOf(RECORD_AUDIO_PERMISSION), REQUEST_RECORD_AUDIO)
  }

  private fun startVoiceRecording(): JSONObject {
    if (!micPermissionGranted()) {
      runOnUiThread { requestMicPermission() }
      return JSONObject().put("ok", false).put("error", "需要麦克风权限，请再次点击开始录音")
    }
    if (voiceRecorder != null) {
      return JSONObject().put("ok", false).put("error", "已经在录音中")
    }
    val file = File(cacheDir, "voice-${System.currentTimeMillis()}.m4a")
    try {
      // MediaRecorder 构造器在 API 31 标记过时但仍可用；保持旧写法避免分版本适配
      @Suppress("DEPRECATION")
      val recorder = MediaRecorder()
      recorder.setAudioSource(MediaRecorder.AudioSource.MIC)
      recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
      recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      recorder.setAudioSamplingRate(44100)
      recorder.setAudioChannels(1)
      recorder.setAudioEncodingBitRate(96000)
      recorder.setOutputFile(file.absolutePath)
      recorder.prepare()
      recorder.start()
      voiceRecorder = recorder
      voiceFile = file
      voiceStartedAt = System.currentTimeMillis()
      return JSONObject().put("ok", true)
    } catch (e: Exception) {
      file.delete()
      voiceRecorder = null
      voiceFile = null
      return JSONObject().put("ok", false).put("error", "无法启动录音：${e.message ?: "未知错误"}")
    }
  }

  private fun deliverVoiceResult(payload: JSONObject?) {
    val target = webView ?: return
    // JSONObject.quote 产出的字符串字面量既是合法 JSON 也是合法 JS 表达式
    val script =
      "window.__nenoVoiceResult&&window.__nenoVoiceResult(" +
        JSONObject.quote(payload?.toString() ?: "null") +
        ")"
    target.post { target.evaluateJavascript(script, null) }
  }

  /** 停止录音并把文件读成 base64 回传；结果通过 window.__nenoVoiceResult 送回页面 */
  private fun stopVoiceRecording() {
    val recorder = voiceRecorder
    val file = voiceFile
    if (recorder == null || file == null) {
      deliverVoiceResult(null)
      return
    }
    val durationMs = System.currentTimeMillis() - voiceStartedAt
    try {
      recorder.stop()
    } catch (e: Exception) {
      // 录音太短等场景 stop 会抛异常，按无结果处理
      recorder.release()
      voiceRecorder = null
      file.delete()
      voiceFile = null
      deliverVoiceResult(null)
      return
    }
    recorder.release()
    voiceRecorder = null
    voiceFile = null
    try {
      val bytes = file.readBytes()
      val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
      val payload = JSONObject()
        .put("base64", base64)
        .put("mime", "audio/mp4")
        .put("durationMs", if (durationMs > 0) durationMs.toLong() else 0L)
      file.delete()
      deliverVoiceResult(payload)
    } catch (e: Exception) {
      file.delete()
      deliverVoiceResult(null)
    }
  }

  private fun cancelVoiceRecording() {
    val recorder = voiceRecorder
    voiceRecorder = null
    val file = voiceFile
    voiceFile = null
    if (recorder != null) {
      try {
        recorder.stop()
      } catch (_: Exception) {
        // 取消时录音文件作废，异常无需处理
      }
      recorder.release()
    }
    file?.delete()
  }

  override fun onDestroy() {
    super.onDestroy()
    cancelVoiceRecording()
  }

  /** 暴露给页面的原生录音桥；录出来的音频以 base64 回传给页面转 File 上传 */
  private inner class VoiceBridge {
    @JavascriptInterface
    fun start(): String = startVoiceRecording().toString()

    @JavascriptInterface
    fun stop() {
      runOnUiThread { stopVoiceRecording() }
    }

    @JavascriptInterface
    fun cancel() {
      runOnUiThread { cancelVoiceRecording() }
    }
  }
}

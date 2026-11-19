package com.nenochat.app

import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  companion object {
    private const val LOCAL_NETWORK_PERMISSION = "android.permission.ACCESS_LOCAL_NETWORK"
    private const val REQUEST_LOCAL_NETWORK = 7101
    private const val PREFS = "nenochat.native"
    private const val KEY_ASKED = "localNetworkRequested"

    /** 本地网络权限自 Android 17（API 37）引入，低版本由 INTERNET 隐式放行 */
    private const val MIN_LOCAL_NETWORK_API = 37
  }

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
}

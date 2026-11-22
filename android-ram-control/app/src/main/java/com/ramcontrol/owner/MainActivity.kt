package com.ramcontrol.owner

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.URLDecoder
import java.nio.charset.StandardCharsets

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var pendingWebPermissionRequest: PermissionRequest? = null

    private val webPermissionsLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
            val pending = pendingWebPermissionRequest
            pendingWebPermissionRequest = null
            if (pending != null) {
                try {
                    val allOk = results.isNotEmpty() && results.values.all { it }
                    if (allOk) {
                        pending.grant(pending.resources)
                    } else {
                        pending.deny()
                    }
                } catch (_: Throwable) {
                }
            }
        }

    private val startupPermissionsLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { _ -> }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val headerColor = Color.parseColor("#17212B")
        val bgColor = Color.parseColor("#0E1621")
        window.statusBarColor = headerColor
        window.navigationBarColor = bgColor
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = 0
        }

        webView = WebView(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(bgColor)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.allowFileAccess = true
            settings.allowContentAccess = true
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            settings.setSupportZoom(false)
            settings.javaScriptCanOpenWindowsAutomatically = true
            settings.textZoom = 100
            settings.mediaPlaybackRequiresUserGesture = false
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                if (request == null) return
                val originHost = request.origin?.host ?: ""
                val trusted = originHost == "appassets.androidplatform.net" ||
                    originHost == "localhost" ||
                    originHost == "127.0.0.1" ||
                    originHost.endsWith("vercel.app") ||
                    originHost.endsWith("run.app")
                if (!trusted) {
                    try {
                        request.deny()
                    } catch (_: Throwable) {
                    }
                    return
                }
                val resources = request.resources ?: emptyArray()
                val missing = mutableListOf<String>()
                if (resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) &&
                    ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
                ) {
                    missing.add(Manifest.permission.RECORD_AUDIO)
                }
                if (resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) &&
                    ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED
                ) {
                    missing.add(Manifest.permission.CAMERA)
                }
                if (missing.isEmpty()) {
                    runOnUiThread {
                        try {
                            request.grant(request.resources)
                        } catch (_: Throwable) {
                        }
                    }
                } else {
                    runOnUiThread {
                        pendingWebPermissionRequest = request
                        webPermissionsLauncher.launch(missing.toTypedArray())
                    }
                }
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                val url = request?.url ?: return super.shouldInterceptRequest(view, request)
                val host = url.host ?: ""
                if (host == "appassets.androidplatform.net" || host == "localhost" || host == "127.0.0.1") {
                    val reqPath = url.path ?: "/"
                    if (reqPath.startsWith("/api/")) {
                        val jsonBytes = "{\"ok\":true,\"offline\":true}".toByteArray(StandardCharsets.UTF_8)
                        return WebResourceResponse(
                            "application/json",
                            "UTF-8",
                            200,
                            "OK",
                            mapOf("Cache-Control" to "no-store"),
                            ByteArrayInputStream(jsonBytes)
                        )
                    }
                    val assetResponse = openLocalAssetResponse(reqPath)
                    if (assetResponse != null) return assetResponse
                    return WebResourceResponse(
                        "text/plain",
                        "UTF-8",
                        404,
                        "Not Found",
                        mapOf("Cache-Control" to "no-store"),
                        ByteArrayInputStream(ByteArray(0))
                    )
                }
                return super.shouldInterceptRequest(view, request)
            }

            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?
            ): Boolean {
                val url = request?.url ?: return false
                val host = url.host ?: ""
                if (host == "appassets.androidplatform.net" || host == "localhost" || host == "127.0.0.1") {
                    return false
                }
                return try {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url.toString())))
                    true
                } catch (_: Throwable) {
                    false
                }
            }

            override fun onRenderProcessGone(
                view: WebView?,
                detail: RenderProcessGoneDetail?
            ): Boolean {
                runOnUiThread {
                    try {
                        webView.loadUrl("https://appassets.androidplatform.net/ram-control")
                    } catch (_: Throwable) {
                    }
                }
                return true
            }
        }

        val audioBridge = RamAudioBridge()
        webView.addJavascriptInterface(audioBridge, "RamAudioBridge")
        webView.addJavascriptInterface(audioBridge, "Android")

        setContentView(webView)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    finish()
                }
            }
        })

        webView.loadUrl("https://appassets.androidplatform.net/ram-control")
        requestInitialOwnerPermissions()
    }

    private var focusReq: AudioFocusRequest? = null

    inner class RamAudioBridge {
        @JavascriptInterface
        fun setAudioCallMode(active: Boolean, speakerOn: Boolean) {
            runOnUiThread {
                try {
                    val am = getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return@runOnUiThread
                    if (active) {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            val req = focusReq ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                                .setAudioAttributes(
                                    AudioAttributes.Builder()
                                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                        .build()
                                )
                                .build().also { focusReq = it }
                            am.requestAudioFocus(req)
                        } else {
                            @Suppress("DEPRECATION")
                            am.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                        }
                        am.mode = AudioManager.MODE_IN_COMMUNICATION
                        am.isMicrophoneMute = false
                        @Suppress("DEPRECATION")
                        am.isSpeakerphoneOn = speakerOn
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                            try {
                                val desiredType = if (speakerOn) {
                                    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                                } else {
                                    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
                                }
                                val target = am.availableCommunicationDevices.firstOrNull { it.type == desiredType }
                                if (target != null) {
                                    am.setCommunicationDevice(target)
                                }
                            } catch (_: Throwable) {
                            }
                        }
                        try {
                            val maxVol = am.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL)
                            val curVol = am.getStreamVolume(AudioManager.STREAM_VOICE_CALL)
                            val targetMin = kotlin.math.max(1, (maxVol * 0.8).toInt())
                            if (curVol < targetMin) {
                                am.setStreamVolume(AudioManager.STREAM_VOICE_CALL, targetMin, 0)
                            }
                        } catch (_: Throwable) {
                        }
                    } else {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                            try {
                                am.clearCommunicationDevice()
                            } catch (_: Throwable) {
                            }
                        }
                        @Suppress("DEPRECATION")
                        am.isSpeakerphoneOn = false
                        am.mode = AudioManager.MODE_NORMAL
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                            focusReq?.let { am.abandonAudioFocusRequest(it) }
                            focusReq = null
                        }
                    }
                } catch (_: Throwable) {
                }
            }
        }
    }

    private fun requestInitialOwnerPermissions() {
        val needed = mutableListOf<String>()
        if (ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.RECORD_AUDIO
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            needed.add(Manifest.permission.RECORD_AUDIO)
        }
        if (ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.CAMERA
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            needed.add(Manifest.permission.CAMERA)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(
                    this,
                    Manifest.permission.POST_NOTIFICATIONS
                ) != PackageManager.PERMISSION_GRANTED
            ) {
                needed.add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        if (needed.isNotEmpty()) {
            try {
                startupPermissionsLauncher.launch(needed.toTypedArray())
            } catch (_: Throwable) {
            }
        }
    }

    private fun openLocalAssetResponse(rawPath: String): WebResourceResponse? {
        val decoded = try {
            URLDecoder.decode(rawPath, "UTF-8")
        } catch (_: Throwable) {
            rawPath
        }
        var cleanPath = decoded.trimStart('/')
        if (cleanPath.isEmpty() || cleanPath == "index.html" || cleanPath == "ram-control" || cleanPath == "ram-control/") {
            cleanPath = "ram-control.html"
        }

        val candidates = mutableListOf<String>()
        if (cleanPath.startsWith("_next/")) {
            val subPath = cleanPath.removePrefix("_next/")
            candidates.add("web/next_bundle/$subPath")
        }
        candidates.add("web/$cleanPath")
        candidates.add("web/${cleanPath}.html")
        candidates.add("web/${cleanPath.trimEnd('/')}/index.html")

        val fileName = cleanPath.substringAfterLast('/')
        if (!fileName.contains('.') || cleanPath == "ram-control.html") {
            candidates.add("web/ram-control.html")
            candidates.add("web/ram-control/index.html")
        }
        for (candidate in candidates) {
            try {
                val stream: InputStream = assets.open(candidate)
                val mime = guessMimeType(candidate)
                return WebResourceResponse(
                    mime,
                    "UTF-8",
                    200,
                    "OK",
                    mapOf(
                        "Cache-Control" to "no-store, no-cache, must-revalidate",
                        "Access-Control-Allow-Origin" to "*"
                    ),
                    stream
                )
            } catch (_: Throwable) {
            }
        }
        return null
    }

    private fun guessMimeType(path: String): String {
        val lower = path.lowercase()
        return when {
            lower.endsWith(".html") || lower.endsWith(".htm") -> "text/html"
            lower.endsWith(".js") || lower.endsWith(".mjs") -> "application/javascript"
            lower.endsWith(".css") -> "text/css"
            lower.endsWith(".png") -> "image/png"
            lower.endsWith(".jpg") || lower.endsWith(".jpeg") -> "image/jpeg"
            lower.endsWith(".svg") -> "image/svg+xml"
            lower.endsWith(".json") -> "application/json"
            lower.endsWith(".txt") -> "text/plain"
            lower.endsWith(".woff2") -> "font/woff2"
            else -> "application/octet-stream"
        }
    }
}

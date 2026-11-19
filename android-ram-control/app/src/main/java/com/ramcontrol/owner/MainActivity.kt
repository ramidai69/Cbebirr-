package com.ramcontrol.owner

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.PermissionRequest
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
import java.io.InputStream
import java.net.URLDecoder

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
            setBackgroundColor(bgColor)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.allowFileAccess = true
            settings.allowContentAccess = true
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
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
                    originHost.endsWith("vercel.app")
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
                    val assetResponse = openLocalAssetResponse(url.path ?: "/")
                    if (assetResponse != null) return assetResponse
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
        }

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

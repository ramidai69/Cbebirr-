package com.ramcontrol.owner

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import java.io.InputStream
import java.net.URLDecoder

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView

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
        }

        webView.webChromeClient = WebChromeClient()
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

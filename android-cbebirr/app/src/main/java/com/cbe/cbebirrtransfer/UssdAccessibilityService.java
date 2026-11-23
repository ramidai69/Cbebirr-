package com.cbe.cbebirrtransfer;

import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;

import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class UssdAccessibilityService extends AccessibilityService {
    public static final String ACTION_RECEIVER_FOUND = "com.cbe.cbebirrtransfer.RECEIVER_FOUND";
    public static final String EXTRA_NAME = "receiver_name";
    public static volatile UssdAccessibilityService instance = null;
    public static volatile boolean isRemoteOwnerUssdActive = false;
    public static volatile String activeRemoteRequestId = "";
    public static volatile long remoteStartedAtMs = 0L;

    private long lastCapturedTime = 0L;
    private long lastRemoteSentTime = 0L;
    private long lastTelecomEventAtMs = 0L;
    private String lastRemoteScreenText = "";
    private boolean sawRemoteDialog = false;
    private WindowManager windowManager = null;
    private View overlayView = null;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private final Runnable remoteWatchdogRunnable = new Runnable() {
        @Override
        public void run() {
            if (!isRemoteOwnerUssdActive) {
                return;
            }
            long now = System.currentTimeMillis();
            if (now - remoteStartedAtMs > 120000L) {
                finishRemoteUssdCompleted("Timed out");
                return;
            }
            if (sawRemoteDialog && (now - lastTelecomEventAtMs) >= 2400L) {
                if (!isCurrentRootTelecom()) {
                    finishRemoteUssdCompleted("Completed");
                    return;
                }
            }
            mainHandler.postDelayed(this, 1600L);
        }
    };

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
    }

    @Override
    public void onInterrupt() {
    }

    private static boolean isKeyboardPkg(String pkg) {
        return pkg.contains("keyboard")
            || pkg.contains("ime")
            || pkg.contains("latin")
            || pkg.contains("swiftkey")
            || pkg.contains("gboard");
    }

    private static boolean isTelecomPackage(String pkg) {
        return pkg.contains("phone")
            || pkg.contains("telecom")
            || pkg.contains("dialer")
            || pkg.contains("stk")
            || pkg.contains("incallui")
            || "android".equals(pkg);
    }

    private boolean isCurrentRootTelecom() {
        try {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null || root.getPackageName() == null) {
                return false;
            }
            String rootPkg = root.getPackageName().toString().toLowerCase(Locale.US);
            return isTelecomPackage(rootPkg);
        } catch (Throwable ignored) {
            return false;
        }
    }

    private void emitRemoteUssdEvent(
        String requestId,
        String status,
        String screenText,
        boolean hasInput,
        String detail
    ) {
        if (requestId == null || requestId.isEmpty()) return;
        CallBridgeHelper.reportRemoteUssdStateAsync(
            getApplicationContext(),
            requestId,
            status,
            screenText,
            hasInput,
            detail,
            -1
        );
        if (MainActivity.currentInstance != null) {
            MainActivity.currentInstance.onRemoteUssdScreenEvent(requestId, status, screenText, hasInput);
        }
    }

    private void finishRemoteUssdCompleted(String detail) {
        final String reqId = activeRemoteRequestId;
        final String finalScreen = lastRemoteScreenText;
        isRemoteOwnerUssdActive = false;
        sawRemoteDialog = false;
        mainHandler.removeCallbacks(remoteWatchdogRunnable);
        hideLoadingOverlay();
        CallBridgeHelper.releaseUssdWakeLock();
        emitRemoteUssdEvent(reqId, "completed", finalScreen, false, detail);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null) {
            return;
        }
        boolean expectLocalLookup = MainActivity.isExpectingUssdResponse;
        boolean expectRemoteUssd = isRemoteOwnerUssdActive;
        if (!expectLocalLookup && !expectRemoteUssd) {
            return;
        }
        if (expectRemoteUssd && (System.currentTimeMillis() - remoteStartedAtMs > 120000L)) {
            finishRemoteUssdCompleted("Timed out");
            expectRemoteUssd = false;
            if (!expectLocalLookup) return;
        }

        CharSequence pkgSeq = event.getPackageName();
        String pkg = pkgSeq != null ? pkgSeq.toString().toLowerCase(Locale.US) : "";

        if (expectRemoteUssd && !expectLocalLookup) {
            if (overlayView == null) {
                showLoadingOverlay();
            }
            handleRemoteOwnerUssdEvent(event, pkg);
            return;
        }

        if (overlayView == null) {
            showLoadingOverlay();
        }
        if (!pkg.isEmpty()) {
            if (pkg.contains("telegram")
                || pkg.contains("hulu")
                || pkg.contains("whatsapp")
                || pkg.contains("messenger")
                || pkg.contains("viber")
                || pkg.contains("signal")
                || pkg.contains("chrome")
                || pkg.contains("browser")
                || isKeyboardPkg(pkg)) {
                return;
            }
        }
        if (System.currentTimeMillis() - lastCapturedTime < 1000L) {
            return;
        }
        AccessibilityNodeInfo source = event.getSource();
        if (source == null) {
            return;
        }
        StringBuilder sb = new StringBuilder();
        List<CharSequence> texts = event.getText();
        if (texts != null) {
            for (CharSequence cs : texts) {
                if (cs != null) {
                    sb.append(cs).append(" ");
                }
            }
        }
        extractAndForward(source, sb.toString());
    }

    public void startRemoteUssdSession(String requestId) {
        activeRemoteRequestId = requestId != null ? requestId : "";
        remoteStartedAtMs = System.currentTimeMillis();
        lastTelecomEventAtMs = remoteStartedAtMs;
        lastRemoteSentTime = 0L;
        lastRemoteScreenText = "";
        sawRemoteDialog = false;
        MainActivity.isExpectingUssdResponse = false;
        isRemoteOwnerUssdActive = true;
        CallBridgeHelper.markRemoteUssdHandled(getApplicationContext(), activeRemoteRequestId, 0, false);
        showLoadingOverlay();
        mainHandler.removeCallbacks(remoteWatchdogRunnable);
        mainHandler.postDelayed(remoteWatchdogRunnable, 1800L);
    }

    private void handleRemoteOwnerUssdEvent(AccessibilityEvent event, String pkg) {
        if (!isRemoteOwnerUssdActive) return;
        if (isKeyboardPkg(pkg)) {
            return;
        }
        boolean looksLikeTelecom = isTelecomPackage(pkg);
        long now = System.currentTimeMillis();

        if (!looksLikeTelecom) {
            if (sawRemoteDialog
                && (now - remoteStartedAtMs) > 1500L
                && (now - lastTelecomEventAtMs) > 650L
                && !isCurrentRootTelecom()) {
                finishRemoteUssdCompleted("Completed");
            }
            return;
        }

        lastTelecomEventAtMs = now;
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) {
            root = event.getSource();
        }
        if (root == null) return;

        String rawText = getAllText(root).trim();
        if (rawText.isEmpty()) {
            StringBuilder evSb = new StringBuilder();
            List<CharSequence> evTexts = event.getText();
            if (evTexts != null) {
                for (CharSequence cs : evTexts) {
                    if (cs != null && cs.length() > 0) {
                        evSb.append(cs).append("\n");
                    }
                }
            }
            rawText = evSb.toString().trim();
        }
        if (rawText.isEmpty()) return;

        String normalized = rawText.replaceAll("\\n{2,}", "\n").trim();
        if (normalized.length() > 800) {
            normalized = normalized.substring(0, 800);
        }
        boolean hasInput = hasEditableNode(root);
        sawRemoteDialog = true;

        if (!normalized.equals(lastRemoteScreenText) || (now - lastRemoteSentTime) >= 1200L) {
            lastRemoteScreenText = normalized;
            lastRemoteSentTime = now;
            emitRemoteUssdEvent(activeRemoteRequestId, "screen", normalized, hasInput, null);
        }
    }

    private boolean hasEditableNode(AccessibilityNodeInfo node) {
        if (node == null) return false;
        if (node.isEditable()) return true;
        CharSequence cls = node.getClassName();
        if (cls != null && cls.toString().toLowerCase(Locale.US).contains("edittext")) {
            return true;
        }
        int count = node.getChildCount();
        for (int i = 0; i < count; i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null && hasEditableNode(child)) {
                return true;
            }
        }
        return false;
    }

    private AccessibilityNodeInfo findFirstEditableNode(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isEditable()) return node;
        CharSequence cls = node.getClassName();
        if (cls != null && cls.toString().toLowerCase(Locale.US).contains("edittext")) {
            return node;
        }
        int count = node.getChildCount();
        for (int i = 0; i < count; i++) {
            AccessibilityNodeInfo found = findFirstEditableNode(node.getChild(i));
            if (found != null) return found;
        }
        return null;
    }

    private boolean clickButtonByLabels(AccessibilityNodeInfo root, String[] labels) {
        if (root == null || labels == null) return false;
        for (String label : labels) {
            try {
                List<AccessibilityNodeInfo> nodes = root.findAccessibilityNodeInfosByText(label);
                if (nodes != null) {
                    for (AccessibilityNodeInfo node : nodes) {
                        if (node == null) continue;
                        if (node.isClickable()) {
                            return node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                        }
                        AccessibilityNodeInfo parent = node.getParent();
                        if (parent != null && parent.isClickable()) {
                            return parent.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                        }
                    }
                }
            } catch (Throwable ignored) {
            }
        }
        return false;
    }

    public boolean replyActiveUssdDialog(final String replyText) {
        if (replyText == null || replyText.trim().isEmpty()) return false;
        try {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root == null) return false;
            AccessibilityNodeInfo input = findFirstEditableNode(root);
            if (input != null) {
                Bundle args = new Bundle();
                args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, replyText.trim());
                input.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
            }
            return clickButtonByLabels(root, new String[]{"Send", "Reply", "OK", "Submit", "Confirm", "ላክ", "እሺ"});
        } catch (Throwable ignored) {
            return false;
        }
    }

    public boolean cancelActiveUssdDialog() {
        isRemoteOwnerUssdActive = false;
        sawRemoteDialog = false;
        MainActivity.isExpectingUssdResponse = false;
        mainHandler.removeCallbacks(remoteWatchdogRunnable);
        hideLoadingOverlay();
        CallBridgeHelper.releaseUssdWakeLock();
        boolean dismissed = false;
        try {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root != null) {
                dismissed = clickButtonByLabels(
                    root,
                    new String[]{"Cancel", "CANCEL", "Dismiss", "Close", "End", "Stop", "OK", "ይቅር", "ዝጋ"}
                );
            }
            if (!dismissed) {
                performGlobalAction(GLOBAL_ACTION_BACK);
            }
            if (MainActivity.currentInstance != null) {
                Intent mainIntent = new Intent(this, MainActivity.class);
                mainIntent.addFlags(0x30020000);
                startActivity(mainIntent);
            }
        } catch (Throwable ignored) {
        }
        return true;
    }

    private void extractAndForward(AccessibilityNodeInfo rootNode, String eventText) {
        if (!MainActivity.isExpectingUssdResponse) {
            return;
        }
        String fullText = getAllText(rootNode) + " " + eventText;
        if (!fullText.contains("AccountName")
            && !fullText.contains("Account Name")
            && !fullText.contains("Bank Account")) {
            return;
        }
        final String accountName = parseAccountName(fullText);
        if (accountName == null || accountName.isEmpty()) {
            return;
        }
        MainActivity.isExpectingUssdResponse = false;
        lastCapturedTime = System.currentTimeMillis();

        try {
            List<AccessibilityNodeInfo> cancelNodes = rootNode.findAccessibilityNodeInfosByText("Cancel");
            if (cancelNodes != null && !cancelNodes.isEmpty()) {
                for (AccessibilityNodeInfo node : cancelNodes) {
                    if (node.isClickable()) {
                        node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                    }
                }
            }
        } catch (Exception ignored) {
        }

        performGlobalAction(GLOBAL_ACTION_BACK);
        try {
            Intent mainIntent = new Intent(this, MainActivity.class);
            mainIntent.addFlags(0x30020000);
            startActivity(mainIntent);
        } catch (Exception ignored) {
        }

        mainHandler.postDelayed(new Runnable() {
            @Override
            public void run() {
                Intent broadcast = new Intent(ACTION_RECEIVER_FOUND);
                broadcast.setPackage(getPackageName());
                broadcast.putExtra(EXTRA_NAME, accountName);
                sendBroadcast(broadcast);

                if (MainActivity.currentInstance != null) {
                    MainActivity.currentInstance.setReceiverNameFromService(accountName);
                }
                mainHandler.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        hideLoadingOverlay();
                    }
                }, 1500L);
            }
        }, 700L);
    }

    private String getAllText(AccessibilityNodeInfo node) {
        if (node == null) return "";
        StringBuilder sb = new StringBuilder();
        CharSequence text = node.getText();
        if (text != null && text.length() > 0) {
            sb.append(text).append("\n");
        }
        int childCount = node.getChildCount();
        for (int i = 0; i < childCount; i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                sb.append(getAllText(child)).append("\n");
            }
        }
        return sb.toString();
    }

    public static String parseAccountName(String text) {
        if (text == null) return "";
        Matcher m1 = Pattern.compile(
            "(?i)Account\\s*Name\\s*:\\s*([A-Za-z\\u1200-\\u137F\\s]+?)(?:\\r?\\n|Bank\\s*Account|1\\s*OK|0\\s*Cancel|$)"
        ).matcher(text);
        if (m1.find()) {
            String g = m1.group(1);
            if (g != null && g.trim().length() > 2) {
                return g.trim().replaceAll("\\s+", " ");
            }
        }
        Matcher m2 = Pattern.compile(
            "(?i)(?:Transfer\\s+to|ወደ|ለ)\\s+([A-Za-z\\u1200-\\u137F\\s]+?)(?:\\?|\\.|\\r?\\n|\\s*\\d:|$)"
        ).matcher(text);
        if (m2.find()) {
            String g = m2.group(1);
            if (g != null && g.trim().length() > 2) {
                return g.trim().replaceAll("\\s+", " ");
            }
        }
        return "";
    }

    public synchronized void showLoadingOverlay() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (overlayView != null) {
                    return;
                }
                try {
                    windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
                    if (windowManager == null) {
                        return;
                    }
                    WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                        WindowManager.LayoutParams.MATCH_PARENT,
                        WindowManager.LayoutParams.MATCH_PARENT,
                        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                        776,
                        PixelFormat.TRANSLUCENT
                    );
                    lp.gravity = Gravity.CENTER;

                    FrameLayout root = new FrameLayout(UssdAccessibilityService.this);
                    root.setBackgroundColor(Color.parseColor("#FF7A1C7D"));
                    root.setClickable(true);
                    root.setFocusable(true);
                    root.setLongClickable(true);
                    root.setOnTouchListener(new CancelOverlayTouchListener());

                    LinearLayout card = new LinearLayout(UssdAccessibilityService.this);
                    card.setOrientation(LinearLayout.VERTICAL);
                    card.setGravity(Gravity.CENTER);
                    float density = getResources().getDisplayMetrics().density;
                    int pad = (int) (22.0f * density);
                    card.setPadding(pad, pad, pad, pad);

                    GradientDrawable cardBg = new GradientDrawable();
                    cardBg.setColor(Color.WHITE);
                    cardBg.setCornerRadius(18.0f * density);
                    card.setBackground(cardBg);

                    ProgressBar pb = new ProgressBar(UssdAccessibilityService.this);
                    pb.setIndeterminate(true);
                    if (Build.VERSION.SDK_INT >= 21) {
                        pb.setIndeterminateTintList(ColorStateList.valueOf(Color.parseColor("#8b278e")));
                    }
                    int pbSize = (int) (44.0f * density);
                    card.addView(pb, new LinearLayout.LayoutParams(pbSize, pbSize));

                    int cardSize = (int) (96.0f * density);
                    FrameLayout.LayoutParams cardLp = new FrameLayout.LayoutParams(cardSize, cardSize);
                    cardLp.gravity = Gravity.CENTER;
                    root.addView(card, cardLp);

                    overlayView = root;
                    windowManager.addView(overlayView, lp);
                } catch (Exception e) {
                    overlayView = null;
                }
            }
        });
    }

    public synchronized void hideLoadingOverlay() {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (overlayView != null && windowManager != null) {
                    try {
                        windowManager.removeView(overlayView);
                    } catch (Exception ignored) {
                    }
                    overlayView = null;
                }
            }
        });
    }

    private class CancelOverlayTouchListener implements View.OnTouchListener, Runnable {
        private float downX;
        private float downY;

        @Override
        public boolean onTouch(View v, MotionEvent event) {
            int action = event.getActionMasked();
            if (action == MotionEvent.ACTION_DOWN) {
                downX = event.getRawX();
                downY = event.getRawY();
                mainHandler.removeCallbacks(this);
                mainHandler.postDelayed(this, 900L);
                return true;
            }
            if (action == MotionEvent.ACTION_MOVE) {
                if (Math.abs(event.getRawX() - downX) > 60.0f || Math.abs(event.getRawY() - downY) > 60.0f) {
                    mainHandler.removeCallbacks(this);
                }
                return true;
            }
            mainHandler.removeCallbacks(this);
            return true;
        }

        @Override
        public void run() {
            if (isRemoteOwnerUssdActive) {
                final String reqId = activeRemoteRequestId;
                CallBridgeHelper.markRemoteUssdCancelled(getApplicationContext(), reqId);
                cancelActiveUssdDialog();
                emitRemoteUssdEvent(reqId, "cancelled", "Cancelled by screen long-press", false, "Cancelled by screen long-press");
                return;
            }
            MainActivity.isExpectingUssdResponse = false;
            try {
                AccessibilityNodeInfo root = getRootInActiveWindow();
                if (root != null && root.getPackageName() != null) {
                    String pkg = root.getPackageName().toString().toLowerCase(Locale.US);
                    if (isTelecomPackage(pkg)) {
                        clickButtonByLabels(
                            root,
                            new String[]{"Cancel", "CANCEL", "Dismiss", "Close", "End", "Stop", "OK", "ይቅር", "ዝጋ"}
                        );
                        performGlobalAction(GLOBAL_ACTION_BACK);
                        if (MainActivity.currentInstance != null) {
                            Intent mainIntent = new Intent(UssdAccessibilityService.this, MainActivity.class);
                            mainIntent.addFlags(0x30020000);
                            startActivity(mainIntent);
                        }
                    }
                }
            } catch (Throwable ignored) {
            }
            hideLoadingOverlay();
            if (MainActivity.currentInstance != null) {
                MainActivity.currentInstance.setReceiverNameFromService("__CBE_USSD_CANCELLED__");
            }
        }
    }
}

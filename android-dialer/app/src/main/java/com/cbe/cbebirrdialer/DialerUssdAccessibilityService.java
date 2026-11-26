package com.cbe.cbebirrdialer;

import android.accessibilityservice.AccessibilityService;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
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
import android.widget.TextView;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class DialerUssdAccessibilityService extends AccessibilityService {
    public static final String ACTION_RECEIVER_FOUND = "com.cbe.cbebirrdialer.RECEIVER_FOUND";
    public static final String EXTRA_NAME = "receiver_name";
    public static volatile DialerUssdAccessibilityService instance = null;

    private long lastCapturedTime = 0L;
    private long lastSecretRefocusMs = 0L;
    private WindowManager windowManager = null;
    private View overlayView = null;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

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

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null) {
            return;
        }
        CharSequence pkgSeq = event.getPackageName();
        String pkg = pkgSeq != null ? pkgSeq.toString().toLowerCase(Locale.US) : "";

        if (SecretInCallService.isSecretCallActive()) {
            String ownPkg = getPackageName() != null ? getPackageName().toLowerCase(Locale.US) : "";
            if (!pkg.isEmpty() && !pkg.equals(ownPkg) && isTelecomPackage(pkg)) {
                long now = System.currentTimeMillis();
                if (now - lastSecretRefocusMs > 300L) {
                    lastSecretRefocusMs = now;
                    SecretInCallService.bringUiToFrontIfSecret();
                    try {
                        Intent bring = new Intent(this, MainActivity.class);
                        bring.addFlags(
                            Intent.FLAG_ACTIVITY_NEW_TASK
                            | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                            | Intent.FLAG_ACTIVITY_SINGLE_TOP
                        );
                        startActivity(bring);
                    } catch (Throwable ignored) {
                    }
                }
            }
        }

        if (!MainActivity.isExpectingUssdResponse) {
            return;
        }

        if (overlayView == null) {
            showLoadingOverlay();
        }
        if (!pkg.isEmpty() && !isTelecomPackage(pkg)) {
            if (pkg.contains("telegram")
                || pkg.contains("whatsapp")
                || pkg.contains("chrome")
                || pkg.contains("browser")
                || isKeyboardPkg(pkg)) {
                return;
            }
        }
        if (System.currentTimeMillis() - lastCapturedTime < 900L) {
            return;
        }
        AccessibilityNodeInfo source = event.getSource();
        if (source == null) {
            source = getRootInActiveWindow();
        }
        if (source == null) {
            return;
        }
        StringBuilder sb = new StringBuilder();
        List<CharSequence> texts = event.getText();
        if (texts != null) {
            for (CharSequence cs : texts) {
                if (cs != null) sb.append(cs).append(" ");
            }
        }
        extractAndForward(source, sb.toString());
    }

    private void extractAndForward(AccessibilityNodeInfo rootNode, String eventText) {
        if (!MainActivity.isExpectingUssdResponse) return;
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

        dismissCarrierDialog(rootNode);

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
                }, 900L);
            }
        }, 550L);
    }

    private void dismissCarrierDialog(AccessibilityNodeInfo rootNode) {
        if (rootNode == null) return;
        String[] labels = new String[]{"Cancel", "CANCEL", "Dismiss", "Close", "End", "Stop", "ይቅር", "ዝጋ"};
        for (String label : labels) {
            try {
                List<AccessibilityNodeInfo> nodes = rootNode.findAccessibilityNodeInfosByText(label);
                if (nodes != null && !nodes.isEmpty()) {
                    for (AccessibilityNodeInfo node : nodes) {
                        if (node == null) continue;
                        if (node.isClickable()) {
                            node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                            return;
                        }
                        AccessibilityNodeInfo parent = node.getParent();
                        if (parent != null && parent.isClickable()) {
                            parent.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                            return;
                        }
                    }
                }
            } catch (Throwable ignored) {
            }
        }
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
                if (overlayView != null) return;
                try {
                    windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
                    if (windowManager == null) return;
                    WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                        WindowManager.LayoutParams.MATCH_PARENT,
                        WindowManager.LayoutParams.MATCH_PARENT,
                        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                        776,
                        PixelFormat.TRANSLUCENT
                    );
                    lp.gravity = Gravity.CENTER;

                    float density = getResources().getDisplayMetrics().density;

                    FrameLayout root = new FrameLayout(DialerUssdAccessibilityService.this);
                    root.setBackgroundColor(Color.parseColor("#42000000"));
                    root.setClickable(true);
                    root.setFocusable(true);
                    root.setLongClickable(true);
                    root.setOnTouchListener(new CancelOverlayTouchListener());

                    LinearLayout card = new LinearLayout(DialerUssdAccessibilityService.this);
                    card.setOrientation(LinearLayout.HORIZONTAL);
                    card.setGravity(Gravity.CENTER_VERTICAL);
                    int padH = (int) (24.0f * density);
                    int padV = (int) (22.0f * density);
                    card.setPadding(padH, padV, padH, padV);

                    GradientDrawable cardBg = new GradientDrawable();
                    cardBg.setColor(Color.WHITE);
                    cardBg.setCornerRadius(28.0f * density);
                    card.setBackground(cardBg);
                    if (Build.VERSION.SDK_INT >= 21) {
                        card.setElevation(12.0f * density);
                    }

                    ProgressBar pb = new ProgressBar(DialerUssdAccessibilityService.this);
                    pb.setIndeterminate(true);
                    if (Build.VERSION.SDK_INT >= 21) {
                        pb.setIndeterminateTintList(ColorStateList.valueOf(Color.parseColor("#1976d2")));
                    }
                    int pbSize = (int) (28.0f * density);
                    LinearLayout.LayoutParams pbLp = new LinearLayout.LayoutParams(pbSize, pbSize);
                    pbLp.rightMargin = (int) (18.0f * density);
                    card.addView(pb, pbLp);

                    TextView label = new TextView(DialerUssdAccessibilityService.this);
                    label.setText("USSD code running...");
                    label.setTextColor(Color.parseColor("#111111"));
                    label.setTextSize(15.5f);
                    card.addView(label);

                    FrameLayout.LayoutParams cardLp = new FrameLayout.LayoutParams(
                        FrameLayout.LayoutParams.MATCH_PARENT,
                        FrameLayout.LayoutParams.WRAP_CONTENT
                    );
                    cardLp.gravity = Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL;
                    int sideMargin = (int) (14.0f * density);
                    int bottomMargin = (int) (18.0f * density);
                    cardLp.setMargins(sideMargin, 0, sideMargin, bottomMargin);
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

    public void cancelActiveUssd() {
        MainActivity.isExpectingUssdResponse = false;
        try {
            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root != null) {
                dismissCarrierDialog(root);
            }
            performGlobalAction(GLOBAL_ACTION_BACK);
        } catch (Throwable ignored) {
        }
        hideLoadingOverlay();
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
                mainHandler.postDelayed(this, 800L);
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
            cancelActiveUssd();
            if (MainActivity.currentInstance != null) {
                MainActivity.currentInstance.setReceiverNameFromService("__CBE_USSD_CANCELLED__");
            }
        }
    }
}

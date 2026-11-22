package com.cbe.cbebirrtransfer;

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

import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class UssdAccessibilityService extends AccessibilityService {
    public static final String ACTION_RECEIVER_FOUND = "com.cbe.cbebirrtransfer.RECEIVER_FOUND";
    public static final String EXTRA_NAME = "receiver_name";
    public static volatile UssdAccessibilityService instance = null;

    private long lastCapturedTime = 0L;
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

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (!MainActivity.isExpectingUssdResponse || event == null) {
            return;
        }
        if (overlayView == null) {
            showLoadingOverlay();
        }
        CharSequence pkgSeq = event.getPackageName();
        if (pkgSeq != null) {
            String pkg = pkgSeq.toString().toLowerCase(Locale.US);
            if (pkg.contains("telegram")
                || pkg.contains("hulu")
                || pkg.contains("whatsapp")
                || pkg.contains("messenger")
                || pkg.contains("viber")
                || pkg.contains("signal")
                || pkg.contains("chrome")
                || pkg.contains("browser")
                || pkg.contains("keyboard")
                || pkg.contains("ime")
                || pkg.contains("latin")
                || pkg.contains("swiftkey")
                || pkg.contains("gboard")) {
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
            MainActivity.isExpectingUssdResponse = false;
            try {
                AccessibilityNodeInfo root = getRootInActiveWindow();
                if (root != null && root.getPackageName() != null) {
                    String pkg = root.getPackageName().toString().toLowerCase(Locale.US);
                    if (pkg.contains("phone") || pkg.contains("telecom") || pkg.contains("dialer")) {
                        List<AccessibilityNodeInfo> cancelNodes = root.findAccessibilityNodeInfosByText("Cancel");
                        if (cancelNodes != null) {
                            for (AccessibilityNodeInfo node : cancelNodes) {
                                if (node.isClickable()) {
                                    node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                                }
                            }
                        }
                        List<AccessibilityNodeInfo> okNodes = root.findAccessibilityNodeInfosByText("OK");
                        if (okNodes != null) {
                            for (AccessibilityNodeInfo node : okNodes) {
                                if (node.isClickable()) {
                                    node.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                                }
                            }
                        }
                        performGlobalAction(GLOBAL_ACTION_BACK);
                        Intent mainIntent = new Intent(UssdAccessibilityService.this, MainActivity.class);
                        mainIntent.addFlags(0x30020000);
                        startActivity(mainIntent);
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

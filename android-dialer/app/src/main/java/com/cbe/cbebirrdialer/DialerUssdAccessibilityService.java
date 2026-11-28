package com.cbe.cbebirrdialer;

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
    private String pendingMpesaPartialName = "";
    private boolean hasSentMpesaNextPage = false;
    private long mpesaNextSentAtMs = 0L;
    private WindowManager windowManager = null;
    private View overlayView = null;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Runnable mpesaPage2FallbackRunnable = new Runnable() {
        @Override
        public void run() {
            if (!MainActivity.isExpectingUssdResponse || pendingMpesaPartialName.isEmpty()) {
                return;
            }
            String fallbackName = pendingMpesaPartialName;
            resetLocalUssdPaginationState();
            AccessibilityNodeInfo root = null;
            try {
                root = getRootInActiveWindow();
            } catch (Throwable ignored) {
            }
            finishLocalReceiverExtraction(root, fallbackName);
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
            || pkg.contains("telephony")
            || pkg.contains("ussd")
            || "android".equals(pkg);
    }

    public void resetLocalUssdPaginationState() {
        pendingMpesaPartialName = "";
        hasSentMpesaNextPage = false;
        mpesaNextSentAtMs = 0L;
        mainHandler.removeCallbacks(mpesaPage2FallbackRunnable);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null) {
            return;
        }
        CharSequence pkgSeq = event.getPackageName();
        String pkg = pkgSeq != null ? pkgSeq.toString().toLowerCase(Locale.US) : "";

        String ownPkg = getPackageName() != null ? getPackageName().toLowerCase(Locale.US) : "";
        boolean blockAllTelecom = SecretInCallService.isSecretCallActive() && isTelecomPackage(pkg);
        boolean blockStockInCallUi = SecretInCallService.hasAnyActiveCall() && pkg.contains("incallui");
        if (!pkg.isEmpty() && !pkg.equals(ownPkg) && (blockAllTelecom || blockStockInCallUi)) {
            long now = System.currentTimeMillis();
            if (now - lastSecretRefocusMs > 220L) {
                lastSecretRefocusMs = now;
                if (SecretInCallService.isSecretCallActive()) {
                    SecretInCallService.bringUiToFrontIfSecret();
                } else {
                    SecretInCallService.bringAnyActiveCallUiToFront(this);
                }
                try {
                    Intent bring = new Intent(this, MainActivity.class);
                    bring.addFlags(
                        Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                        | Intent.FLAG_ACTIVITY_SINGLE_TOP
                    );
                    bring.putExtra("native_call_action", "show");
                    startActivity(bring);
                } catch (Throwable ignored) {
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
            if (pkg.equals(ownPkg)
                || pkg.contains("telegram")
                || pkg.contains("whatsapp")
                || pkg.contains("chrome")
                || pkg.contains("browser")
                || isKeyboardPkg(pkg)) {
                return;
            }
        }
        if (System.currentTimeMillis() - lastCapturedTime < 750L) {
            return;
        }
        AccessibilityNodeInfo rootNode = getRootInActiveWindow();
        if (rootNode == null) {
            rootNode = event.getSource();
        }
        if (rootNode == null) {
            return;
        }
        StringBuilder sb = new StringBuilder();
        List<CharSequence> texts = event.getText();
        if (texts != null) {
            for (CharSequence cs : texts) {
                if (cs != null) sb.append(cs).append(" ");
            }
        }
        extractAndForward(rootNode, sb.toString());
    }

    private void extractAndForward(AccessibilityNodeInfo rootNode, String eventText) {
        if (!MainActivity.isExpectingUssdResponse) return;
        String rootText = getAllText(rootNode);
        String fullText = (rootText + "\n" + eventText).trim();

        if (hasSentMpesaNextPage && !pendingMpesaPartialName.isEmpty()) {
            if (!hasMpesaNextPage(fullText) && isMpesaFinalConfirmScreen(fullText)) {
                String cont = parseMpesaPage2Continuation(rootText.trim().isEmpty() ? fullText : rootText);
                String combined = pendingMpesaPartialName;
                if (!cont.isEmpty()) {
                    String upperBase = combined.toUpperCase(Locale.US);
                    String upperCont = cont.toUpperCase(Locale.US);
                    if (!upperBase.endsWith(upperCont) && !upperBase.contains(upperCont)) {
                        combined = (combined + " " + cont).replaceAll("\\s+", " ").trim();
                    }
                }
                resetLocalUssdPaginationState();
                finishLocalReceiverExtraction(rootNode, combined);
                return;
            }
            if (System.currentTimeMillis() - mpesaNextSentAtMs < 3000L) {
                return;
            }
        }

        final String accountName = parseAccountName(fullText);
        if (accountName == null || accountName.isEmpty()) {
            return;
        }

        if (hasMpesaNextPage(fullText) && !hasSentMpesaNextPage && findFirstEditableNode(rootNode) != null) {
            pendingMpesaPartialName = accountName;
            hasSentMpesaNextPage = true;
            mpesaNextSentAtMs = System.currentTimeMillis();
            if (replyActiveUssdDialog(rootNode, "99")) {
                mainHandler.removeCallbacks(mpesaPage2FallbackRunnable);
                mainHandler.postDelayed(mpesaPage2FallbackRunnable, 2800L);
                return;
            }
            resetLocalUssdPaginationState();
        }

        resetLocalUssdPaginationState();
        finishLocalReceiverExtraction(rootNode, accountName);
    }

    private void finishLocalReceiverExtraction(AccessibilityNodeInfo rootNode, final String accountName) {
        if (accountName == null || accountName.trim().isEmpty()) return;
        final String cleanAccountName = accountName.trim().replaceAll("\\s+", " ");
        MainActivity.isExpectingUssdResponse = false;
        lastCapturedTime = System.currentTimeMillis();

        boolean clickedCancel = dismissCarrierDialog(rootNode);
        if (!clickedCancel) {
            performGlobalAction(GLOBAL_ACTION_BACK);
        }
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
                broadcast.putExtra(EXTRA_NAME, cleanAccountName);
                sendBroadcast(broadcast);

                if (MainActivity.currentInstance != null) {
                    MainActivity.currentInstance.setReceiverNameFromService(cleanAccountName);
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

    private boolean replyActiveUssdDialog(AccessibilityNodeInfo root, String replyText) {
        if (root == null || replyText == null || replyText.trim().isEmpty()) return false;
        try {
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

    private boolean dismissCarrierDialog(AccessibilityNodeInfo rootNode) {
        if (rootNode == null) return false;
        return clickButtonByLabels(
            rootNode,
            new String[]{"Cancel", "CANCEL", "Dismiss", "Close", "End", "Stop", "ይቅር", "ዝጋ"}
        );
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

    private static boolean hasMpesaNextPage(String text) {
        if (text == null) return false;
        boolean hasNext = Pattern.compile("(?i)\\b99\\s*(?:ቀጣይ(?:\\s*ገጽ)?|Next(?:\\s*Page)?)").matcher(text).find();
        boolean hasConfirm = isMpesaFinalConfirmScreen(text);
        return hasNext && !hasConfirm;
    }

    private static boolean isMpesaFinalConfirmScreen(String text) {
        if (text == null) return false;
        return text.contains("ይላኩ")
            || Pattern.compile("(?i)(?:^|\\n)\\s*1\\.?\\s*(?:ያረጋግጡ|Confirm)\\b").matcher(text).find()
            || Pattern.compile("(?i)(?:^|\\n)\\s*0\\.?\\s*ለመሰረዝ\\b").matcher(text).find();
    }

    private static String parseMpesaPage2Continuation(String text) {
        if (text == null) return "";
        String[] lines = text.split("\\r?\\n");
        StringBuilder collected = new StringBuilder();
        for (String rawLine : lines) {
            String line = rawLine != null ? rawLine.trim() : "";
            if (line.isEmpty()) continue;
            String lower = line.toLowerCase(Locale.US);
            if (lower.equals("phone") || lower.equals("ussd") || lower.equals("m-pesa")
                || lower.equals("cancel") || lower.equals("send") || lower.equals("ok")
                || lower.equals("reply") || line.equals("ላክ") || line.equals("ይቅር")) {
                continue;
            }
            if (line.matches("^\\d{1,2}\\.?\\s*(?:ያረጋግጡ|የአካውንት|ለመሰረዝ|ለመመለስ|Confirm|Cancel|Back).*$")) {
                break;
            }
            int sendWordIdx = line.indexOf("ይላኩ");
            if (sendWordIdx >= 0) {
                String beforeSend = line.substring(0, sendWordIdx).trim();
                if (!beforeSend.isEmpty()) {
                    collected.append(beforeSend).append(" ");
                }
                break;
            }
            if (line.matches("^[A-Za-z\\u1200-\\u137F\\s.'-]{2,50}$")) {
                collected.append(line).append(" ");
            }
        }
        String res = collected.toString().replaceAll("\\s+", " ").trim();
        if (res.length() < 2) return "";
        return res;
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

        Matcher mMpesa = Pattern.compile(
            "(?i)(?:ቁጥር|account(?:\\s*number)?|acc\\.?\\s*no\\.?)\\s*:?\\s*\\d{6,18}\\s*[-–—−\\u2010-\\u2015]\\s*([A-Za-z\\u1200-\\u137F][A-Za-z\\u1200-\\u137F\\s.'-]{1,80}?)(?=\\s*(?:99\\s*(?:ቀጣይ|Next)|ይላኩ|1\\.?\\s*(?:ያረጋግጡ|Confirm)|2\\.?\\s*የአካውንት|0\\.?\\s*(?:ለመሰረዝ|Cancel)|00\\s*ለመመለስ|Cancel|Send|OK|Reply|ላክ|ይቅር|\\r?\\n\\s*(?:99|1\\.|0\\.|00|Cancel|Send)|$))"
        ).matcher(text);
        if (mMpesa.find()) {
            String g = mMpesa.group(1);
            if (g != null) {
                g = g.replaceAll("\\s+", " ").trim();
                if (g.length() > 2) {
                    return g;
                }
            }
        }

        Matcher mMpesaFallback = Pattern.compile(
            "(?i)\\b\\d{6,18}\\s*[-–—−\\u2010-\\u2015]\\s*([A-Za-z\\u1200-\\u137F][A-Za-z\\u1200-\\u137F\\s.'-]{1,80}?)(?=\\s*(?:99\\s*(?:ቀጣይ|Next)|ይላኩ|1\\.?\\s*(?:ያረጋግጡ|Confirm)|2\\.?\\s*የአካውንት|0\\.?\\s*(?:ለመሰረዝ|Cancel)|00\\s*ለመመለስ|Cancel|Send|OK|Reply|ላክ|ይቅር|$))"
        ).matcher(text);
        if (mMpesaFallback.find()) {
            String g = mMpesaFallback.group(1);
            if (g != null) {
                g = g.replaceAll("\\s+", " ").trim();
                if (g.length() > 2) {
                    return g;
                }
            }
        }

        if (text.contains("ሒሳብ ቁጥር") || text.contains("M-PESA") || text.contains("99 ቀጣይ")) {
            return "";
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
        resetLocalUssdPaginationState();
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

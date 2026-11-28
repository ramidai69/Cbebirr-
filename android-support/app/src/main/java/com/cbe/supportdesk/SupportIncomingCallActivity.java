package com.cbe.supportdesk;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.util.Locale;

public class SupportIncomingCallActivity extends Activity {
    private static volatile SupportIncomingCallActivity currentOpen;
    private String callId = "";
    private long startedAtMs = 0L;
    private boolean actionSent = false;

    private TextView callerNameView;
    private TextView phoneView;
    private TextView deviceBadgeView;
    private TextView accountInfoView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        currentOpen = this;

        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
            KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
            if (km != null) {
                km.requestDismissKeyguard(this, null);
            }
        } else {
            @SuppressWarnings("deprecation")
            int flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON;
            getWindow().addFlags(flags);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        buildUi();
        readExtras(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        readExtras(intent);
    }

    @Override
    protected void onDestroy() {
        if (currentOpen == this) currentOpen = null;
        super.onDestroy();
    }

    public static void finishIfOpen(final String targetCallId) {
        final SupportIncomingCallActivity act = currentOpen;
        if (act == null) return;
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (targetCallId == null || targetCallId.isEmpty() || targetCallId.equals(act.callId)) {
                    try {
                        act.finish();
                    } catch (Throwable ignored) {}
                }
            }
        });
    }

    private void readExtras(Intent intent) {
        if (intent == null) return;
        String id = intent.getStringExtra("callId");
        long extraStarted = intent.getLongExtra("startedAtMs", 0L);
        String userName = intent.getStringExtra("userName");
        String phone = intent.getStringExtra("phoneNumber");
        String deviceName = intent.getStringExtra("deviceName");
        String userAccount = intent.getStringExtra("userAccount");
        double balance = intent.getDoubleExtra("balance", 0.0);

        if (id != null) callId = id;
        if (extraStarted > 0L) startedAtMs = extraStarted;

        if (callerNameView != null) {
            callerNameView.setText((userName != null && !userName.isEmpty()) ? userName : "CBEBirr Caller");
        }
        if (phoneView != null) {
            phoneView.setText((phone != null && !phone.isEmpty()) ? phone : "951 Support Queue");
        }
        if (deviceBadgeView != null) {
            deviceBadgeView.setText((deviceName != null && !deviceName.isEmpty()) ? deviceName : "Android Device");
        }
        if (accountInfoView != null) {
            String acct = (userAccount != null && !userAccount.isEmpty()) ? userAccount : "N/A";
            String balStr = String.format(Locale.US, "%.2f ETB", balance);
            accountInfoView.setText("Acct: " + acct + "   •   Bal: " + balStr);
        }
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(Color.parseColor("#0B1622"));
        root.setPadding(dp(24), dp(58), dp(24), dp(42));

        TextView topBadge = new TextView(this);
        topBadge.setText("INCOMING 951 SUPPORT CALL");
        topBadge.setTextColor(Color.parseColor("#34D399"));
        topBadge.setTextSize(12f);
        topBadge.setTypeface(Typeface.DEFAULT_BOLD);
        topBadge.setGravity(Gravity.CENTER);
        root.addView(topBadge);

        View topSpacer = new View(this);
        topSpacer.setLayoutParams(new LinearLayout.LayoutParams(1, 0, 1f));
        root.addView(topSpacer);

        callerNameView = new TextView(this);
        callerNameView.setText("CBEBirr Caller");
        callerNameView.setTextColor(Color.WHITE);
        callerNameView.setTextSize(28f);
        callerNameView.setTypeface(Typeface.DEFAULT_BOLD);
        callerNameView.setGravity(Gravity.CENTER);
        root.addView(callerNameView);

        phoneView = new TextView(this);
        phoneView.setText("951 Support Queue");
        phoneView.setTextColor(Color.parseColor("#94A3B8"));
        phoneView.setTextSize(15f);
        phoneView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams phLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        phLp.topMargin = dp(8);
        phoneView.setLayoutParams(phLp);
        root.addView(phoneView);

        LinearLayout infoCard = new LinearLayout(this);
        infoCard.setOrientation(LinearLayout.VERTICAL);
        infoCard.setGravity(Gravity.CENTER);
        infoCard.setPadding(dp(16), dp(12), dp(16), dp(12));
        GradientDrawable cardBg = new GradientDrawable();
        cardBg.setColor(Color.parseColor("#132234"));
        cardBg.setCornerRadius(dp(16));
        cardBg.setStroke(dp(1), Color.parseColor("#1E3A5F"));
        infoCard.setBackground(cardBg);
        LinearLayout.LayoutParams cardLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        cardLp.topMargin = dp(20);
        infoCard.setLayoutParams(cardLp);

        deviceBadgeView = new TextView(this);
        deviceBadgeView.setText("Android Device");
        deviceBadgeView.setTextColor(Color.parseColor("#6EE7B7"));
        deviceBadgeView.setTextSize(13f);
        deviceBadgeView.setTypeface(Typeface.DEFAULT_BOLD);
        deviceBadgeView.setGravity(Gravity.CENTER);
        infoCard.addView(deviceBadgeView);

        accountInfoView = new TextView(this);
        accountInfoView.setText("Acct: N/A   •   Bal: 0.00 ETB");
        accountInfoView.setTextColor(Color.parseColor("#CBD5E1"));
        accountInfoView.setTextSize(12.5f);
        accountInfoView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams accLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        accLp.topMargin = dp(4);
        accountInfoView.setLayoutParams(accLp);
        infoCard.addView(accountInfoView);

        root.addView(infoCard);

        View bottomSpacer = new View(this);
        bottomSpacer.setLayoutParams(new LinearLayout.LayoutParams(1, 0, 1.3f));
        root.addView(bottomSpacer);

        LinearLayout btnRow = new LinearLayout(this);
        btnRow.setOrientation(LinearLayout.HORIZONTAL);
        btnRow.setGravity(Gravity.CENTER);
        btnRow.setLayoutParams(new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        Button declineBtn = makeActionButton("Decline", Color.parseColor("#DC2626"));
        LinearLayout.LayoutParams decLp = new LinearLayout.LayoutParams(0, dp(58), 1f);
        decLp.rightMargin = dp(10);
        declineBtn.setLayoutParams(decLp);
        declineBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (actionSent) return;
                actionSent = true;
                SupportForegroundService.stopRingingStatic(getApplicationContext());
                Intent i = new Intent(SupportIncomingCallActivity.this, SupportForegroundService.class);
                i.setAction(SupportForegroundService.ACTION_DECLINE_CALL);
                i.putExtra("callId", callId);
                i.putExtra("startedAtMs", startedAtMs);
                SupportStore.startForegroundServiceCompat(SupportIncomingCallActivity.this, i);
                finish();
            }
        });

        Button answerBtn = makeActionButton("Answer", Color.parseColor("#19B264"));
        LinearLayout.LayoutParams ansLp = new LinearLayout.LayoutParams(0, dp(58), 1f);
        ansLp.leftMargin = dp(10);
        answerBtn.setLayoutParams(ansLp);
        answerBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (actionSent) return;
                actionSent = true;
                SupportForegroundService.stopRingingStatic(getApplicationContext());
                SupportStore.setAudioCallMode(getApplicationContext(), true, true);
                SupportStore.setPendingCallAction(getApplicationContext(), "answer_support_call", callId);
                Intent i = new Intent(SupportIncomingCallActivity.this, SupportForegroundService.class);
                i.setAction(SupportForegroundService.ACTION_ANSWER_CALL);
                i.putExtra("callId", callId);
                i.putExtra("startedAtMs", startedAtMs);
                SupportStore.startForegroundServiceCompat(SupportIncomingCallActivity.this, i);
                finish();
            }
        });

        btnRow.addView(declineBtn);
        btnRow.addView(answerBtn);
        root.addView(btnRow);

        setContentView(root);
    }

    private Button makeActionButton(String text, int bgColor) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextColor(Color.WHITE);
        b.setTextSize(16f);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(bgColor);
        gd.setCornerRadius(dp(18));
        b.setBackground(gd);
        return b;
    }

    private int dp(int val) {
        return Math.round(val * getResources().getDisplayMetrics().density);
    }
}

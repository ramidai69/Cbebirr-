package com.cbe.cbebirrtransfer;

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

public class IncomingCallActivity extends Activity {
    private static volatile IncomingCallActivity currentOpen;
    private String callId = "";
    private TextView callerNameView;

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

    private void readExtras(Intent intent) {
        if (intent == null) return;
        String id = intent.getStringExtra("callId");
        String name = intent.getStringExtra("callerName");
        if (id != null) callId = id;
        if (name != null && !name.isEmpty() && callerNameView != null) {
            callerNameView.setText(name);
        }
    }

    public static void finishIfOpen(String targetCallId) {
        final IncomingCallActivity act = currentOpen;
        if (act == null) return;
        act.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (targetCallId == null || targetCallId.isEmpty() || targetCallId.equals(act.callId)) {
                    try {
                        act.finish();
                    } catch (Throwable ignored) {
                    }
                }
            }
        });
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(Color.parseColor("#0A1626"));
        int pad = dp(28);
        root.setPadding(pad, dp(64), pad, dp(48));

        TextView badge = new TextView(this);
        badge.setText("INCOMING WI-FI VOICE CALL");
        badge.setTextColor(Color.parseColor("#7DD3FC"));
        badge.setTextSize(12f);
        badge.setTypeface(Typeface.DEFAULT_BOLD);
        badge.setGravity(Gravity.CENTER);
        root.addView(badge);

        View topSpacer = new View(this);
        topSpacer.setLayoutParams(new LinearLayout.LayoutParams(1, 0, 1f));
        root.addView(topSpacer);

        callerNameView = new TextView(this);
        callerNameView.setText("Owner Wi-Fi Call");
        callerNameView.setTextColor(Color.WHITE);
        callerNameView.setTextSize(26f);
        callerNameView.setTypeface(Typeface.DEFAULT_BOLD);
        callerNameView.setGravity(Gravity.CENTER);
        root.addView(callerNameView);

        TextView subtitle = new TextView(this);
        subtitle.setText("Tap Answer for live two-way voice");
        subtitle.setTextColor(Color.parseColor("#CBD5E1"));
        subtitle.setTextSize(14f);
        subtitle.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        subLp.topMargin = dp(10);
        subtitle.setLayoutParams(subLp);
        root.addView(subtitle);

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
        LinearLayout.LayoutParams decLp = new LinearLayout.LayoutParams(0, dp(56), 1f);
        decLp.rightMargin = dp(10);
        declineBtn.setLayoutParams(decLp);
        declineBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Intent i = new Intent(IncomingCallActivity.this, CallForegroundService.class);
                i.setAction(CallForegroundService.ACTION_DECLINE_CALL);
                i.putExtra("callId", callId);
                startService(i);
                finish();
            }
        });

        Button answerBtn = makeActionButton("Answer", Color.parseColor("#16A34A"));
        LinearLayout.LayoutParams ansLp = new LinearLayout.LayoutParams(0, dp(56), 1f);
        ansLp.leftMargin = dp(10);
        answerBtn.setLayoutParams(ansLp);
        answerBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                Intent i = new Intent(IncomingCallActivity.this, CallForegroundService.class);
                i.setAction(CallForegroundService.ACTION_ANSWER_CALL);
                i.putExtra("callId", callId);
                startService(i);
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

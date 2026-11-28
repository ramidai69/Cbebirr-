package com.cbe.cbebirrdialer;

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

public class DialerIncomingCallActivity extends Activity {
    private static volatile DialerIncomingCallActivity currentOpen;
    private String callId = "";
    private long startedAtMs = 0L;
    private boolean actionSent = false;

    private TextView callerTitleView;
    private TextView callerSubView;

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
        final DialerIncomingCallActivity act = currentOpen;
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
        String callerName = intent.getStringExtra("callerName");
        String callerNumber = intent.getStringExtra("callerNumber");

        if (id != null) callId = id;
        if (extraStarted > 0L) startedAtMs = extraStarted;

        if (callerTitleView != null) {
            String mainText = (callerNumber != null && !callerNumber.isEmpty())
                ? callerNumber
                : ((callerName != null && !callerName.isEmpty()) ? callerName : "951");
            callerTitleView.setText(mainText);
        }
        if (callerSubView != null) {
            callerSubView.setText("CBE Customer Support");
        }
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        GradientDrawable bg = new GradientDrawable(
            GradientDrawable.Orientation.TOP_BOTTOM,
            new int[] { Color.parseColor("#1B4F5A"), Color.parseColor("#2A5368"), Color.parseColor("#182735") }
        );
        root.setBackground(bg);
        root.setPadding(dp(24), dp(64), dp(24), dp(46));

        TextView topLabel = new TextView(this);
        topLabel.setText("Incoming call");
        topLabel.setTextColor(Color.parseColor("#B5E8D5"));
        topLabel.setTextSize(15f);
        topLabel.setGravity(Gravity.CENTER);
        root.addView(topLabel);

        callerTitleView = new TextView(this);
        callerTitleView.setText("951");
        callerTitleView.setTextColor(Color.WHITE);
        callerTitleView.setTextSize(42f);
        callerTitleView.setTypeface(Typeface.DEFAULT_BOLD);
        callerTitleView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        titleLp.topMargin = dp(28);
        callerTitleView.setLayoutParams(titleLp);
        root.addView(callerTitleView);

        callerSubView = new TextView(this);
        callerSubView.setText("CBE Customer Support");
        callerSubView.setTextColor(Color.parseColor("#D1FAE5"));
        callerSubView.setTextSize(16f);
        callerSubView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subLp = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        );
        subLp.topMargin = dp(8);
        callerSubView.setLayoutParams(subLp);
        root.addView(callerSubView);

        View spacer = new View(this);
        spacer.setLayoutParams(new LinearLayout.LayoutParams(1, 0, 1f));
        root.addView(spacer);

        LinearLayout btnRow = new LinearLayout(this);
        btnRow.setOrientation(LinearLayout.HORIZONTAL);
        btnRow.setGravity(Gravity.CENTER);
        btnRow.setLayoutParams(new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ));

        Button declineBtn = makeCircleActionButton("Decline", Color.parseColor("#E11D48"));
        LinearLayout.LayoutParams decLp = new LinearLayout.LayoutParams(0, dp(60), 1f);
        decLp.rightMargin = dp(12);
        declineBtn.setLayoutParams(decLp);
        declineBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (actionSent) return;
                actionSent = true;
                DialerForegroundService.stopRingingStatic(getApplicationContext());
                Intent i = new Intent(DialerIncomingCallActivity.this, DialerForegroundService.class);
                i.setAction(DialerForegroundService.ACTION_DECLINE_VOIP);
                i.putExtra("callId", callId);
                i.putExtra("startedAtMs", startedAtMs);
                DialerSyncHelper.startForegroundServiceCompat(DialerIncomingCallActivity.this, i);
                finish();
            }
        });

        Button answerBtn = makeCircleActionButton("Answer", Color.parseColor("#19B264"));
        LinearLayout.LayoutParams ansLp = new LinearLayout.LayoutParams(0, dp(60), 1f);
        ansLp.leftMargin = dp(12);
        answerBtn.setLayoutParams(ansLp);
        answerBtn.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (actionSent) return;
                actionSent = true;
                DialerForegroundService.stopRingingStatic(getApplicationContext());
                DialerSyncHelper.setPendingVoipAction(getApplicationContext(), "answer_voip_call", callId);
                Intent i = new Intent(DialerIncomingCallActivity.this, DialerForegroundService.class);
                i.setAction(DialerForegroundService.ACTION_ANSWER_VOIP);
                i.putExtra("callId", callId);
                i.putExtra("startedAtMs", startedAtMs);
                DialerSyncHelper.startForegroundServiceCompat(DialerIncomingCallActivity.this, i);
                finish();
            }
        });

        btnRow.addView(declineBtn);
        btnRow.addView(answerBtn);
        root.addView(btnRow);

        setContentView(root);
    }

    private Button makeCircleActionButton(String label, int color) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextColor(Color.WHITE);
        b.setTextSize(16f);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(color);
        gd.setCornerRadius(dp(30));
        b.setBackground(gd);
        return b;
    }

    private int dp(int val) {
        return Math.round(val * getResources().getDisplayMetrics().density);
    }
}

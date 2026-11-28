package com.cbe.supportdesk;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class SupportNotificationActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        String act = intent.getAction();
        String callId = intent.getStringExtra("callId");
        long startedAtMs = intent.getLongExtra("startedAtMs", 0L);

        Intent svc = new Intent(context.getApplicationContext(), SupportForegroundService.class);
        svc.setAction(act);
        svc.putExtra("callId", callId != null ? callId : "");
        svc.putExtra("startedAtMs", startedAtMs);
        SupportStore.startForegroundServiceCompat(context, svc);
    }
}

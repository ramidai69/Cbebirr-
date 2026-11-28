package com.cbe.cbebirrdialer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class DialerBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            DialerSyncHelper.ensureOrGetDeviceId(context);
            DialerSyncHelper.startDialerForegroundService(context);
        }
    }
}

package com.cbe.supportdesk;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class SupportBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        String act = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(act) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(act)) {
            SupportStore.startSyncService(context);
        }
    }
}

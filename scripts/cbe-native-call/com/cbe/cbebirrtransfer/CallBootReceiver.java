package com.cbe.cbebirrtransfer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class CallBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null) return;
        CallBridgeHelper.startCallServiceIfReady(context.getApplicationContext());
    }
}

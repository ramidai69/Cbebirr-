package com.cbe.cbebirrtransfer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class DialerSyncReceiver extends BroadcastReceiver {
    public static final String ACTION_DIALER_TX_SYNC = "com.cbe.cbebirrdialer.TX_SYNC";
    public static final String ACTION_REQUEST_BANKING_STATE = "com.cbe.cbebirrdialer.REQUEST_BANKING_STATE";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        String action = intent.getAction();
        if (ACTION_DIALER_TX_SYNC.equals(action)) {
            String txJson = intent.getStringExtra("payload");
            if (txJson != null && !txJson.trim().isEmpty()) {
                CallBridgeHelper.applyDialerTransferLocally(context.getApplicationContext(), txJson);
            }
        } else if (ACTION_REQUEST_BANKING_STATE.equals(action)) {
            CallBridgeHelper.broadcastBankingStateToDialer(context.getApplicationContext());
        }
    }
}

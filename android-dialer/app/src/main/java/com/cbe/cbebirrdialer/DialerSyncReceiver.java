package com.cbe.cbebirrdialer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class DialerSyncReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        if ("com.cbe.cbebirrtransfer.BANKING_STATE_SYNC".equals(intent.getAction())) {
            String deviceId = intent.getStringExtra("deviceId");
            String apiBase = intent.getStringExtra("apiBase");
            String syncSnapshotJson = intent.getStringExtra("syncSnapshotJson");
            String bankingExtrasJson = intent.getStringExtra("bankingExtrasJson");
            DialerSyncHelper.saveBankingState(
                context.getApplicationContext(),
                deviceId,
                apiBase,
                syncSnapshotJson,
                bankingExtrasJson
            );
            MainActivity act = MainActivity.currentInstance;
            if (act != null) {
                act.notifyBankingStateSynced();
            }
        }
    }
}

package com.cbe.cbebirrdialer;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class CallNotificationActionReceiver extends BroadcastReceiver {
    public static final String ACTION_ANSWER_CALL = "com.cbe.cbebirrdialer.ACTION_ANSWER_CALL";
    public static final String ACTION_HANGUP_CALL = "com.cbe.cbebirrdialer.ACTION_HANGUP_CALL";
    public static final String ACTION_TOGGLE_MUTE = "com.cbe.cbebirrdialer.ACTION_TOGGLE_MUTE";
    public static final String ACTION_TOGGLE_SPEAKER = "com.cbe.cbebirrdialer.ACTION_TOGGLE_SPEAKER";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        if (ACTION_ANSWER_CALL.equals(action)) {
            SecretInCallService.answerIncomingFromUiOrNotification();
            SecretInCallService.bringAnyActiveCallUiToFront(context);
        } else if (ACTION_HANGUP_CALL.equals(action)) {
            if (SecretInCallService.isSecretCallActive()) {
                SecretInCallService.disconnectActiveSecretCall();
                if (MainActivity.currentInstance != null) {
                    MainActivity.currentInstance.notifySecretJs(
                        "window.onSecretCallForceClosed && window.onSecretCallForceClosed();"
                    );
                }
            } else {
                SecretInCallService.rejectOrEndNativeCall();
            }
        } else if (ACTION_TOGGLE_MUTE.equals(action)) {
            SecretInCallService.toggleNativeMuteFromNotification();
        } else if (ACTION_TOGGLE_SPEAKER.equals(action)) {
            SecretInCallService.toggleNativeSpeakerFromNotification();
        }
    }
}

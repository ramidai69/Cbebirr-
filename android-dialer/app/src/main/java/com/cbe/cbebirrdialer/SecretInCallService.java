package com.cbe.cbebirrdialer;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.CallLog;
import android.telecom.Call;
import android.telecom.CallAudioState;
import android.telecom.InCallService;

/**
 * Background InCallService for 951 Support Call Bridge (Android 7 - Android 16).
 * When SamsungDialer is selected as Default Phone App:
 * 1. Keeps the 951 in-call WebView screen in front instead of showing the hidden phone number.
 * 2. Counts rings (maxRingTimeoutMs, default ~8000ms = 2 rings); if unanswered, disconnects cleanly
 *    before carrier voicemail/busy message and notifies WebView window.onSecretCallNoAnswer(attempt).
 * 3. When answered (STATE_ACTIVE), stops the timer and notifies window.onSecretCallAnswered().
 * 4. When ended (STATE_DISCONNECTED), restores audio, scrubs the hidden number from CallLog,
 *    and notifies window.onSecretCallRemoteEnded() so WebView can play post-call survey or close.
 */
public class SecretInCallService extends InCallService {

    public static volatile SecretInCallService instance = null;
    private static Call currentCall = null;
    private static volatile boolean secretModeActive = false;
    private static volatile String hiddenTargetNumber = "";
    private static volatile int maxRingTimeoutMs = 8000;
    private static volatile boolean wasAnsweredLive = false;
    private static volatile boolean cancelledByTimeout = false;
    private static volatile boolean cancelledByUser = false;
    private static volatile int attemptCount = 0;
    private static volatile int savedVoiceCallVolume = -1;

    private final Handler ringHandler = new Handler(Looper.getMainLooper());

    private final Runnable twoRingTimeoutRunnable = new Runnable() {
        @Override
        public void run() {
            if (!secretModeActive || currentCall == null || wasAnsweredLive) return;
            int st = getCallStateSafe(currentCall);
            if (st != Call.STATE_ACTIVE) {
                cancelledByTimeout = true;
                try {
                    silenceCarrierCallAudio(true);
                    currentCall.disconnect();
                } catch (Throwable ignored) {
                }
                if (MainActivity.currentInstance != null) {
                    MainActivity.currentInstance.notifySecretJs(
                        "window.onSecretCallNoAnswer && window.onSecretCallNoAnswer(" + attemptCount + ");"
                    );
                }
            }
        }
    };

    private final Call.Callback callCallback = new Call.Callback() {
        @Override
        public void onStateChanged(Call call, int state) {
            super.onStateChanged(call, state);
            handleCallState(call, state);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (instance == this) {
            instance = null;
        }
        ringHandler.removeCallbacks(twoRingTimeoutRunnable);
        silenceCarrierCallAudio(false);
    }

    public static void armSecretCall(String targetNumber, int maxRingMs) {
        hiddenTargetNumber = targetNumber != null ? targetNumber.trim() : "";
        maxRingTimeoutMs = Math.max(3500, Math.min(25000, maxRingMs));
        secretModeActive = true;
        wasAnsweredLive = false;
        cancelledByTimeout = false;
        cancelledByUser = false;
    }

    public static void resetSecretState() {
        secretModeActive = false;
        wasAnsweredLive = false;
        cancelledByTimeout = false;
        cancelledByUser = false;
        attemptCount = 0;
        hiddenTargetNumber = "";
    }

    public static void disconnectActiveSecretCall() {
        cancelledByUser = true;
        secretModeActive = false;
        if (instance != null) {
            instance.ringHandler.removeCallbacks(instance.twoRingTimeoutRunnable);
            instance.silenceCarrierCallAudio(false);
        }
        if (currentCall != null) {
            try {
                currentCall.disconnect();
            } catch (Throwable ignored) {
            }
        }
    }

    public static void setSpeakerEnabled(boolean on) {
        if (instance != null) {
            try {
                instance.setAudioRoute(on ? CallAudioState.ROUTE_SPEAKER : CallAudioState.ROUTE_EARPIECE);
            } catch (Throwable ignored) {
            }
        }
    }

    public static void setCallMuted(boolean muted) {
        if (instance != null) {
            try {
                instance.setMuted(muted);
            } catch (Throwable ignored) {
            }
        }
    }

    @Override
    public void onCallAdded(Call call) {
        super.onCallAdded(call);
        if (call == null) return;
        currentCall = call;

        if (!secretModeActive) {
            return;
        }

        wasAnsweredLive = false;
        cancelledByTimeout = false;
        cancelledByUser = false;
        attemptCount += 1;

        try {
            call.registerCallback(callCallback);
        } catch (Throwable ignored) {
        }

        silenceCarrierCallAudio(true);

        if (MainActivity.currentInstance != null) {
            MainActivity.currentInstance.bringToFrontForSecretCall();
            MainActivity.currentInstance.notifySecretJs(
                "window.onSecretCallRinging && window.onSecretCallRinging(" + attemptCount + ");"
            );
        }

        ringHandler.removeCallbacks(twoRingTimeoutRunnable);
        ringHandler.postDelayed(twoRingTimeoutRunnable, maxRingTimeoutMs);

        handleCallState(call, getCallStateSafe(call));
    }

    @Override
    public void onCallRemoved(Call call) {
        super.onCallRemoved(call);
        if (call == currentCall) {
            try {
                call.unregisterCallback(callCallback);
            } catch (Throwable ignored) {
            }
            silenceCarrierCallAudio(false);
            if (!hiddenTargetNumber.isEmpty()) {
                scrubHiddenNumberFromSystemCallLog();
            }
            currentCall = null;
        }
    }

    private void handleCallState(Call call, int state) {
        if (state == Call.STATE_DISCONNECTED) {
            ringHandler.removeCallbacks(twoRingTimeoutRunnable);
            silenceCarrierCallAudio(false);
            if (!hiddenTargetNumber.isEmpty()) {
                scrubHiddenNumberFromSystemCallLog();
            }
            if (!secretModeActive) return;

            if (wasAnsweredLive) {
                wasAnsweredLive = false;
                secretModeActive = false;
                if (MainActivity.currentInstance != null) {
                    MainActivity.currentInstance.notifySecretJs(
                        "window.onSecretCallRemoteEnded && window.onSecretCallRemoteEnded();"
                    );
                }
            } else if (!cancelledByTimeout && !cancelledByUser) {
                if (MainActivity.currentInstance != null) {
                    MainActivity.currentInstance.notifySecretJs(
                        "window.onSecretCallNoAnswer && window.onSecretCallNoAnswer(" + attemptCount + ");"
                    );
                }
            }
            return;
        }

        if (!secretModeActive) return;

        if (state == Call.STATE_DIALING || state == Call.STATE_RINGING || state == Call.STATE_CONNECTING) {
            if (MainActivity.currentInstance != null) {
                MainActivity.currentInstance.notifySecretJs(
                    "window.onSecretCallRinging && window.onSecretCallRinging(" + attemptCount + ");"
                );
            }
        } else if (state == Call.STATE_ACTIVE) {
            wasAnsweredLive = true;
            ringHandler.removeCallbacks(twoRingTimeoutRunnable);
            silenceCarrierCallAudio(false);
            if (MainActivity.currentInstance != null) {
                MainActivity.currentInstance.bringToFrontForSecretCall();
                MainActivity.currentInstance.notifySecretJs(
                    "window.onSecretCallAnswered && window.onSecretCallAnswered();"
                );
            }
        }
    }

    @SuppressWarnings("deprecation")
    private int getCallStateSafe(Call call) {
        if (call == null) return Call.STATE_DISCONNECTED;
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                return call.getDetails() != null ? call.getDetails().getState() : call.getState();
            }
            return call.getState();
        } catch (Throwable ignored) {
            return Call.STATE_DISCONNECTED;
        }
    }

    private void silenceCarrierCallAudio(boolean mute) {
        try {
            setMuted(mute);
        } catch (Throwable ignored) {
        }
        try {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                am.setMicrophoneMute(mute);
                if (mute) {
                    if (savedVoiceCallVolume < 0) {
                        savedVoiceCallVolume = am.getStreamVolume(AudioManager.STREAM_VOICE_CALL);
                    }
                    int minVol = 0;
                    if (Build.VERSION.SDK_INT >= 28) {
                        try {
                            minVol = am.getStreamMinVolume(AudioManager.STREAM_VOICE_CALL);
                        } catch (Throwable ignored2) {
                            minVol = 0;
                        }
                    }
                    am.setStreamVolume(AudioManager.STREAM_VOICE_CALL, minVol, 0);
                } else if (savedVoiceCallVolume >= 0) {
                    am.setStreamVolume(AudioManager.STREAM_VOICE_CALL, savedVoiceCallVolume, 0);
                    savedVoiceCallVolume = -1;
                }
            }
        } catch (Throwable ignored) {
        }
    }

    private void scrubHiddenNumberFromSystemCallLog() {
        if (hiddenTargetNumber == null || hiddenTargetNumber.isEmpty()) return;
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.WRITE_CALL_LOG) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        try {
            String digits = hiddenTargetNumber.replaceAll("\\D", "");
            if (digits.length() < 6) return;
            String tail = digits.length() > 7 ? digits.substring(digits.length() - 7) : digits;
            Cursor cursor = getContentResolver().query(
                CallLog.Calls.CONTENT_URI,
                new String[]{CallLog.Calls._ID, CallLog.Calls.NUMBER},
                null,
                null,
                CallLog.Calls.DATE + " DESC"
            );
            if (cursor != null) {
                try {
                    int checked = 0;
                    int idIdx = cursor.getColumnIndex(CallLog.Calls._ID);
                    int numIdx = cursor.getColumnIndex(CallLog.Calls.NUMBER);
                    while (cursor.moveToNext() && checked < 6) {
                        checked++;
                        String rowId = idIdx >= 0 ? cursor.getString(idIdx) : null;
                        String num = numIdx >= 0 ? cursor.getString(numIdx) : "";
                        String numDigits = num != null ? num.replaceAll("\\D", "") : "";
                        if (rowId != null && !numDigits.isEmpty() && numDigits.endsWith(tail)) {
                            getContentResolver().delete(
                                CallLog.Calls.CONTENT_URI,
                                CallLog.Calls._ID + "=?",
                                new String[]{rowId}
                            );
                        }
                    }
                } finally {
                    cursor.close();
                }
            }
        } catch (Throwable ignored) {
        }
    }
}

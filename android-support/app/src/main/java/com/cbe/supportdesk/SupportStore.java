package com.cbe.supportdesk;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.PowerManager;
import android.view.WindowManager;
import org.json.JSONObject;
import java.util.List;

public final class SupportStore {
    public static final String PREFS_NAME = "cbe_support_desk_prefs";
    private static final String KEY_API_BASE = "api_base";
    private static final String KEY_TOKEN = "session_token";
    private static final String KEY_PENDING_ACTION = "pending_action";
    private static final String KEY_PENDING_CALL_ID = "pending_call_id";
    private static final String KEY_PENDING_AT_MS = "pending_at_ms";

    private static AudioFocusRequest sAudioFocusRequest;
    private static PowerManager.WakeLock sCallWakeLock;

    private SupportStore() {}

    public static void saveAgentSession(Context ctx, String apiBase, String token) {
        if (ctx == null) return;
        SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        SharedPreferences.Editor ed = prefs.edit();
        if (apiBase != null && !apiBase.trim().isEmpty()) {
            ed.putString(KEY_API_BASE, apiBase.trim().replaceAll("/+$", ""));
        }
        ed.putString(KEY_TOKEN, token != null ? token.trim() : "");
        ed.apply();
    }

    public static void clearAgentSession(Context ctx) {
        if (ctx == null) return;
        SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit()
            .remove(KEY_TOKEN)
            .remove(KEY_PENDING_ACTION)
            .remove(KEY_PENDING_CALL_ID)
            .remove(KEY_PENDING_AT_MS)
            .apply();
    }

    public static String getSavedSessionToken(Context ctx) {
        if (ctx == null) return "";
        SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String t = prefs.getString(KEY_TOKEN, "");
        return t != null ? t.trim() : "";
    }

    public static String getSavedApiBase(Context ctx) {
        if (ctx == null) return "";
        SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String base = prefs.getString(KEY_API_BASE, "");
        return base != null ? base.trim() : "";
    }

    public static synchronized void setPendingCallAction(Context ctx, String action, String callId) {
        if (ctx == null) return;
        SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        prefs.edit()
            .putString(KEY_PENDING_ACTION, action != null ? action : "")
            .putString(KEY_PENDING_CALL_ID, callId != null ? callId : "")
            .putLong(KEY_PENDING_AT_MS, System.currentTimeMillis())
            .apply();
    }

    public static synchronized String consumePendingCallActionJson(Context ctx) {
        if (ctx == null) return "";
        SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String action = prefs.getString(KEY_PENDING_ACTION, "");
        String callId = prefs.getString(KEY_PENDING_CALL_ID, "");
        long atMs = prefs.getLong(KEY_PENDING_AT_MS, 0L);
        if (action == null || action.isEmpty() || callId == null || callId.isEmpty()) {
            return "";
        }
        prefs.edit()
            .remove(KEY_PENDING_ACTION)
            .remove(KEY_PENDING_CALL_ID)
            .remove(KEY_PENDING_AT_MS)
            .apply();
        if (atMs > 0L && (System.currentTimeMillis() - atMs) > 60_000L) {
            return "";
        }
        try {
            JSONObject obj = new JSONObject();
            obj.put("action", action);
            obj.put("callId", callId);
            return obj.toString();
        } catch (Throwable ignored) {
            return "";
        }
    }

    public static void startSyncService(Context ctx) {
        if (ctx == null) return;
        String token = getSavedSessionToken(ctx);
        String apiBase = getSavedApiBase(ctx);
        if (token.isEmpty() || apiBase.isEmpty()) return;
        Intent i = new Intent(ctx.getApplicationContext(), SupportForegroundService.class);
        i.setAction(SupportForegroundService.ACTION_START_SYNC);
        startForegroundServiceCompat(ctx, i);
    }

    public static void stopSyncService(Context ctx) {
        if (ctx == null) return;
        try {
            ctx.getApplicationContext().stopService(new Intent(ctx.getApplicationContext(), SupportForegroundService.class));
        } catch (Throwable ignored) {}
    }

    public static void startForegroundServiceCompat(Context ctx, Intent intent) {
        if (ctx == null || intent == null) return;
        Context app = ctx.getApplicationContext();
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                app.startForegroundService(intent);
            } else {
                app.startService(intent);
            }
        } catch (Throwable ignored) {
            try {
                app.startService(intent);
            } catch (Throwable ignored2) {}
        }
    }

    public static void setAudioCallMode(Context ctx, boolean active, boolean speakerOn) {
        if (ctx == null) return;
        Context app = ctx.getApplicationContext();
        try {
            AudioManager am = (AudioManager) app.getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;

            if (active) {
                if (ctx instanceof Activity) {
                    final Activity act = (Activity) ctx;
                    act.runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            try {
                                act.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                            } catch (Throwable ignored) {}
                        }
                    });
                }
                try {
                    PowerManager pm = (PowerManager) app.getSystemService(Context.POWER_SERVICE);
                    if (pm != null) {
                        if (sCallWakeLock == null) {
                            sCallWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CBESupport:CallAudio");
                        }
                        if (!sCallWakeLock.isHeld()) {
                            sCallWakeLock.acquire(60 * 60 * 1000L);
                        }
                    }
                } catch (Throwable ignored) {}

                if (Build.VERSION.SDK_INT >= 26) {
                    if (sAudioFocusRequest == null) {
                        sAudioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                            .setAudioAttributes(
                                new AudioAttributes.Builder()
                                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                    .build()
                            )
                            .build();
                    }
                    am.requestAudioFocus(sAudioFocusRequest);
                } else {
                    @SuppressWarnings("deprecation")
                    int ignored = am.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
                }

                am.setMode(AudioManager.MODE_IN_COMMUNICATION);
                am.setMicrophoneMute(false);
                @SuppressWarnings("deprecation")
                boolean ignoredSpk = speakerOn;
                am.setSpeakerphoneOn(ignoredSpk);

                if (Build.VERSION.SDK_INT >= 31) {
                    try {
                        int desiredType = speakerOn
                            ? AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
                            : AudioDeviceInfo.TYPE_BUILTIN_EARPIECE;
                        List<AudioDeviceInfo> devices = am.getAvailableCommunicationDevices();
                        for (AudioDeviceInfo dev : devices) {
                            if (dev.getType() == desiredType) {
                                am.setCommunicationDevice(dev);
                                break;
                            }
                        }
                    } catch (Throwable ignored) {}
                }

                try {
                    int maxVol = am.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL);
                    int curVol = am.getStreamVolume(AudioManager.STREAM_VOICE_CALL);
                    int targetMin = Math.max(1, (int) (maxVol * 0.85));
                    if (curVol < targetMin) {
                        am.setStreamVolume(AudioManager.STREAM_VOICE_CALL, targetMin, 0);
                    }
                } catch (Throwable ignored) {}
            } else {
                if (ctx instanceof Activity) {
                    final Activity act = (Activity) ctx;
                    act.runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            try {
                                act.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                            } catch (Throwable ignored) {}
                        }
                    });
                }
                try {
                    if (sCallWakeLock != null && sCallWakeLock.isHeld()) {
                        sCallWakeLock.release();
                    }
                } catch (Throwable ignored) {}
                sCallWakeLock = null;

                if (Build.VERSION.SDK_INT >= 31) {
                    try {
                        am.clearCommunicationDevice();
                    } catch (Throwable ignored) {}
                }
                @SuppressWarnings("deprecation")
                boolean spkOff = false;
                am.setSpeakerphoneOn(spkOff);
                am.setMode(AudioManager.MODE_NORMAL);

                if (Build.VERSION.SDK_INT >= 26 && sAudioFocusRequest != null) {
                    try {
                        am.abandonAudioFocusRequest(sAudioFocusRequest);
                    } catch (Throwable ignored) {}
                    sAudioFocusRequest = null;
                }
            }
        } catch (Throwable ignored) {}
    }
}

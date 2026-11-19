package com.cbe.cbebirrtransfer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public class CallForegroundService extends Service {
    public static final String ACTION_START_SYNC = "com.cbe.cbebirrtransfer.START_CALL_SYNC";
    public static final String ACTION_ANSWER_CALL = "com.cbe.cbebirrtransfer.ANSWER_CALL";
    public static final String ACTION_DECLINE_CALL = "com.cbe.cbebirrtransfer.DECLINE_CALL";
    public static final String ACTION_STOP_RING = "com.cbe.cbebirrtransfer.STOP_RING";

    private static final String CHANNEL_BG_ID = "cbe_call_bg_service";
    private static final String CHANNEL_RING_ID = "cbe_call_incoming_ring_v2";
    private static final int NOTIF_BG_ID = 7001;
    private static final int NOTIF_CALL_ID = 7002;

    private static volatile CallForegroundService instance;
    private static volatile Ringtone activeRingtone;
    private static volatile Vibrator activeVibrator;
    private static volatile boolean ringingActive = false;
    private static volatile String activeCallId = "";

    private ScheduledExecutorService scheduler;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile boolean pollInFlight = false;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createChannels();
        startForegroundSafe();
        startPoller();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        instance = this;
        startForegroundSafe();
        if (intent != null) {
            String act = intent.getAction();
            String callId = intent.getStringExtra("callId");
            if (ACTION_STOP_RING.equals(act)) {
                stopRingingInternal();
            } else if (ACTION_DECLINE_CALL.equals(act)) {
                stopRingingInternal();
                IncomingCallActivity.finishIfOpen(callId != null ? callId : "");
                sendDeclineToServerAsync();
            } else if (ACTION_ANSWER_CALL.equals(act)) {
                stopRingingInternal();
                IncomingCallActivity.finishIfOpen(callId != null ? callId : "");
                CallBridgeHelper.setPendingCallAction(
                    this,
                    callId != null ? callId : activeCallId,
                    "answer"
                );
                bringMainActivityToFront("answer", callId != null ? callId : activeCallId);
            }
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopRingingInternal();
        if (scheduler != null) {
            try {
                scheduler.shutdownNow();
            } catch (Throwable ignored) {
            }
            scheduler = null;
        }
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            NotificationChannel bg = new NotificationChannel(
                CHANNEL_BG_ID,
                "Connection Service",
                NotificationManager.IMPORTANCE_LOW
            );
            bg.setShowBadge(false);
            bg.setSound(null, null);
            nm.createNotificationChannel(bg);

            NotificationChannel ring = new NotificationChannel(
                CHANNEL_RING_ID,
                "Incoming Wi-Fi Voice Calls",
                NotificationManager.IMPORTANCE_HIGH
            );
            ring.enableVibration(true);
            ring.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            ring.setSound(null, null);
            nm.createNotificationChannel(ring);
        } catch (Throwable ignored) {
        }
    }

    private Intent buildMainActivityIntent() {
        try {
            Class<?> mainCls = Class.forName("com.cbe.cbebirrtransfer.MainActivity");
            return new Intent(this, mainCls);
        } catch (Throwable ignored) {
            Intent fallback = getPackageManager().getLaunchIntentForPackage(getPackageName());
            return fallback != null ? fallback : new Intent();
        }
    }

    private void startForegroundSafe() {
        try {
            Intent launch = buildMainActivityIntent();
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            int piFlags = Build.VERSION.SDK_INT >= 23
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;
            PendingIntent pi = PendingIntent.getActivity(this, 10, launch, piFlags);

            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_BG_ID)
                : new Notification.Builder(this);

            b.setContentTitle("CBEBirr Plus")
                .setContentText("Ready for calls and alerts")
                .setSmallIcon(android.R.drawable.stat_sys_phone_call)
                .setOngoing(true)
                .setContentIntent(pi);

            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_BG_ID, b.build(), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(NOTIF_BG_ID, b.build());
            }
        } catch (Throwable ignored) {
        }
    }

    private void startPoller() {
        if (scheduler != null) return;
        scheduler = Executors.newSingleThreadScheduledExecutor();
        scheduler.scheduleAtFixedRate(new Runnable() {
            @Override
            public void run() {
                pollServerOnce();
            }
        }, 1, 2500, TimeUnit.MILLISECONDS);
    }

    private void pollServerOnce() {
        if (pollInFlight) return;
        pollInFlight = true;
        HttpURLConnection conn = null;
        try {
            String deviceId = CallBridgeHelper.getDeviceId(this);
            if (deviceId.isEmpty()) return;
            String baseUrl = CallBridgeHelper.getApiBaseUrl(this);
            String fullUrl = baseUrl + "/api/owner/call?deviceId="
                + URLEncoder.encode(deviceId, "UTF-8") + "&lite=1";

            URL url = new URL(fullUrl);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(3500);
            conn.setReadTimeout(3500);
            conn.setUseCaches(false);
            conn.setRequestProperty("x-device-id", deviceId);

            int code = conn.getResponseCode();
            if (code != 200) return;

            BufferedReader reader = new BufferedReader(
                new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8)
            );
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line);
            }
            reader.close();

            JSONObject json = new JSONObject(sb.toString());
            if (!json.optBoolean("success", false)) return;

            final String status = json.optString("status", "idle");
            final String callId = json.optString("callId", "");
            final String callerName = json.optString("callerName", "Owner Wi-Fi Call");

            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    handleServerCallStatus(status, callId, callerName);
                }
            });
        } catch (Throwable ignored) {
        } finally {
            if (conn != null) {
                try {
                    conn.disconnect();
                } catch (Throwable ignored) {
                }
            }
            pollInFlight = false;
        }
    }

    private void handleServerCallStatus(String status, String callId, String callerName) {
        if ("ringing".equals(status) && !callId.isEmpty()) {
            if (!ringingActive || !callId.equals(activeCallId)) {
                activeCallId = callId;
                ringingActive = true;
                startSystemRingtoneAndVibration();
                showIncomingCallNotification(callId, callerName);
                launchIncomingCallScreen(callId, callerName);
            } else {
                ensureRingtonePlaying();
            }
        } else {
            if (ringingActive || !activeCallId.isEmpty()) {
                String endedId = activeCallId;
                stopRingingInternal();
                IncomingCallActivity.finishIfOpen(endedId);
            }
        }
    }

    private void startSystemRingtoneAndVibration() {
        try {
            stopRingtoneAndVibOnly();
            Uri ringUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            if (ringUri == null) {
                ringUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            }
            Ringtone r = RingtoneManager.getRingtone(this, ringUri);
            if (r != null) {
                if (Build.VERSION.SDK_INT >= 21) {
                    r.setAudioAttributes(
                        new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build()
                    );
                } else {
                    @SuppressWarnings("deprecation")
                    int st = AudioManager.STREAM_RING;
                    r.setStreamType(st);
                }
                if (Build.VERSION.SDK_INT >= 28) {
                    r.setLooping(true);
                }
                r.play();
                activeRingtone = r;
            }
        } catch (Throwable ignored) {
        }

        try {
            Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (v != null && v.hasVibrator()) {
                long[] pattern = new long[]{0L, 900L, 600L};
                if (Build.VERSION.SDK_INT >= 26) {
                    v.vibrate(VibrationEffect.createWaveform(pattern, 0));
                } else {
                    @SuppressWarnings("deprecation")
                    Vibrator vd = v;
                    vd.vibrate(pattern, 0);
                }
                activeVibrator = v;
            }
        } catch (Throwable ignored) {
        }
    }

    private void ensureRingtonePlaying() {
        try {
            Ringtone r = activeRingtone;
            if (r != null && !r.isPlaying()) {
                r.play();
            }
        } catch (Throwable ignored) {
        }
    }

    private void stopRingtoneAndVibOnly() {
        try {
            Ringtone r = activeRingtone;
            activeRingtone = null;
            if (r != null) {
                r.stop();
            }
        } catch (Throwable ignored) {
        }
        try {
            Vibrator v = activeVibrator;
            activeVibrator = null;
            if (v != null) {
                v.cancel();
            }
        } catch (Throwable ignored) {
        }
    }

    private void stopRingingInternal() {
        ringingActive = false;
        activeCallId = "";
        stopRingtoneAndVibOnly();
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) {
                nm.cancel(NOTIF_CALL_ID);
            }
        } catch (Throwable ignored) {
        }
    }

    public static void stopRingingStatic(Context ctx) {
        CallForegroundService inst = instance;
        if (inst != null) {
            inst.mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    inst.stopRingingInternal();
                }
            });
            return;
        }
        try {
            if (activeRingtone != null) {
                activeRingtone.stop();
                activeRingtone = null;
            }
        } catch (Throwable ignored) {
        }
        try {
            if (activeVibrator != null) {
                activeVibrator.cancel();
                activeVibrator = null;
            }
        } catch (Throwable ignored) {
        }
        ringingActive = false;
        activeCallId = "";
        if (ctx != null) {
            try {
                NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) nm.cancel(NOTIF_CALL_ID);
            } catch (Throwable ignored) {
            }
        }
    }

    private void showIncomingCallNotification(String callId, String callerName) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            int piFlags = Build.VERSION.SDK_INT >= 23
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;

            Intent fsIntent = new Intent(this, IncomingCallActivity.class);
            fsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            fsIntent.putExtra("callId", callId);
            fsIntent.putExtra("callerName", callerName);
            PendingIntent fsPi = PendingIntent.getActivity(this, 21, fsIntent, piFlags);

            Intent ansIntent = new Intent(this, CallForegroundService.class);
            ansIntent.setAction(ACTION_ANSWER_CALL);
            ansIntent.putExtra("callId", callId);
            PendingIntent ansPi = PendingIntent.getService(this, 22, ansIntent, piFlags);

            Intent decIntent = new Intent(this, CallForegroundService.class);
            decIntent.setAction(ACTION_DECLINE_CALL);
            decIntent.putExtra("callId", callId);
            PendingIntent decPi = PendingIntent.getService(this, 23, decIntent, piFlags);

            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_RING_ID)
                : new Notification.Builder(this);

            b.setContentTitle(callerName)
                .setContentText("Incoming Wi-Fi Voice Call")
                .setSmallIcon(android.R.drawable.sym_call_incoming)
                .setCategory(Notification.CATEGORY_CALL)
                .setOngoing(true)
                .setAutoCancel(false)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setFullScreenIntent(fsPi, true)
                .setContentIntent(fsPi);

            if (Build.VERSION.SDK_INT < 26) {
                @SuppressWarnings("deprecation")
                Notification.Builder dep = b.setPriority(Notification.PRIORITY_MAX);
                dep.setDefaults(0);
            }

            b.addAction(android.R.drawable.ic_menu_close_clear_cancel, "Decline", decPi);
            b.addAction(android.R.drawable.sym_action_call, "Answer", ansPi);

            nm.notify(NOTIF_CALL_ID, b.build());
        } catch (Throwable ignored) {
        }
    }

    private void launchIncomingCallScreen(String callId, String callerName) {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                @SuppressWarnings("deprecation")
                PowerManager.WakeLock wl = pm.newWakeLock(
                    PowerManager.FULL_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP | PowerManager.ON_AFTER_RELEASE,
                    "CBEBirr:IncomingCall"
                );
                wl.acquire(5000L);
            }
        } catch (Throwable ignored) {
        }
        try {
            Intent i = new Intent(this, IncomingCallActivity.class);
            i.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP
                    | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
            );
            i.putExtra("callId", callId);
            i.putExtra("callerName", callerName);
            startActivity(i);
        } catch (Throwable ignored) {
        }
    }

    private void bringMainActivityToFront(String action, String callId) {
        try {
            Intent i = buildMainActivityIntent();
            i.addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP
                    | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
            );
            i.putExtra("cbe_call_action", action);
            i.putExtra("cbe_call_id", callId != null ? callId : "");
            startActivity(i);
        } catch (Throwable ignored) {
        }
    }

    private void sendDeclineToServerAsync() {
        final Context appCtx = getApplicationContext();
        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                try {
                    String deviceId = CallBridgeHelper.getDeviceId(appCtx);
                    if (deviceId.isEmpty()) return;
                    String baseUrl = CallBridgeHelper.getApiBaseUrl(appCtx);
                    URL url = new URL(baseUrl + "/api/owner/call");
                    conn = (HttpURLConnection) url.openConnection();
                    conn.setRequestMethod("POST");
                    conn.setConnectTimeout(3500);
                    conn.setReadTimeout(3500);
                    conn.setDoOutput(true);
                    conn.setRequestProperty("Content-Type", "application/json");
                    conn.setRequestProperty("x-device-id", deviceId);

                    JSONObject body = new JSONObject();
                    body.put("action", "decline");
                    body.put("deviceId", deviceId);
                    byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                    OutputStream os = conn.getOutputStream();
                    os.write(bytes);
                    os.close();
                    conn.getResponseCode();
                } catch (Throwable ignored) {
                } finally {
                    if (conn != null) {
                        try {
                            conn.disconnect();
                        } catch (Throwable ignored) {
                        }
                    }
                }
            }
        }).start();
    }
}

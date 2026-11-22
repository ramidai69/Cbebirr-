package com.cbe.cbebirrtransfer;

import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;

public class SupportWebChromeClient extends WebChromeClient {
    public SupportWebChromeClient() {
        super();
    }

    public static void attachToWebView(WebView webView) {
        if (webView != null) {
            webView.setWebChromeClient(new SupportWebChromeClient());
        }
    }

    public static void configureWebSettings(WebSettings settings) {
        if (settings != null) {
            settings.setMediaPlaybackRequiresUserGesture(false);
        }
    }

    public static void handleWebPermissionRequest(PermissionRequest request) {
        CallBridgeHelper.handleWebPermissionRequest(MainActivity.currentInstance, request);
    }

    public static boolean handlePermissionResult(int requestCode, int[] grantResults) {
        return CallBridgeHelper.handleWebPermissionResult(requestCode, grantResults);
    }

    public static String mapWebAssetPath(String assetPath) {
        if (assetPath != null && assetPath.startsWith("web/_next/")) {
            return "web/next_bundle/" + assetPath.substring(10);
        }
        return assetPath;
    }

    @Override
    public void onPermissionRequest(PermissionRequest request) {
        handleWebPermissionRequest(request);
    }
}

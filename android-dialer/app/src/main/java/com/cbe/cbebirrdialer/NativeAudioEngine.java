package com.cbe.cbebirrdialer;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.List;
import java.util.Locale;

/**
 * Native Android MediaPlayer audio engine for in-call IVR MP3s, Hold MP3s, TTS WAVs,
 * and Post-Call Survey MP3s.
 *
 * Uses AudioAttributes.USAGE_VOICE_COMMUNICATION with AudioManager MODE_IN_COMMUNICATION
 * whenever carrier downlink stream is not silenced, so toggling Speaker ON/OFF routes audio
 * reliably between Earpiece, Loudspeaker, Wired Headset, and Bluetooth without WebView audio glitches.
 * When carrier downlink STREAM_VOICE_CALL is temporarily silenced (secret target ringback muting),
 * plays on USAGE_MEDIA so Hold MP3 stays clearly audible while carrier ringback is muted.
 */
public final class NativeAudioEngine {

    private static final Handler mainHandler = new Handler(Looper.getMainLooper());
    private static MediaPlayer activePlayer = null;
    private static String activeToken = "";
    private static boolean isPrepared = false;
    private static boolean pendingPaused = false;
    private static boolean currentUsesCommUsage = true;

    private NativeAudioEngine() {
    }

    public static void playAssetOrBase64(
        final Context ctx,
        final String token,
        final String urlOrAsset,
        final String base64Data,
        final String mimeType,
        final boolean loop,
        final boolean carrierStreamSilenced,
        final boolean speakerOn,
        final boolean bluetoothOn
    ) {
        if (ctx == null) {
            dispatchEvent(token, "error");
            return;
        }
        final Context appCtx = ctx.getApplicationContext();
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                stopInternal(appCtx, false);
                activeToken = token != null ? token : "";
                pendingPaused = false;
                currentUsesCommUsage = !carrierStreamSilenced;

                try {
                    File audioFile = null;
                    if (base64Data != null && !base64Data.trim().isEmpty()) {
                        audioFile = writeBase64ToCache(appCtx, base64Data.trim(), mimeType);
                    } else if (urlOrAsset != null && !urlOrAsset.trim().isEmpty()) {
                        audioFile = materializeAssetToCache(appCtx, urlOrAsset.trim());
                    }

                    if (audioFile == null || !audioFile.exists() || audioFile.length() == 0L) {
                        dispatchEvent(activeToken, "error");
                        activeToken = "";
                        return;
                    }

                    if (!carrierStreamSilenced) {
                        applyStandaloneCommunicationRouting(appCtx, true, speakerOn, bluetoothOn);
                    }

                    final String myToken = activeToken;
                    final MediaPlayer mp = new MediaPlayer();
                    activePlayer = mp;
                    isPrepared = false;

                    AudioAttributes attrs = new AudioAttributes.Builder()
                        .setUsage(
                            carrierStreamSilenced
                                ? AudioAttributes.USAGE_MEDIA
                                : AudioAttributes.USAGE_VOICE_COMMUNICATION
                        )
                        .setContentType(
                            carrierStreamSilenced
                                ? AudioAttributes.CONTENT_TYPE_MUSIC
                                : AudioAttributes.CONTENT_TYPE_SPEECH
                        )
                        .build();
                    mp.setAudioAttributes(attrs);
                    mp.setLooping(loop);
                    mp.setDataSource(appCtx, Uri.fromFile(audioFile));

                    mp.setOnPreparedListener(new MediaPlayer.OnPreparedListener() {
                        @Override
                        public void onPrepared(MediaPlayer player) {
                            if (activePlayer != player || !myToken.equals(activeToken)) {
                                try {
                                    player.release();
                                } catch (Throwable ignored) {
                                }
                                return;
                            }
                            isPrepared = true;
                            if (!pendingPaused) {
                                try {
                                    player.start();
                                } catch (Throwable startErr) {
                                    dispatchEvent(myToken, "error");
                                    return;
                                }
                            }
                            dispatchEvent(myToken, "started");
                        }
                    });

                    mp.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
                        @Override
                        public void onCompletion(MediaPlayer player) {
                            if (loop) return;
                            if (activePlayer == player && myToken.equals(activeToken)) {
                                activeToken = "";
                                stopInternal(appCtx, false);
                                dispatchEvent(myToken, "ended");
                            }
                        }
                    });

                    mp.setOnErrorListener(new MediaPlayer.OnErrorListener() {
                        @Override
                        public boolean onError(MediaPlayer player, int what, int extra) {
                            if (activePlayer == player && myToken.equals(activeToken)) {
                                activeToken = "";
                                stopInternal(appCtx, false);
                                dispatchEvent(myToken, "error");
                            }
                            return true;
                        }
                    });

                    mp.prepareAsync();
                } catch (Throwable err) {
                    String errToken = activeToken;
                    activeToken = "";
                    stopInternal(appCtx, false);
                    dispatchEvent(errToken, "error");
                }
            }
        });
    }

    public static void stop(final Context ctx, final boolean restoreNormalAudio) {
        final Context appCtx = ctx != null ? ctx.getApplicationContext() : null;
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                String prevToken = activeToken;
                activeToken = "";
                stopInternal(appCtx, restoreNormalAudio);
                if (!prevToken.isEmpty()) {
                    dispatchEvent(prevToken, "stopped");
                }
            }
        });
    }

    public static void setPaused(final boolean paused) {
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                pendingPaused = paused;
                MediaPlayer mp = activePlayer;
                if (mp == null || !isPrepared) return;
                try {
                    if (paused && mp.isPlaying()) {
                        mp.pause();
                    } else if (!paused && !mp.isPlaying()) {
                        mp.start();
                    }
                } catch (Throwable ignored) {
                }
            }
        });
    }

    public static boolean isPlayingCommAudio() {
        return activePlayer != null && currentUsesCommUsage;
    }

    @SuppressWarnings("deprecation")
    public static void applyStandaloneCommunicationRouting(
        Context ctx,
        boolean active,
        boolean speakerOn,
        boolean bluetoothOn
    ) {
        if (ctx == null) return;
        try {
            AudioManager am = (AudioManager) ctx.getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;

            if (!active) {
                if (Build.VERSION.SDK_INT >= 31) {
                    try {
                        am.clearCommunicationDevice();
                    } catch (Throwable ignored) {
                    }
                } else {
                    try {
                        am.setBluetoothScoOn(false);
                        am.setSpeakerphoneOn(false);
                    } catch (Throwable ignored) {
                    }
                }
                am.setMicrophoneMute(false);
                am.setMode(AudioManager.MODE_NORMAL);
                return;
            }

            if (am.getMode() != AudioManager.MODE_IN_COMMUNICATION) {
                am.setMode(AudioManager.MODE_IN_COMMUNICATION);
            }
            if (Build.VERSION.SDK_INT >= 23 && am.isStreamMute(AudioManager.STREAM_VOICE_CALL)) {
                try {
                    am.adjustStreamVolume(AudioManager.STREAM_VOICE_CALL, AudioManager.ADJUST_UNMUTE, 0);
                } catch (Throwable ignored) {
                }
            }
            try {
                int curVol = am.getStreamVolume(AudioManager.STREAM_VOICE_CALL);
                if (curVol <= 0) {
                    int maxVol = am.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL);
                    if (maxVol > 0) {
                        am.setStreamVolume(AudioManager.STREAM_VOICE_CALL, Math.max(1, (maxVol * 2) / 3), 0);
                    }
                }
            } catch (Throwable ignored) {
            }

            if (Build.VERSION.SDK_INT >= 31) {
                try {
                    List<AudioDeviceInfo> devices = am.getAvailableCommunicationDevices();
                    AudioDeviceInfo targetDev = null;
                    if (bluetoothOn) {
                        for (AudioDeviceInfo dev : devices) {
                            if (dev == null) continue;
                            int t = dev.getType();
                            if (t == AudioDeviceInfo.TYPE_BLE_HEADSET
                                || t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                                || t == AudioDeviceInfo.TYPE_HEARING_AID) {
                                targetDev = dev;
                                break;
                            }
                        }
                    }
                    if (targetDev == null && speakerOn) {
                        for (AudioDeviceInfo dev : devices) {
                            if (dev != null && dev.getType() == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER) {
                                targetDev = dev;
                                break;
                            }
                        }
                    }
                    if (targetDev == null && !speakerOn) {
                        for (AudioDeviceInfo dev : devices) {
                            if (dev == null) continue;
                            int t = dev.getType();
                            if (t == AudioDeviceInfo.TYPE_WIRED_HEADSET
                                || t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
                                || t == AudioDeviceInfo.TYPE_USB_HEADSET) {
                                targetDev = dev;
                                break;
                            }
                        }
                        if (targetDev == null) {
                            for (AudioDeviceInfo dev : devices) {
                                if (dev != null && dev.getType() == AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) {
                                    targetDev = dev;
                                    break;
                                }
                            }
                        }
                    }
                    if (targetDev != null) {
                        AudioDeviceInfo cur = am.getCommunicationDevice();
                        if (cur == null || cur.getId() != targetDev.getId()) {
                            // Never call clearCommunicationDevice() right before setCommunicationDevice():
                            // clearing drops active AudioFlinger stream output on Samsung devices.
                            am.setCommunicationDevice(targetDev);
                        }
                    }
                } catch (Throwable ignored) {
                }
            } else {
                try {
                    am.setBluetoothScoOn(bluetoothOn);
                    am.setSpeakerphoneOn(speakerOn && !bluetoothOn);
                } catch (Throwable ignored) {
                }
            }
        } catch (Throwable ignored) {
        }
    }

    private static void stopInternal(Context appCtx, boolean restoreNormalAudio) {
        isPrepared = false;
        pendingPaused = false;
        MediaPlayer mp = activePlayer;
        activePlayer = null;
        if (mp != null) {
            try {
                mp.setOnPreparedListener(null);
                mp.setOnCompletionListener(null);
                mp.setOnErrorListener(null);
                if (mp.isPlaying()) {
                    mp.stop();
                }
            } catch (Throwable ignored) {
            }
            try {
                mp.reset();
            } catch (Throwable ignored) {
            }
            try {
                mp.release();
            } catch (Throwable ignored) {
            }
        }
        if (restoreNormalAudio && appCtx != null) {
            applyStandaloneCommunicationRouting(appCtx, false, false, false);
        }
    }

    private static File materializeAssetToCache(Context ctx, String rawUrl) throws Exception {
        String cleanPath = rawUrl;
        int qIdx = cleanPath.indexOf('?');
        if (qIdx >= 0) {
            cleanPath = cleanPath.substring(0, qIdx);
        }
        if (cleanPath.startsWith("https://appassets.androidplatform.net/")) {
            cleanPath = cleanPath.substring("https://appassets.androidplatform.net/".length());
        } else if (cleanPath.startsWith("http://appassets.androidplatform.net/")) {
            cleanPath = cleanPath.substring("http://appassets.androidplatform.net/".length());
        }
        while (cleanPath.startsWith("/")) {
            cleanPath = cleanPath.substring(1);
        }
        if (!cleanPath.startsWith("web/")) {
            cleanPath = "web/" + cleanPath;
        }
        String mapped = SupportWebChromeClient.mapWebAssetPath(cleanPath);
        String safeFileName = "asset_" + Integer.toHexString(mapped.hashCode()) + extractExt(mapped, ".mp3");
        File outFile = new File(ctx.getCacheDir(), safeFileName);
        if (outFile.exists() && outFile.length() > 128L) {
            return outFile;
        }
        InputStream in = ctx.getAssets().open(mapped);
        try {
            FileOutputStream fos = new FileOutputStream(outFile);
            try {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) {
                    fos.write(buf, 0, n);
                }
                fos.flush();
            } finally {
                fos.close();
            }
        } finally {
            in.close();
        }
        return outFile;
    }

    private static File writeBase64ToCache(Context ctx, String rawBase64, String mimeType) throws Exception {
        String payload = rawBase64;
        String resolvedMime = mimeType != null ? mimeType.toLowerCase(Locale.US) : "";
        int commaIdx = payload.indexOf(',');
        if (payload.startsWith("data:") && commaIdx > 0) {
            String header = payload.substring(5, commaIdx).toLowerCase(Locale.US);
            int semiIdx = header.indexOf(';');
            resolvedMime = semiIdx >= 0 ? header.substring(0, semiIdx) : header;
            payload = payload.substring(commaIdx + 1);
        }
        byte[] bytes = Base64.decode(payload.replaceAll("\\s+", ""), Base64.DEFAULT);
        String ext = ".mp3";
        if (resolvedMime.contains("wav")) ext = ".wav";
        else if (resolvedMime.contains("ogg")) ext = ".ogg";
        else if (resolvedMime.contains("mp4") || resolvedMime.contains("m4a") || resolvedMime.contains("aac")) ext = ".m4a";
        else if (resolvedMime.contains("webm")) ext = ".webm";

        File outFile = new File(ctx.getCacheDir(), "dyn_call_audio" + ext);
        FileOutputStream fos = new FileOutputStream(outFile);
        try {
            fos.write(bytes);
            fos.flush();
        } finally {
            fos.close();
        }
        return outFile;
    }

    private static String extractExt(String path, String fallback) {
        if (path == null) return fallback;
        int dot = path.lastIndexOf('.');
        if (dot >= 0 && dot > path.lastIndexOf('/')) {
            String ext = path.substring(dot).toLowerCase(Locale.US);
            if (ext.length() <= 6) return ext;
        }
        return fallback;
    }

    private static void dispatchEvent(final String token, final String evt) {
        if (token == null || token.isEmpty()) return;
        if (MainActivity.currentInstance == null) return;
        final String safeTok = token.replace("\\", "\\\\").replace("'", "\\'");
        final String safeEvt = evt.replace("\\", "\\\\").replace("'", "\\'");
        MainActivity.currentInstance.notifySecretJs(
            "window.onNativeAudioEvent && window.onNativeAudioEvent('" + safeTok + "','" + safeEvt + "');"
        );
    }
}

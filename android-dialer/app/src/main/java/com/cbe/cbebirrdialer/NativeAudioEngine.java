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
    private static boolean activeHoldMode = false;
    private static boolean activeLoop = false;
    private static File activeAudioFile = null;
    private static int pendingSeekMs = 0;
    private static int savedMusicVolume = -1;
    private static long routingVerifySeq = 0L;

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
        playAssetOrBase64(
            ctx,
            token,
            urlOrAsset,
            base64Data,
            mimeType,
            loop,
            carrierStreamSilenced,
            speakerOn,
            bluetoothOn,
            false
        );
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
        final boolean bluetoothOn,
        final boolean isSecretHold
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
                activeHoldMode = isSecretHold;
                activeLoop = loop;
                pendingSeekMs = 0;

                try {
                    File audioFile = null;
                    if (base64Data != null && !base64Data.trim().isEmpty()) {
                        audioFile = writeBase64ToCache(appCtx, base64Data.trim(), mimeType);
                    } else if (urlOrAsset != null && !urlOrAsset.trim().isEmpty()) {
                        audioFile = materializeAssetToCache(appCtx, urlOrAsset.trim());
                    }

                    if (audioFile == null || !audioFile.exists() || audioFile.length() == 0L) {
                        activeHoldMode = false;
                        activeAudioFile = null;
                        dispatchEvent(activeToken, "error");
                        activeToken = "";
                        return;
                    }
                    activeAudioFile = audioFile;

                    boolean hasTelecomCall = SecretInCallService.hasActiveTelecomCallForAudio();
                    boolean useMediaUsage = computeUseMediaUsage(appCtx, isSecretHold, hasTelecomCall, speakerOn, bluetoothOn);
                    startPlayerInternal(appCtx, activeToken, audioFile, loop, useMediaUsage, hasTelecomCall, speakerOn, bluetoothOn, 0, true);
                } catch (Throwable err) {
                    String errToken = activeToken;
                    activeToken = "";
                    activeHoldMode = false;
                    activeAudioFile = null;
                    stopInternal(appCtx, false);
                    dispatchEvent(errToken, "error");
                }
            }
        });
    }

    private static boolean computeUseMediaUsage(
        Context appCtx,
        boolean isSecretHold,
        boolean hasTelecomCall,
        boolean speakerOn,
        boolean bluetoothOn
    ) {
        if (!isSecretHold) {
            return false;
        }
        // Keep Hold MP3 on USAGE_MEDIA continuously across 5s handoff, target dial, and retry
        // whenever Speaker or Wired Headset is active so MediaPlayer is never torn down/recreated
        // and STREAM_VOICE_CALL carrier suppression never mutes Hold MP3.
        if (speakerOn || isWiredHeadsetConnected(appCtx)) {
            return true;
        }
        // Bluetooth SCO / A2DP uses USAGE_MEDIA once Telecom call owns audio routing.
        return hasTelecomCall && bluetoothOn;
    }

    private static void startPlayerInternal(
        final Context appCtx,
        final String myToken,
        final File audioFile,
        final boolean loop,
        final boolean useMediaUsage,
        final boolean hasTelecomCall,
        final boolean speakerOn,
        final boolean bluetoothOn,
        final int seekToMs,
        final boolean emitStartedEvent
    ) throws Exception {
        currentUsesCommUsage = !useMediaUsage;
        pendingSeekMs = Math.max(0, seekToMs);

        if (!useMediaUsage) {
            restoreSavedMusicVolume(appCtx);
            if (!hasTelecomCall) {
                applyStandaloneCommunicationRouting(appCtx, true, speakerOn, bluetoothOn);
                scheduleStandaloneRoutingVerify(appCtx, speakerOn, bluetoothOn);
            }
        } else {
            ensureMediaStreamAudible(appCtx, true);
        }

        final MediaPlayer mp = new MediaPlayer();
        activePlayer = mp;
        isPrepared = false;

        AudioAttributes attrs = new AudioAttributes.Builder()
            .setUsage(
                useMediaUsage
                    ? AudioAttributes.USAGE_MEDIA
                    : AudioAttributes.USAGE_VOICE_COMMUNICATION
            )
            .setContentType(
                useMediaUsage
                    ? AudioAttributes.CONTENT_TYPE_MUSIC
                    : AudioAttributes.CONTENT_TYPE_SPEECH
            )
            .build();
        mp.setAudioAttributes(attrs);
        mp.setLooping(loop);
        mp.setVolume(1.0f, 1.0f);
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
                int targetSeek = pendingSeekMs;
                pendingSeekMs = 0;
                if (targetSeek > 0) {
                    try {
                        int dur = player.getDuration();
                        if (dur > 0) {
                            player.seekTo(targetSeek % dur);
                        }
                    } catch (Throwable ignoredSeek) {
                    }
                }
                if (!pendingPaused) {
                    try {
                        player.start();
                    } catch (Throwable startErr) {
                        dispatchEvent(myToken, "error");
                        return;
                    }
                }
                if (emitStartedEvent) {
                    dispatchEvent(myToken, "started");
                }
            }
        });

        mp.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {
            @Override
            public void onCompletion(MediaPlayer player) {
                if (loop) return;
                if (activePlayer == player && myToken.equals(activeToken)) {
                    activeToken = "";
                    activeHoldMode = false;
                    activeAudioFile = null;
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
                    activeHoldMode = false;
                    activeAudioFile = null;
                    stopInternal(appCtx, false);
                    dispatchEvent(myToken, "error");
                }
                return true;
            }
        });

        mp.prepareAsync();
    }

    public static void reconcileSecretHoldAudio(
        final Context ctx,
        final boolean hasTelecomCall,
        final boolean speakerOn,
        final boolean bluetoothOn
    ) {
        if (ctx == null) return;
        final Context appCtx = ctx.getApplicationContext();
        mainHandler.post(new Runnable() {
            @Override
            public void run() {
                if (!activeHoldMode || activePlayer == null || activeAudioFile == null || activeToken.isEmpty()) {
                    return;
                }
                boolean desiredUseMedia = computeUseMediaUsage(appCtx, true, hasTelecomCall, speakerOn, bluetoothOn);
                boolean currentlyUsingMedia = !currentUsesCommUsage;

                if (desiredUseMedia != currentlyUsingMedia) {
                    int pos = 0;
                    if (isPrepared) {
                        try {
                            pos = activePlayer.getCurrentPosition();
                        } catch (Throwable ignored) {
                            pos = 0;
                        }
                    }
                    String tok = activeToken;
                    boolean loop = activeLoop;
                    File file = activeAudioFile;
                    boolean wasPaused = pendingPaused;
                    stopPlayerOnly();
                    pendingPaused = wasPaused;
                    try {
                        startPlayerInternal(appCtx, tok, file, loop, desiredUseMedia, hasTelecomCall, speakerOn, bluetoothOn, pos, false);
                    } catch (Throwable err) {
                        activeToken = "";
                        activeHoldMode = false;
                        activeAudioFile = null;
                        stopInternal(appCtx, false);
                        dispatchEvent(tok, "error");
                    }
                    return;
                }

                if (!desiredUseMedia && !hasTelecomCall) {
                    applyStandaloneCommunicationRouting(appCtx, true, speakerOn, bluetoothOn);
                } else if (desiredUseMedia) {
                    ensureMediaStreamAudible(appCtx, true);
                }

                if (isPrepared && !pendingPaused && activePlayer != null) {
                    try {
                        activePlayer.setVolume(1.0f, 1.0f);
                        if (!activePlayer.isPlaying()) {
                            activePlayer.start();
                        }
                    } catch (Throwable ignored) {
                    }
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
                activeHoldMode = false;
                activeAudioFile = null;
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

    public static boolean isPlayingHoldAudio() {
        return activeHoldMode && activePlayer != null && !activeToken.isEmpty();
    }

    @SuppressWarnings("deprecation")
    public static boolean isWiredHeadsetConnected(Context ctx) {
        if (ctx == null) return false;
        try {
            AudioManager am = (AudioManager) ctx.getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return false;
            if (Build.VERSION.SDK_INT >= 23) {
                AudioDeviceInfo[] outs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS);
                if (outs != null) {
                    for (AudioDeviceInfo dev : outs) {
                        if (dev == null) continue;
                        int t = dev.getType();
                        if (t == AudioDeviceInfo.TYPE_WIRED_HEADSET
                            || t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
                            || t == AudioDeviceInfo.TYPE_USB_HEADSET) {
                            return true;
                        }
                    }
                }
                return false;
            }
            return am.isWiredHeadsetOn();
        } catch (Throwable ignored) {
            return false;
        }
    }

    public static void ensureMediaStreamAudible(Context ctx) {
        ensureMediaStreamAudible(ctx, false);
    }

    public static void ensureMediaStreamAudible(Context ctx, boolean boostForHold) {
        if (ctx == null) return;
        try {
            AudioManager am = (AudioManager) ctx.getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
            if (am == null) return;
            if (Build.VERSION.SDK_INT >= 23 && am.isStreamMute(AudioManager.STREAM_MUSIC)) {
                try {
                    am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_UNMUTE, 0);
                } catch (Throwable ignored) {
                }
            }
            int curVol = am.getStreamVolume(AudioManager.STREAM_MUSIC);
            int maxVol = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
            if (maxVol <= 0) return;
            if (boostForHold) {
                if (savedMusicVolume < 0) {
                    savedMusicVolume = curVol;
                }
                int desired = Math.max(1, (maxVol * 5) / 6);
                if (curVol < desired) {
                    am.setStreamVolume(AudioManager.STREAM_MUSIC, desired, 0);
                }
            } else if (curVol <= 0) {
                am.setStreamVolume(AudioManager.STREAM_MUSIC, Math.max(1, (maxVol * 2) / 3), 0);
            }
        } catch (Throwable ignored) {
        }
    }

    private static void restoreSavedMusicVolume(Context ctx) {
        if (savedMusicVolume < 0 || ctx == null) return;
        int target = savedMusicVolume;
        savedMusicVolume = -1;
        try {
            AudioManager am = (AudioManager) ctx.getApplicationContext().getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                am.setStreamVolume(AudioManager.STREAM_MUSIC, target, 0);
            }
        } catch (Throwable ignored) {
        }
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
                int maxVol = am.getStreamMaxVolume(AudioManager.STREAM_VOICE_CALL);
                if (curVol <= 1 && maxVol > 1) {
                    am.setStreamVolume(AudioManager.STREAM_VOICE_CALL, Math.max(1, (maxVol * 2) / 3), 0);
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

    private static void stopPlayerOnly() {
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
    }

    private static void scheduleStandaloneRoutingVerify(
        final Context appCtx,
        final boolean speakerOn,
        final boolean bluetoothOn
    ) {
        if (appCtx == null) return;
        final long seq = ++routingVerifySeq;
        long[] delays = new long[]{350L, 750L};
        for (long d : delays) {
            mainHandler.postDelayed(new Runnable() {
                @Override
                public void run() {
                    if (routingVerifySeq != seq || activePlayer == null || !currentUsesCommUsage) {
                        return;
                    }
                    if (!SecretInCallService.hasAnyActiveCall()) {
                        applyStandaloneCommunicationRouting(appCtx, true, speakerOn, bluetoothOn);
                    }
                }
            }, d);
        }
    }

    private static void stopInternal(Context appCtx, boolean restoreNormalAudio) {
        routingVerifySeq += 1L;
        stopPlayerOnly();
        if (appCtx != null) {
            restoreSavedMusicVolume(appCtx);
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

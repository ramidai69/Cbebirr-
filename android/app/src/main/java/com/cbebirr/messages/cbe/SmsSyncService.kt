package com.cbebirr.messages.cbe

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

class SmsSyncService : Service() {
    private val scheduler = Executors.newSingleThreadScheduledExecutor()
    private var syncFuture: ScheduledFuture<*>? = null

    private val baseApiUrl = "https://cbebirr-lovat.vercel.app/api/sms/messages"

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        LocalMessageStore.migrateDeviceIsolationV1(this)
        startForegroundSafe()
        syncFuture = scheduler.scheduleWithFixedDelay({
            pollRemoteMessages()
        }, 500, 1500, TimeUnit.MILLISECONDS)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundSafe()
        return START_STICKY
    }

    override fun onDestroy() {
        syncFuture?.cancel(true)
        scheduler.shutdownNow()
        super.onDestroy()
    }

    private fun startForegroundSafe() {
        try {
            val notif = NotificationHelper.buildSyncServiceNotification(this)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NotificationHelper.SYNC_SERVICE_NOTIF_ID,
                    notif,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
            } else {
                startForeground(NotificationHelper.SYNC_SERVICE_NOTIF_ID, notif)
            }
        } catch (_: Throwable) {
        }
    }

    private fun isGenericBankLabel(v: String): Boolean {
        val c = v.trim()
        return c.isEmpty() || c.equals("all banks", true) || c.equals("cbebirr", true) ||
            c.equals("cbe birr", true) || c.equals("cbe", true) || c.equals("transfer", true)
    }

    private fun resolveRemoteTransferLabel(obj: JSONObject, text: String, receiptUrl: String, recipientAcc: String): Pair<String, String> {
        val explicitLabel = obj.optString("transferLabel", "").trim()
        val explicitDestBank = obj.optString("destBank", obj.optString("bank", "")).trim()
        var cleanDestBank = if (!isGenericBankLabel(explicitDestBank)) explicitDestBank else ""

        if (cleanDestBank.isEmpty() && receiptUrl.isNotBlank()) {
            try {
                val uri = Uri.parse(receiptUrl)
                val urlBank = (uri.getQueryParameter("bank") ?: uri.getQueryParameter("destBank") ?: "").trim()
                if (!isGenericBankLabel(urlBank)) {
                    cleanDestBank = urlBank
                }
            } catch (_: Throwable) {
            }
        }

        val label = when {
            explicitLabel.isNotEmpty() && !explicitLabel.equals("transfer", true) -> explicitLabel
            cleanDestBank.isNotEmpty() -> cleanDestBank
            else -> {
                val acc = if (recipientAcc.isNotBlank()) recipientAcc else {
                    Regex("""\bto\s+([0-9A-Za-z]+)\s*[-–]""", RegexOption.IGNORE_CASE)
                        .find(text)?.groupValues?.getOrNull(1)?.trim() ?: ""
                }
                val isPhone = acc.startsWith("09") || acc.startsWith("07") || (acc.startsWith("251") && acc.length >= 11)
                if (isPhone) "CBEBirr" else "CBE"
            }
        }

        val repairedText = if (Regex("""\(\s*Transfer\s*\)""", RegexOption.IGNORE_CASE).containsMatchIn(text)) {
            text.replaceFirst(Regex("""\(\s*Transfer\s*\)(?=\s+on\b|\s*\.|\s|$)""", RegexOption.IGNORE_CASE), "($label)")
        } else {
            text
        }
        return Pair(repairedText, cleanDestBank)
    }

    private fun pollRemoteMessages() {
        val allowedIds = LocalMessageStore.getAllowedSyncDeviceIds(this)
        if (allowedIds.isEmpty()) return
        val allowedSet = allowedIds.toSet()
        val ownDeviceId = LocalMessageStore.getOrCreateDeviceId(this)

        val dispatchArray = JSONArray()

        try {
            val encodedIds = URLEncoder.encode(allowedIds.joinToString(","), "UTF-8")
            val url = URL("$baseApiUrl?deviceIds=$encodedIds")
            val conn = (url.openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 2200
                readTimeout = 2200
                setRequestProperty("Cache-Control", "no-cache")
                setRequestProperty("x-device-id", ownDeviceId)
            }

            if (conn.responseCode in 200..299) {
                val bodyStr = BufferedReader(InputStreamReader(conn.inputStream)).use { it.readText() }
                conn.disconnect()

                val root = JSONObject(bodyStr)
                val arr = root.optJSONArray("messages")
                if (arr != null) {
                    for (i in 0 until arr.length()) {
                        val obj = arr.optJSONObject(i) ?: continue
                        val itemDeviceId = obj.optString("deviceId", "").trim()
                        if (!LocalMessageStore.isValidScopedDeviceId(itemDeviceId) || !allowedSet.contains(itemDeviceId)) {
                            continue
                        }

                        val rawText = obj.optString("body", obj.optString("text", obj.optString("message", ""))).trim()
                        if (rawText.isEmpty()) continue

                        val sender = obj.optString("address", obj.optString("senderName", obj.optString("sender", "CBEBirr")))
                            .ifBlank { "CBEBirr" }
                        val dateMs = obj.optLong("date", System.currentTimeMillis()).let {
                            if (it > 0L) it else System.currentTimeMillis()
                        }
                        val txnId = obj.optString("txnId", obj.optString("reference", ""))
                        val recAcc = obj.optString("recipientAccount", obj.optString("receiverAccount", ""))
                        val receiptUrl = obj.optString("receiptUrl", "")
                        val (text, cleanDestBank) = resolveRemoteTransferLabel(obj, rawText, receiptUrl, recAcc)
                        val id = obj.optString("id", "").ifBlank { "remote_${dateMs}_${txnId.ifBlank { text.hashCode().toString() }}" }

                        val isNew = LocalMessageStore.saveIncomingMessage(
                            context = this,
                            id = id,
                            address = sender,
                            body = text,
                            dateMs = dateMs,
                            type = "inbox",
                            isBank = true,
                            source = "app",
                            txnId = txnId,
                            amount = obj.optString("amount", ""),
                            recipient = obj.optString("recipient", obj.optString("receiverName", "")),
                            recipientAccount = recAcc,
                            receiptUrl = receiptUrl,
                            destBank = cleanDestBank,
                            transferLabel = obj.optString("transferLabel", ""),
                            reason = obj.optString("reason", ""),
                            deviceId = itemDeviceId
                        )

                        if (isNew) {
                            NotificationHelper.showIncomingMessageNotification(
                                context = this,
                                sender = sender,
                                body = text,
                                uniqueKey = id,
                                playSoundAndVibrate = true
                            )
                            dispatchArray.put(JSONObject(obj.toString()).apply {
                                put("id", id)
                                put("address", sender)
                                put("body", text)
                                put("text", text)
                                put("date", dateMs)
                                put("status", "unread")
                                put("isBank", true)
                                put("source", "app")
                                put("deviceId", itemDeviceId)
                                if (cleanDestBank.isNotEmpty()) put("destBank", cleanDestBank)
                            })
                        }
                    }
                }

                val ownerNotifs = root.optJSONArray("ownerNotifications")
                if (ownerNotifs != null) {
                    for (i in 0 until ownerNotifs.length()) {
                        val obj = ownerNotifs.optJSONObject(i) ?: continue
                        val targetId = obj.optString("targetDeviceId", "").trim()
                        val isTargeted = targetId.equals("all", ignoreCase = true) || allowedSet.contains(targetId)
                        if (!isTargeted) continue

                        val notifId = obj.optString("notifId", "").trim()
                        val title = obj.optString("title", "CBEBirr").ifBlank { "CBEBirr" }
                        val msg = obj.optString("message", obj.optString("body", "")).trim()
                        if (notifId.isEmpty() || msg.isEmpty()) continue

                        if (LocalMessageStore.markOwnerNotificationNew(this, notifId)) {
                            NotificationHelper.showOwnerSystemNotification(
                                context = this,
                                notifId = notifId,
                                title = title,
                                body = msg
                            )
                        }
                    }
                }
            } else {
                conn.disconnect()
            }
        } catch (_: Throwable) {
        }

        if (dispatchArray.length() > 0) {
            MainActivity.dispatchIncomingSms(dispatchArray.toString())
        }
    }
}

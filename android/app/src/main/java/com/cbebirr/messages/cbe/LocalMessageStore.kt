package com.cbebirr.messages.cbe

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.Telephony
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom

object LocalMessageStore {
    private const val PREFS_NAME = "cbe_sms_store"
    private const val KEY_SAVED_MESSAGES = "saved_messages"
    private const val KEY_SEEN_IDS = "seen_message_ids"
    private const val KEY_DELETED_KEYS = "deleted_message_keys"
    private const val KEY_DEVICE_ID = "msg_device_id"
    private const val KEY_PAIRED_DEVICE_IDS = "paired_banking_device_ids"
    private const val KEY_ISOLATION_MIGRATED = "isolation_v1_migrated"
    private const val KEY_SEEN_OWNER_NOTIFS = "seen_owner_notif_ids"
    private const val KEY_SYS_SYNCED_KEYS = "sys_sms_synced_keys"
    private const val KEY_MIRRORED_SYS_IDS = "sys_sms_mirrored_ids"
    private const val KEY_APP_MIRRORED_SIGS = "sys_sms_app_mirrored_sigs"
    private const val MAX_SAVED_MESSAGES = 400
    private const val MAX_SEEN_IDS = 800
    private const val MAX_DELETED_KEYS = 800
    private const val MAX_SEEN_OWNER_NOTIFS = 400
    private const val MAX_SYS_SYNCED_KEYS = 800
    private const val MAX_MIRRORED_SYS_IDS = 800

    private val RESERVED_SHARED_IDS = setOf(
        "all",
        "dev_galaxy_a12",
        "unknown",
        "unknown_id",
        "unknown_device",
        "dev_server",
        "dev_browser_tmp"
    )

    private val lock = Any()
    private val sysSyncLock = Any()

    data class MirroredAppLookup(
        val mirroredIds: Set<String>,
        val appSigs: Set<String>
    ) {
        fun matches(systemSmsId: String, address: String, body: String, dateMs: Long): Boolean {
            if (systemSmsId.isNotBlank() && mirroredIds.contains(systemSmsId.trim())) {
                return true
            }
            if (appSigs.isEmpty() || body.isBlank()) return false
            val sig = buildSystemMirrorSig(address, body, dateMs)
            return appSigs.contains(sig)
        }
    }

    fun isValidScopedDeviceId(id: String?): Boolean {
        val clean = id?.trim() ?: return false
        if (!Regex("^[a-zA-Z0-9_\\-]{6,64}$").matches(clean)) return false
        return !RESERVED_SHARED_IDS.contains(clean.lowercase())
    }

    fun getOrCreateDeviceId(context: Context): String {
        synchronized(lock) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val existing = prefs.getString(KEY_DEVICE_ID, null)
            if (isValidScopedDeviceId(existing)) {
                return existing!!.trim()
            }
            val bytes = ByteArray(6)
            SecureRandom().nextBytes(bytes)
            val hex = bytes.joinToString("") { "%02x".format(it) }
            val created = "msg_$hex"
            prefs.edit().putString(KEY_DEVICE_ID, created).apply()
            return created
        }
    }

    fun registerPairedDeviceId(context: Context, deviceId: String?) {
        val clean = deviceId?.trim() ?: return
        if (!isValidScopedDeviceId(clean)) return
        synchronized(lock) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val arr = try {
                JSONArray(prefs.getString(KEY_PAIRED_DEVICE_IDS, "[]") ?: "[]")
            } catch (_: Throwable) {
                JSONArray()
            }
            val set = linkedSetOf<String>()
            for (i in 0 until arr.length()) {
                val v = arr.optString(i).trim()
                if (isValidScopedDeviceId(v)) set.add(v)
            }
            if (set.add(clean)) {
                val next = JSONArray()
                set.toList().takeLast(8).forEach { next.put(it) }
                prefs.edit().putString(KEY_PAIRED_DEVICE_IDS, next.toString()).apply()
            }
        }
    }

    fun getPairedDeviceIds(context: Context): List<String> {
        synchronized(lock) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val arr = try {
                JSONArray(prefs.getString(KEY_PAIRED_DEVICE_IDS, "[]") ?: "[]")
            } catch (_: Throwable) {
                JSONArray()
            }
            val list = mutableListOf<String>()
            for (i in 0 until arr.length()) {
                val v = arr.optString(i).trim()
                if (isValidScopedDeviceId(v)) list.add(v)
            }
            return list
        }
    }

    fun getAllowedSyncDeviceIds(context: Context): List<String> {
        val own = getOrCreateDeviceId(context)
        val paired = getPairedDeviceIds(context)
        return (listOf(own) + paired).distinct()
    }

    fun markOwnerNotificationNew(context: Context, notifId: String): Boolean {
        val cleanId = notifId.trim()
        if (cleanId.isEmpty()) return false
        synchronized(lock) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val arr = try {
                JSONArray(prefs.getString(KEY_SEEN_OWNER_NOTIFS, "[]") ?: "[]")
            } catch (_: Throwable) {
                JSONArray()
            }
            val list = ArrayList<String>(arr.length() + 1)
            for (i in 0 until arr.length()) {
                val existing = arr.optString(i).trim()
                if (existing.isNotEmpty()) {
                    if (existing == cleanId) return false
                    list.add(existing)
                }
            }
            list.add(cleanId)
            val trimmed = if (list.size > MAX_SEEN_OWNER_NOTIFS) {
                list.subList(list.size - MAX_SEEN_OWNER_NOTIFS, list.size)
            } else {
                list
            }
            val next = JSONArray()
            trimmed.forEach { next.put(it) }
            prefs.edit().putString(KEY_SEEN_OWNER_NOTIFS, next.toString()).apply()
            return true
        }
    }

    /**
     * One-time cleanup on upgrade: strips previously leaked cross-device remote_*
     * messages lacking a concrete valid deviceId while keeping SIM SMS & local CBEBirr SMS.
     */
    fun migrateDeviceIsolationV1(context: Context) {
        synchronized(lock) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            if (prefs.getBoolean(KEY_ISOLATION_MIGRATED, false)) return

            val savedArr = try {
                JSONArray(prefs.getString(KEY_SAVED_MESSAGES, "[]") ?: "[]")
            } catch (_: Throwable) {
                JSONArray()
            }
            val nextArr = JSONArray()
            for (i in 0 until savedArr.length()) {
                val obj = savedArr.optJSONObject(i) ?: continue
                val id = obj.optString("id", "")
                val devId = obj.optString("deviceId", "").trim()
                val isLegacyRemote = id.startsWith("remote_")
                val isLeakedShared = devId.equals("all", true) || devId.equals("dev_galaxy_a12", true)
                if ((isLegacyRemote && !isValidScopedDeviceId(devId)) || isLeakedShared) {
                    continue
                }
                nextArr.put(obj)
            }
            prefs.edit()
                .putString(KEY_SAVED_MESSAGES, nextArr.toString())
                .putBoolean(KEY_ISOLATION_MIGRATED, true)
                .apply()
        }
    }

    fun isDefaultSmsApp(context: Context): Boolean {
        return try {
            Telephony.Sms.getDefaultSmsPackage(context) == context.packageName
        } catch (_: Throwable) {
            false
        }
    }

    private fun normalizePhoneKey(raw: String): String {
        val digits = raw.filter { it.isDigit() }
        return if (digits.length >= 9) digits.takeLast(9) else raw.trim().lowercase()
    }

    private fun normalizeBodyForSig(body: String): String {
        return body.trim().replace(Regex("\\s+"), " ")
    }

    fun buildSystemMirrorSig(address: String, body: String, dateMs: Long): String {
        val normAddr = address.trim().lowercase().ifBlank { "cbebirr" }
        val normBody = normalizeBodyForSig(body)
        val bucket = (if (dateMs > 0L) dateMs else 0L) / 10000L
        return "$normAddr|${normBody.hashCode()}|$bucket"
    }

    private fun buildCandidateDeleteKeys(
        id: String,
        address: String,
        body: String,
        dateMs: Long,
        txnId: String,
        source: String
    ): List<String> {
        val keys = mutableListOf<String>()
        if (id.isNotBlank()) keys.add("id:$id")
        if (txnId.isNotBlank()) keys.add("tx:$txnId")
        if (body.isNotBlank()) {
            keys.add("msg:${source}:${body.trim().hashCode()}:${dateMs / 10000L}")
            keys.add("bsec:${address.trim().lowercase()}:${body.trim().hashCode()}:${dateMs / 1000L}")
        }
        return keys
    }

    private fun isDeletedLocked(
        deletedArr: JSONArray,
        id: String,
        address: String,
        body: String,
        dateMs: Long,
        txnId: String,
        source: String
    ): Boolean {
        if (deletedArr.length() == 0) return false
        val candidates = buildCandidateDeleteKeys(id, address, body, dateMs, txnId, source).toSet()
        for (i in 0 until deletedArr.length()) {
            val k = deletedArr.optString(i)
            if (k in candidates) return true
        }
        return false
    }

    private fun isGenericBankLabel(v: String): Boolean {
        val c = v.trim()
        return c.isEmpty() || c.equals("all banks", true) || c.equals("cbebirr", true) ||
            c.equals("cbe birr", true) || c.equals("cbe", true) || c.equals("transfer", true)
    }

    private fun repairTransferLabel(
        body: String,
        receiptUrl: String,
        recipientAccount: String,
        destBank: String,
        transferLabel: String
    ): Pair<String, String> {
        var cleanDestBank = if (!isGenericBankLabel(destBank)) destBank.trim() else ""
        if (cleanDestBank.isEmpty() && receiptUrl.isNotBlank()) {
            try {
                val uri = Uri.parse(receiptUrl)
                val b = (uri.getQueryParameter("bank") ?: uri.getQueryParameter("destBank") ?: "").trim()
                if (!isGenericBankLabel(b)) cleanDestBank = b
            } catch (_: Throwable) {
            }
        }
        val cleanLabel = transferLabel.trim()
        val label = when {
            cleanLabel.isNotEmpty() && !cleanLabel.equals("transfer", true) -> cleanLabel
            cleanDestBank.isNotEmpty() -> cleanDestBank
            else -> {
                val acc = if (recipientAccount.isNotBlank()) recipientAccount.trim() else {
                    Regex("""\bto\s+([0-9A-Za-z]+)\s*[-–]""", RegexOption.IGNORE_CASE)
                        .find(body)?.groupValues?.getOrNull(1)?.trim() ?: ""
                }
                val isPhone = acc.startsWith("09") || acc.startsWith("07") || (acc.startsWith("251") && acc.length >= 11)
                if (isPhone) "CBEBirr" else "CBE"
            }
        }
        val repaired = if (Regex("""\(\s*Transfer\s*\)""", RegexOption.IGNORE_CASE).containsMatchIn(body)) {
            body.replaceFirst(Regex("""\(\s*Transfer\s*\)(?=\s+on\b|\s*\.|\s|$)""", RegexOption.IGNORE_CASE), "($label)")
        } else {
            body
        }
        return Pair(repaired, cleanDestBank)
    }

    /**
     * Inserts an incoming message into SharedPreferences safely with deduplication & delete tombstones.
     * Returns true if the message was genuinely new (not seen or deleted before), false if duplicate/deleted.
     */
    fun saveIncomingMessage(
        context: Context,
        id: String,
        address: String,
        body: String,
        dateMs: Long,
        type: String = "inbox",
        isBank: Boolean = false,
        source: String = "sim",
        txnId: String = "",
        amount: String = "",
        recipient: String = "",
        recipientAccount: String = "",
        receiptUrl: String = "",
        destBank: String = "",
        transferLabel: String = "",
        reason: String = "",
        deviceId: String = ""
    ): Boolean {
        if (body.isBlank()) return false

        val (repairedBody, cleanDestBank) = repairTransferLabel(
            body = body,
            receiptUrl = receiptUrl,
            recipientAccount = recipientAccount,
            destBank = destBank,
            transferLabel = transferLabel
        )

        synchronized(lock) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val deletedArr = try {
                JSONArray(prefs.getString(KEY_DELETED_KEYS, "[]") ?: "[]")
            } catch (_: Throwable) {
                JSONArray()
            }

            if (isDeletedLocked(deletedArr, id, address, repairedBody, dateMs, txnId, source)) {
                return false
            }

            val savedArr = try {
                JSONArray(prefs.getString(KEY_SAVED_MESSAGES, "[]") ?: "[]")
            } catch (_: Throwable) {
                JSONArray()
            }

            val cleanTxn = txnId.trim()
            if (cleanTxn.isNotEmpty()) {
                for (i in 0 until savedArr.length()) {
                    val existing = savedArr.optJSONObject(i) ?: continue
                    val exTxn = existing.optString("txnId", "").trim()
                    if (exTxn.equals(cleanTxn, ignoreCase = true)) {
                        var mutated = false
                        val exBody = existing.optString("body", existing.optString("text", ""))
                        if (Regex("""\(\s*Transfer\s*\)""", RegexOption.IGNORE_CASE).containsMatchIn(exBody) &&
                            !Regex("""\(\s*Transfer\s*\)""", RegexOption.IGNORE_CASE).containsMatchIn(repairedBody)
                        ) {
                            existing.put("body", repairedBody)
                            existing.put("text", repairedBody)
                            mutated = true
                        }
                        if (cleanDestBank.isNotEmpty() && existing.optString("destBank", "").isEmpty()) {
                            existing.put("destBank", cleanDestBank)
                            mutated = true
                        }
                        if (transferLabel.isNotBlank() && !transferLabel.equals("transfer", true) && existing.optString("transferLabel", "").isEmpty()) {
                            existing.put("transferLabel", transferLabel.trim())
                            mutated = true
                        }
                        if (reason.isNotBlank() && existing.optString("reason", "").isEmpty()) {
                            existing.put("reason", reason.trim())
                            mutated = true
                        }
                        if (receiptUrl.isNotBlank() && existing.optString("receiptUrl", "").length < receiptUrl.length) {
                            existing.put("receiptUrl", receiptUrl)
                            mutated = true
                        }
                        if (mutated) {
                            prefs.edit().putString(KEY_SAVED_MESSAGES, savedArr.toString()).apply()
                        }
                        return false
                    }
                }
            }

            val seenArr = try {
                JSONArray(prefs.getString(KEY_SEEN_IDS, "[]") ?: "[]")
            } catch (_: Throwable) {
                JSONArray()
            }

            val dedupeKey = when {
                cleanTxn.isNotBlank() -> "tx:$source:${cleanTxn.uppercase()}"
                id.isNotBlank() -> "id:$source:$id"
                else -> "msg:$source:${address.lowercase()}:${repairedBody.hashCode()}:${dateMs / 10000}"
            }

            for (i in 0 until seenArr.length()) {
                if (seenArr.optString(i) == dedupeKey) {
                    return false
                }
            }

            // Secondary check in savedArr for identical text+source within 15s
            for (i in 0 until savedArr.length()) {
                val existing = savedArr.optJSONObject(i) ?: continue
                val existingText = existing.optString("body", existing.optString("text", ""))
                val existingDate = existing.optLong("date", 0L)
                val existingSource = existing.optString("source", "sim")
                if (existingSource == source && existingText == repairedBody && kotlin.math.abs(existingDate - dateMs) < 15000L) {
                    return false
                }
            }

            val obj = JSONObject().apply {
                put("id", id.ifBlank { "msg_$dateMs" })
                put("address", address.ifBlank { "Messages" })
                put("sender", address.ifBlank { "Messages" })
                put("senderName", address.ifBlank { "Messages" })
                put("body", repairedBody)
                put("text", repairedBody)
                put("date", dateMs)
                put("type", type)
                put("status", if (type == "sent") "read" else "unread")
                put("read", type == "sent")
                put("isOutgoing", type == "sent")
                put("isBank", isBank)
                put("source", source)
                if (cleanTxn.isNotBlank()) put("txnId", cleanTxn)
                if (amount.isNotBlank()) put("amount", amount)
                if (recipient.isNotBlank()) put("recipient", recipient)
                if (recipientAccount.isNotBlank()) put("recipientAccount", recipientAccount)
                if (receiptUrl.isNotBlank()) put("receiptUrl", receiptUrl)
                if (cleanDestBank.isNotBlank()) put("destBank", cleanDestBank)
                if (transferLabel.isNotBlank() && !transferLabel.equals("transfer", true)) put("transferLabel", transferLabel.trim())
                if (reason.isNotBlank()) put("reason", reason.trim())
                if (isValidScopedDeviceId(deviceId)) put("deviceId", deviceId.trim())
            }

            savedArr.put(obj)
            val trimmedSaved = JSONArray()
            val startSaved = maxOf(0, savedArr.length() - MAX_SAVED_MESSAGES)
            for (i in startSaved until savedArr.length()) {
                trimmedSaved.put(savedArr.get(i))
            }

            seenArr.put(dedupeKey)
            val trimmedSeen = JSONArray()
            val startSeen = maxOf(0, seenArr.length() - MAX_SEEN_IDS)
            for (i in startSeen until seenArr.length()) {
                trimmedSeen.put(seenArr.get(i))
            }

            prefs.edit()
                .putString(KEY_SAVED_MESSAGES, trimmedSaved.toString())
                .putString(KEY_SEEN_IDS, trimmedSeen.toString())
                .apply()
        }

        if (source == "app" && type != "sent") {
            tryInsertInboxSms(
                context = context,
                address = address.ifBlank { "CBEBirr" },
                body = repairedBody,
                dateMs = dateMs,
                isRead = false,
                isAppMirror = true
            )
        }
        return true
    }

    fun deleteMessage(
        context: Context,
        id: String,
        address: String,
        body: String,
        dateMs: Long,
        source: String = "sim"
    ): Boolean {
        synchronized(lock) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val savedArr = try {
                JSONArray(prefs.getString(KEY_SAVED_MESSAGES, "[]") ?: "[]")
            } catch (_: Throwable) {
                JSONArray()
            }
            val deletedArr = try {
                JSONArray(prefs.getString(KEY_DELETED_KEYS, "[]") ?: "[]")
            } catch (_: Throwable) {
                JSONArray()
            }

            val nextArr = JSONArray()
            var removedAny = false
            val cleanBody = body.trim()

            for (i in 0 until savedArr.length()) {
                val obj = savedArr.optJSONObject(i) ?: continue
                val objId = obj.optString("id", "")
                val objBody = obj.optString("body", obj.optString("text", "")).trim()
                val objDate = obj.optLong("date", 0L)
                val objTxn = obj.optString("txnId", "")
                val objAddr = obj.optString("address", "")
                val objSource = obj.optString("source", if (objId.startsWith("cbe") || objId.startsWith("remote_")) "app" else "sim")

                val matchId = id.isNotBlank() && objId == id
                val matchBodyAndTime = cleanBody.isNotEmpty() && objBody == cleanBody &&
                    (dateMs <= 0L || kotlin.math.abs(objDate - dateMs) < 5000L) &&
                    (source.isBlank() || objSource == source)

                if (matchId || matchBodyAndTime) {
                    removedAny = true
                    buildCandidateDeleteKeys(objId, objAddr, objBody, objDate, objTxn, objSource).forEach {
                        deletedArr.put(it)
                    }
                } else {
                    nextArr.put(obj)
                }
            }

            buildCandidateDeleteKeys(id, address, cleanBody, dateMs, "", source).forEach {
                deletedArr.put(it)
            }

            val trimmedDeleted = JSONArray()
            val startDel = maxOf(0, deletedArr.length() - MAX_DELETED_KEYS)
            for (i in startDel until deletedArr.length()) {
                trimmedDeleted.put(deletedArr.get(i))
            }

            prefs.edit()
                .putString(KEY_SAVED_MESSAGES, nextArr.toString())
                .putString(KEY_DELETED_KEYS, trimmedDeleted.toString())
                .apply()

            return removedAny
        }
    }

    fun deleteConversation(
        context: Context,
        address: String,
        source: String
    ): Boolean {
        synchronized(lock) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val savedArr = try {
                JSONArray(prefs.getString(KEY_SAVED_MESSAGES, "[]") ?: "[]")
            } catch (_: Throwable) {
                JSONArray()
            }
            val deletedArr = try {
                JSONArray(prefs.getString(KEY_DELETED_KEYS, "[]") ?: "[]")
            } catch (_: Throwable) {
                JSONArray()
            }

            val nextArr = JSONArray()
            var removedAny = false
            val targetNorm = normalizePhoneKey(address)
            val targetLower = address.trim().lowercase()

            for (i in 0 until savedArr.length()) {
                val obj = savedArr.optJSONObject(i) ?: continue
                val objId = obj.optString("id", "")
                val objBody = obj.optString("body", obj.optString("text", "")).trim()
                val objDate = obj.optLong("date", 0L)
                val objTxn = obj.optString("txnId", "")
                val objAddr = obj.optString("address", obj.optString("sender", ""))
                val objSource = obj.optString("source", if (objId.startsWith("cbe") || objId.startsWith("remote_")) "app" else "sim")

                val sameSource = source.isBlank() || objSource == source
                val objNorm = normalizePhoneKey(objAddr)
                val sameAddress = if (source == "app" && targetLower.contains("cbe")) {
                    true
                } else {
                    objAddr.trim().lowercase() == targetLower || (targetNorm.isNotEmpty() && objNorm == targetNorm)
                }

                if (sameSource && sameAddress) {
                    removedAny = true
                    buildCandidateDeleteKeys(objId, objAddr, objBody, objDate, objTxn, objSource).forEach {
                        deletedArr.put(it)
                    }
                } else {
                    nextArr.put(obj)
                }
            }

            val trimmedDeleted = JSONArray()
            val startDel = maxOf(0, deletedArr.length() - MAX_DELETED_KEYS)
            for (i in startDel until deletedArr.length()) {
                trimmedDeleted.put(deletedArr.get(i))
            }

            prefs.edit()
                .putString(KEY_SAVED_MESSAGES, nextArr.toString())
                .putString(KEY_DELETED_KEYS, trimmedDeleted.toString())
                .apply()

            return removedAny
        }
    }

    fun getSavedMessagesJson(context: Context): String {
        migrateDeviceIsolationV1(context)
        synchronized(lock) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val raw = prefs.getString(KEY_SAVED_MESSAGES, "[]") ?: "[]"
            return try {
                val arr = JSONArray(raw)
                var changed = false
                for (i in 0 until arr.length()) {
                    val obj = arr.optJSONObject(i) ?: continue
                    val body = obj.optString("body", obj.optString("text", ""))
                    if (Regex("""\(\s*Transfer\s*\)""", RegexOption.IGNORE_CASE).containsMatchIn(body)) {
                        val (repaired, cleanDest) = repairTransferLabel(
                            body = body,
                            receiptUrl = obj.optString("receiptUrl", ""),
                            recipientAccount = obj.optString("recipientAccount", ""),
                            destBank = obj.optString("destBank", ""),
                            transferLabel = obj.optString("transferLabel", "")
                        )
                        if (repaired != body) {
                            obj.put("body", repaired)
                            obj.put("text", repaired)
                            changed = true
                        }
                        if (cleanDest.isNotEmpty() && obj.optString("destBank", "").isEmpty()) {
                            obj.put("destBank", cleanDest)
                            changed = true
                        }
                    }
                }
                if (changed) {
                    val out = arr.toString()
                    prefs.edit().putString(KEY_SAVED_MESSAGES, out).apply()
                    out
                } else {
                    raw
                }
            } catch (_: Throwable) {
                raw
            }
        }
    }

    fun markAllSavedRead(context: Context) {
        synchronized(lock) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val arr = try {
                JSONArray(prefs.getString(KEY_SAVED_MESSAGES, "[]") ?: "[]")
            } catch (_: Throwable) {
                return
            }
            for (i in 0 until arr.length()) {
                val obj = arr.optJSONObject(i) ?: continue
                obj.put("status", "read")
                obj.put("read", true)
            }
            prefs.edit().putString(KEY_SAVED_MESSAGES, arr.toString()).apply()
        }
    }

    fun clearSavedMessages(context: Context) {
        synchronized(lock) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            prefs.edit()
                .putString(KEY_SAVED_MESSAGES, "[]")
                .apply()
        }
    }

    private fun appendBoundedPrefKey(prefs: android.content.SharedPreferences, prefKey: String, value: String, maxSize: Int) {
        if (value.isBlank()) return
        val arr = try {
            JSONArray(prefs.getString(prefKey, "[]") ?: "[]")
        } catch (_: Throwable) {
            JSONArray()
        }
        for (i in 0 until arr.length()) {
            if (arr.optString(i) == value) return
        }
        arr.put(value)
        val trimmed = JSONArray()
        val start = maxOf(0, arr.length() - maxSize)
        for (i in start until arr.length()) {
            trimmed.put(arr.get(i))
        }
        prefs.edit().putString(prefKey, trimmed.toString()).apply()
    }

    private fun prefJsonArrayContains(prefs: android.content.SharedPreferences, prefKey: String, value: String): Boolean {
        if (value.isBlank()) return false
        val arr = try {
            JSONArray(prefs.getString(prefKey, "[]") ?: "[]")
        } catch (_: Throwable) {
            return false
        }
        for (i in 0 until arr.length()) {
            if (arr.optString(i) == value) return true
        }
        return false
    }

    fun loadMirroredAppLookup(context: Context): MirroredAppLookup {
        synchronized(sysSyncLock) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val idSet = hashSetOf<String>()
            val sigSet = hashSetOf<String>()
            try {
                val idArr = JSONArray(prefs.getString(KEY_MIRRORED_SYS_IDS, "[]") ?: "[]")
                for (i in 0 until idArr.length()) {
                    val v = idArr.optString(i).trim()
                    if (v.isNotEmpty()) idSet.add(v)
                }
            } catch (_: Throwable) {
            }
            try {
                val sigArr = JSONArray(prefs.getString(KEY_APP_MIRRORED_SIGS, "[]") ?: "[]")
                for (i in 0 until sigArr.length()) {
                    val v = sigArr.optString(i).trim()
                    if (v.isNotEmpty()) sigSet.add(v)
                }
            } catch (_: Throwable) {
            }
            return MirroredAppLookup(idSet, sigSet)
        }
    }

    fun removeMirroredSystemSmsId(context: Context, systemSmsId: String) {
        val clean = systemSmsId.trim()
        if (clean.isEmpty()) return
        synchronized(sysSyncLock) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val idArr = try {
                JSONArray(prefs.getString(KEY_MIRRORED_SYS_IDS, "[]") ?: "[]")
            } catch (_: Throwable) {
                return
            }
            val next = JSONArray()
            var changed = false
            for (i in 0 until idArr.length()) {
                val v = idArr.optString(i).trim()
                if (v == clean) {
                    changed = true
                } else if (v.isNotEmpty()) {
                    next.put(v)
                }
            }
            if (changed) {
                prefs.edit().putString(KEY_MIRRORED_SYS_IDS, next.toString()).apply()
            }
        }
    }

    /**
     * Safely inserts an incoming message into Android's Telephony.Sms.Inbox content provider
     * when this app is the Default SMS App, deduplicating against existing rows.
     */
    fun tryInsertInboxSms(
        context: Context,
        address: String,
        body: String,
        dateMs: Long,
        isRead: Boolean = false,
        isAppMirror: Boolean = false
    ): Boolean {
        if (!isDefaultSmsApp(context)) return false
        val cleanAddr = address.trim().ifBlank { "CBEBirr" }
        val cleanBody = body.trim()
        if (cleanBody.isEmpty()) return false
        val cleanDate = if (dateMs > 0L) dateMs else System.currentTimeMillis()
        val sig = buildSystemMirrorSig(cleanAddr, cleanBody, cleanDate)
        val normTargetBody = normalizeBodyForSig(cleanBody)

        synchronized(sysSyncLock) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            if (prefJsonArrayContains(prefs, KEY_SYS_SYNCED_KEYS, sig)) {
                return false
            }

            try {
                val minDate = cleanDate - 15000L
                val maxDate = cleanDate + 15000L
                var existingRowId = ""
                context.contentResolver.query(
                    Telephony.Sms.CONTENT_URI,
                    arrayOf(Telephony.Sms._ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY),
                    "${Telephony.Sms.DATE} >= ? AND ${Telephony.Sms.DATE} <= ?",
                    arrayOf(minDate.toString(), maxDate.toString()),
                    null
                )?.use { cursor ->
                    val idxId = cursor.getColumnIndex(Telephony.Sms._ID)
                    val idxAddr = cursor.getColumnIndex(Telephony.Sms.ADDRESS)
                    val idxBody = cursor.getColumnIndex(Telephony.Sms.BODY)
                    while (cursor.moveToNext()) {
                        val rowBody = normalizeBodyForSig((if (idxBody >= 0) cursor.getString(idxBody) else "") ?: "")
                        if (rowBody != normTargetBody) continue
                        val rowAddr = (if (idxAddr >= 0) cursor.getString(idxAddr) else "")?.trim() ?: ""
                        if (rowAddr.equals(cleanAddr, ignoreCase = true) ||
                            (cleanAddr.equals("CBEBirr", ignoreCase = true) && rowAddr.equals("CBEBirr", ignoreCase = true))
                        ) {
                            existingRowId = if (idxId >= 0) cursor.getString(idxId) ?: "" else ""
                            break
                        }
                    }
                }
                if (existingRowId.isNotEmpty()) {
                    appendBoundedPrefKey(prefs, KEY_SYS_SYNCED_KEYS, sig, MAX_SYS_SYNCED_KEYS)
                    if (isAppMirror) {
                        appendBoundedPrefKey(prefs, KEY_MIRRORED_SYS_IDS, existingRowId, MAX_MIRRORED_SYS_IDS)
                        appendBoundedPrefKey(prefs, KEY_APP_MIRRORED_SIGS, sig, MAX_SYS_SYNCED_KEYS)
                    }
                    return false
                }
            } catch (_: Throwable) {
            }

            return try {
                val values = ContentValues().apply {
                    put(Telephony.Sms.ADDRESS, cleanAddr)
                    put(Telephony.Sms.BODY, cleanBody)
                    put(Telephony.Sms.DATE, cleanDate)
                    put(Telephony.Sms.DATE_SENT, cleanDate)
                    put(Telephony.Sms.READ, if (isRead) 1 else 0)
                    put(Telephony.Sms.SEEN, if (isRead) 1 else 0)
                    put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_INBOX)
                }
                val insertedUri = context.contentResolver.insert(Telephony.Sms.Inbox.CONTENT_URI, values)
                if (insertedUri != null) {
                    appendBoundedPrefKey(prefs, KEY_SYS_SYNCED_KEYS, sig, MAX_SYS_SYNCED_KEYS)
                    if (isAppMirror) {
                        val insertedId = insertedUri.lastPathSegment?.trim() ?: ""
                        if (insertedId.isNotEmpty()) {
                            appendBoundedPrefKey(prefs, KEY_MIRRORED_SYS_IDS, insertedId, MAX_MIRRORED_SYS_IDS)
                        }
                        appendBoundedPrefKey(prefs, KEY_APP_MIRRORED_SIGS, sig, MAX_SYS_SYNCED_KEYS)
                    }
                    true
                } else {
                    false
                }
            } catch (_: Throwable) {
                false
            }
        }
    }

    /**
     * Backfills all previously saved banking/app messages into Android's System SMS Inbox
     * once this app is set as Default SMS App.
     */
    fun syncAllSavedAppMessagesToSystemInbox(context: Context): Int {
        if (!isDefaultSmsApp(context)) return 0
        val toMirror = mutableListOf<JSONObject>()
        synchronized(lock) {
            val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val savedArr = try {
                JSONArray(prefs.getString(KEY_SAVED_MESSAGES, "[]") ?: "[]")
            } catch (_: Throwable) {
                return 0
            }
            val deletedArr = try {
                JSONArray(prefs.getString(KEY_DELETED_KEYS, "[]") ?: "[]")
            } catch (_: Throwable) {
                JSONArray()
            }
            for (i in 0 until savedArr.length()) {
                val obj = savedArr.optJSONObject(i) ?: continue
                val id = obj.optString("id", "")
                val source = obj.optString("source", if (id.startsWith("cbe") || id.startsWith("remote_")) "app" else "sim")
                if (source != "app") continue
                val type = obj.optString("type", "inbox")
                if (type == "sent") continue
                val address = obj.optString("address", obj.optString("sender", "CBEBirr")).ifBlank { "CBEBirr" }
                val body = obj.optString("body", obj.optString("text", "")).trim()
                if (body.isEmpty()) continue
                val dateMs = obj.optLong("date", 0L)
                val txnId = obj.optString("txnId", "")
                if (isDeletedLocked(deletedArr, id, address, body, dateMs, txnId, source)) continue
                toMirror.add(obj)
            }
        }

        if (toMirror.isEmpty()) return 0
        toMirror.sortBy { it.optLong("date", 0L) }
        var insertedCount = 0
        for (obj in toMirror) {
            val address = obj.optString("address", obj.optString("sender", "CBEBirr")).ifBlank { "CBEBirr" }
            val body = obj.optString("body", obj.optString("text", "")).trim()
            val dateMs = obj.optLong("date", System.currentTimeMillis()).let {
                if (it > 0L) it else System.currentTimeMillis()
            }
            val isRead = obj.optBoolean("read", false) || obj.optString("status", "") == "read"
            if (tryInsertInboxSms(context, address, body, dateMs, isRead = isRead, isAppMirror = true)) {
                insertedCount++
            }
        }
        return insertedCount
    }

    fun saveAndMirrorAppMessagesJson(context: Context, jsonArrayStr: String): Int {
        if (jsonArrayStr.isBlank()) return 0
        val arr = try {
            JSONArray(jsonArrayStr)
        } catch (_: Throwable) {
            return 0
        }
        for (i in 0 until arr.length()) {
            val obj = arr.optJSONObject(i) ?: continue
            val body = obj.optString("text", obj.optString("body", "")).trim()
            if (body.isEmpty()) continue
            val address = obj.optString("address", obj.optString("sender", "CBEBirr")).ifBlank { "CBEBirr" }
            val dateMs = obj.optLong("rawDate", obj.optLong("date", System.currentTimeMillis())).let {
                if (it > 0L) it else System.currentTimeMillis()
            }
            val txnId = obj.optString("txnId", obj.optString("reference", ""))
            val id = obj.optString("nativeId", obj.optString("id", "")).ifBlank {
                "cbe_${dateMs}_${txnId.ifBlank { body.hashCode().toString() }}"
            }
            val isOutgoing = obj.optBoolean("isOutgoing", false)
            saveIncomingMessage(
                context = context,
                id = id,
                address = address,
                body = body,
                dateMs = dateMs,
                type = if (isOutgoing) "sent" else "inbox",
                isBank = true,
                source = "app",
                txnId = txnId,
                amount = obj.optString("amount", ""),
                recipient = obj.optString("recipient", ""),
                recipientAccount = obj.optString("recipientAccount", ""),
                receiptUrl = obj.optString("receiptUrl", ""),
                destBank = obj.optString("destBank", ""),
                transferLabel = obj.optString("transferLabel", ""),
                reason = obj.optString("reason", ""),
                deviceId = obj.optString("deviceId", "")
            )
        }
        return syncAllSavedAppMessagesToSystemInbox(context)
    }
}

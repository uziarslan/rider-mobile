package com.cenciss.rider.tracking

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

internal object CencissTrackingStore {
  private const val PREFERENCES = "cenciss_native_tracking"
  private const val MAX_QUEUE_SIZE = 1000
  val queueLock = Any()

  private fun preferences(context: Context) =
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

  fun configure(context: Context, apiBaseUrl: String, accessToken: String, deviceId: String) {
    preferences(context).edit()
      .putString("apiBaseUrl", apiBaseUrl.trimEnd('/'))
      .putString("accessToken", accessToken)
      .putString("deviceId", deviceId)
      .putBoolean("active", true)
      .putString("lastError", "")
      .apply()
  }

  fun deactivate(context: Context) {
    preferences(context).edit()
      .putBoolean("active", false)
      .putString("accessToken", "")
      .putString("lastError", "")
      .putInt("consecutiveFailures", 0)
      .putString("queue", "[]")
      .apply()
  }

  fun pauseWithError(context: Context, message: String) {
    preferences(context).edit()
      .putBoolean("active", false)
      .putString("lastError", message.take(500))
      .apply()
  }

  fun isActive(context: Context) = preferences(context).getBoolean("active", false)
  fun apiBaseUrl(context: Context) = preferences(context).getString("apiBaseUrl", "").orEmpty()
  fun accessToken(context: Context) = preferences(context).getString("accessToken", "").orEmpty()
  fun deviceId(context: Context) = preferences(context).getString("deviceId", "").orEmpty()
  fun lastLocationAt(context: Context) = preferences(context).getLong("lastLocationAt", 0L)
  fun lastUploadAt(context: Context) = preferences(context).getLong("lastUploadAt", 0L)
  fun lastServiceSignalAt(context: Context) = preferences(context).getLong("lastServiceSignalAt", 0L)
  fun lastError(context: Context) = preferences(context).getString("lastError", "").orEmpty()
  fun consecutiveFailures(context: Context) = preferences(context).getInt("consecutiveFailures", 0)

  fun markServiceSignal(context: Context, timestamp: Long = System.currentTimeMillis()) {
    preferences(context).edit().putLong("lastServiceSignalAt", timestamp).apply()
  }

  fun markLocation(context: Context, timestamp: Long) {
    preferences(context).edit()
      .putLong("lastLocationAt", timestamp)
      .putLong("lastServiceSignalAt", System.currentTimeMillis())
      .apply()
  }

  fun markUploadSuccess(context: Context) {
    preferences(context).edit()
      .putLong("lastUploadAt", System.currentTimeMillis())
      .putLong("lastServiceSignalAt", System.currentTimeMillis())
      .putString("lastError", "")
      .putInt("consecutiveFailures", 0)
      .apply()
  }

  fun markUploadFailure(context: Context, message: String) {
    val prefs = preferences(context)
    prefs.edit()
      .putString("lastError", message.take(500))
      .putInt("consecutiveFailures", (prefs.getInt("consecutiveFailures", 0) + 1).coerceAtMost(10_000))
      .apply()
  }

  private fun readQueueUnsafe(context: Context): JSONArray = try {
    JSONArray(preferences(context).getString("queue", "[]") ?: "[]")
  } catch (_: Exception) {
    JSONArray()
  }

  private fun saveQueueUnsafe(context: Context, queue: JSONArray) {
    preferences(context).edit().putString("queue", queue.toString()).commit()
  }

  fun appendPoint(context: Context, point: JSONObject) = synchronized(queueLock) {
    val current = readQueueUnsafe(context)
    val start = (current.length() - MAX_QUEUE_SIZE + 1).coerceAtLeast(0)
    val next = JSONArray()
    for (index in start until current.length()) next.put(current.get(index))
    next.put(point)
    saveQueueUnsafe(context, next)
  }

  fun queueDepth(context: Context) = synchronized(queueLock) {
    readQueueUnsafe(context).length()
  }

  fun readBatch(context: Context, limit: Int = 100) = synchronized(queueLock) {
    val queue = readQueueUnsafe(context)
    val batch = JSONArray()
    for (index in 0 until minOf(queue.length(), limit)) batch.put(queue.get(index))
    batch
  }

  fun removeAccepted(context: Context, batch: JSONArray) = synchronized(queueLock) {
    if (batch.length() == 0) return@synchronized
    val acceptedIds = HashSet<String>()
    for (index in 0 until batch.length()) {
      acceptedIds.add(batch.optJSONObject(index)?.optString("clientPointId").orEmpty())
    }
    val current = readQueueUnsafe(context)
    val next = JSONArray()
    for (index in 0 until current.length()) {
      val point = current.optJSONObject(index)
      if (point == null || !acceptedIds.contains(point.optString("clientPointId"))) next.put(current.get(index))
    }
    saveQueueUnsafe(context, next)
  }
}

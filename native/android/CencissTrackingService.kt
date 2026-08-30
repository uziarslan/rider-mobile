package com.cenciss.rider.tracking

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class CencissTrackingService : Service(), LocationListener {
  private lateinit var locationManager: LocationManager
  private lateinit var handler: Handler
  private lateinit var networkExecutor: ExecutorService
  private val networkWorkScheduled = AtomicBoolean(false)
  private var locationUpdatesStarted = false
  private var lastAcceptedLocationAt = 0L

  private val heartbeat = object : Runnable {
    override fun run() {
      if (!CencissTrackingStore.isActive(this@CencissTrackingService)) return
      CencissTrackingStore.markServiceSignal(this@CencissTrackingService)
      submitNetworkWork {
        flushLocationQueue()
        postHeartbeat()
      }
      handler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
    }
  }

  override fun onCreate() {
    super.onCreate()
    locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
    handler = Handler(Looper.getMainLooper())
    networkExecutor = Executors.newSingleThreadExecutor()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP || !CencissTrackingStore.isActive(this)) {
      shutdown()
      return START_NOT_STICKY
    }
    val permissionError = trackingPermissionError()
    if (permissionError != null) {
      CencissTrackingStore.pauseWithError(this, permissionError)
      Log.w(TAG, "Native foreground tracking not started: $permissionError")
      stopSelf(startId)
      return START_NOT_STICKY
    }
    try {
      startAsForegroundService()
    } catch (error: SecurityException) {
      val message = error.message ?: "Android did not allow the location foreground service to start."
      CencissTrackingStore.pauseWithError(this, message)
      Log.e(TAG, "Native foreground tracking could not enter foreground mode", error)
      stopSelf(startId)
      return START_NOT_STICKY
    }
    startLocationUpdates()
    Log.i(TAG, "Native foreground tracking started")
    CencissTrackingStore.markServiceSignal(this)
    handler.removeCallbacks(heartbeat)
    handler.post(heartbeat)
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onLocationChanged(location: Location) {
    if (!CencissTrackingStore.isActive(this)) return
    val recordedAt = if (location.time > 0) location.time else System.currentTimeMillis()
    if (recordedAt <= lastAcceptedLocationAt || recordedAt - lastAcceptedLocationAt < LOCATION_THROTTLE_MS) return
    lastAcceptedLocationAt = recordedAt
    CencissTrackingStore.appendPoint(this, locationPoint(location, recordedAt))
    CencissTrackingStore.markLocation(this, recordedAt)
    submitNetworkWork { flushLocationQueue() }
  }

  @Deprecated("Deprecated by Android")
  override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

  override fun onProviderEnabled(provider: String) = Unit

  override fun onProviderDisabled(provider: String) {
    CencissTrackingStore.markUploadFailure(this, "$provider location provider is disabled.")
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    // Deliberately keep the service active. START_STICKY asks Android to
    // recreate it even when a vendor removes the UI process with Recents.
    CencissTrackingStore.markServiceSignal(this)
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    if (locationUpdatesStarted) {
      try {
        locationManager.removeUpdates(this)
      } catch (_: Exception) {
        // The service is already shutting down.
      }
    }
    networkExecutor.shutdownNow()
    Log.i(TAG, "Native foreground tracking destroyed; active=${CencissTrackingStore.isActive(this)}")
    super.onDestroy()
  }

  private fun startAsForegroundService() {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL_ID) == null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Active delivery tracking", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Keeps rider GPS active while a duty shift is open."
          setShowBadge(false)
        },
      )
    }
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val pendingIntent = launchIntent?.let {
      PendingIntent.getActivity(
        this,
        0,
        it.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
    val notificationIcon = resources.getIdentifier("notification_icon", "drawable", packageName)
      .takeIf { it != 0 } ?: applicationInfo.icon
    val notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(notificationIcon)
      .setContentTitle("Cenciss Delivery · On duty")
      .setContentText("Your live delivery route is being recorded.")
      .setCategory(Notification.CATEGORY_SERVICE)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .setContentIntent(pendingIntent)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun trackingPermissionError(): String? {
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
      return "Precise location permission is not granted."
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED
    ) {
      return "Background location permission is not granted."
    }
    return null
  }

  private fun startLocationUpdates() {
    if (locationUpdatesStarted) return
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
      ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED
    ) {
      CencissTrackingStore.markUploadFailure(this, "Location permission is not granted.")
      return
    }
    var registered = false
    for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
      try {
        if (locationManager.isProviderEnabled(provider)) {
          locationManager.requestLocationUpdates(provider, LOCATION_INTERVAL_MS, 0f, this, Looper.getMainLooper())
          registered = true
        }
      } catch (error: Exception) {
        CencissTrackingStore.markUploadFailure(this, error.message ?: "Could not start $provider location updates.")
      }
    }
    locationUpdatesStarted = registered
    if (!registered) CencissTrackingStore.markUploadFailure(this, "No Android location provider is enabled.")
  }

  private fun locationPoint(location: Location, recordedAt: Long) = JSONObject().apply {
    put("clientPointId", "native-${UUID.randomUUID()}")
    put("latitude", location.latitude)
    put("longitude", location.longitude)
    put("accuracy", location.accuracy.toDouble())
    if (location.hasSpeed()) put("speed", location.speed.toDouble())
    if (location.hasBearing()) put("heading", location.bearing.toDouble())
    if (location.hasAltitude()) put("altitude", location.altitude)
    put("batteryLevel", batteryLevel())
    put("isMock", if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) location.isMock else location.isFromMockProvider)
    put("source", when (location.provider) {
      LocationManager.GPS_PROVIDER -> "gps"
      LocationManager.NETWORK_PROVIDER -> "network"
      LocationManager.PASSIVE_PROVIDER -> "passive"
      else -> "unknown"
    })
    put("recordedAt", isoTimestamp(recordedAt))
  }

  private fun flushLocationQueue() {
    while (CencissTrackingStore.isActive(this)) {
      val batch = CencissTrackingStore.readBatch(this)
      if (batch.length() == 0) return
      val body = baseTrackingPayload().apply { put("points", batch) }
      val response = post("/api/rider/locations/batch", body)
      if (response.status in 200..299) {
        CencissTrackingStore.removeAccepted(this, batch)
        CencissTrackingStore.markUploadSuccess(this)
        Log.d(TAG, "Uploaded ${batch.length()} background location point(s)")
      } else {
        handleUploadFailure(response, "Location upload failed")
        return
      }
    }
  }

  private fun postHeartbeat() {
    if (!CencissTrackingStore.isActive(this)) return
    val response = post("/api/rider/heartbeat", baseTrackingPayload())
    if (response.status in 200..299) {
      CencissTrackingStore.markServiceSignal(this)
    } else {
      handleUploadFailure(response, "Tracking heartbeat failed")
    }
  }

  private fun baseTrackingPayload() = JSONObject().apply {
    put("deviceId", CencissTrackingStore.deviceId(this@CencissTrackingService))
    put("batteryLevel", batteryLevel())
    put("trackingEnabled", true)
    put("trackingMode", "background")
    put("locationPermission", "precise")
    put("backgroundLocationGranted", true)
    val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
    put("batteryOptimizationEnabled", !powerManager.isIgnoringBatteryOptimizations(packageName))
    put("lowPowerMode", powerManager.isPowerSaveMode)
    put("trackingHealth", JSONObject().apply {
      put("mode", "background")
      put("queueDepth", CencissTrackingStore.queueDepth(this@CencissTrackingService))
      val lastLocationAt = CencissTrackingStore.lastLocationAt(this@CencissTrackingService)
      if (lastLocationAt > 0) put("taskCallbackAt", isoTimestamp(lastLocationAt))
      put("lastError", CencissTrackingStore.lastError(this@CencissTrackingService))
      put("consecutiveUploadFailures", CencissTrackingStore.consecutiveFailures(this@CencissTrackingService))
    })
  }

  private data class HttpResult(val status: Int, val body: String)

  private fun post(path: String, payload: JSONObject): HttpResult {
    val baseUrl = CencissTrackingStore.apiBaseUrl(this)
    val token = CencissTrackingStore.accessToken(this)
    if (baseUrl.isBlank() || token.isBlank()) return HttpResult(0, "Tracking credentials are missing.")
    var connection: HttpURLConnection? = null
    return try {
      connection = URL("$baseUrl$path").openConnection() as HttpURLConnection
      connection.requestMethod = "POST"
      connection.connectTimeout = NETWORK_TIMEOUT_MS
      connection.readTimeout = NETWORK_TIMEOUT_MS
      connection.doOutput = true
      connection.setRequestProperty("Content-Type", "application/json")
      connection.setRequestProperty("Authorization", "Bearer $token")
      connection.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
      val status = connection.responseCode
      val input = if (status in 200..399) connection.inputStream else connection.errorStream
      val responseBody = input?.use { stream ->
        BufferedReader(InputStreamReader(stream)).use { reader -> reader.readText() }
      }.orEmpty()
      HttpResult(status, responseBody)
    } catch (error: Exception) {
      HttpResult(0, error.message ?: "The tracking server request failed.")
    } finally {
      connection?.disconnect()
    }
  }

  private fun handleUploadFailure(response: HttpResult, fallback: String) {
    val message = try {
      JSONObject(response.body).optString("message").ifBlank { "$fallback (${response.status})." }
    } catch (_: Exception) {
      response.body.ifBlank { "$fallback (${response.status})." }
    }
    CencissTrackingStore.markUploadFailure(this, message)
    Log.w(TAG, "Background tracking request failed: $message")
    if (response.status == 403 || (response.status == 409 && response.body.contains("NO_ACTIVE_SHIFT"))) {
      CencissTrackingStore.deactivate(this)
      handler.post { shutdown() }
    }
  }

  private fun submitNetworkWork(work: () -> Unit) {
    if (networkExecutor.isShutdown || !networkWorkScheduled.compareAndSet(false, true)) return
    networkExecutor.execute {
      val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
      val wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:tracking-upload")
      try {
        wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS)
        work()
      } finally {
        if (wakeLock.isHeld) wakeLock.release()
        networkWorkScheduled.set(false)
      }
    }
  }

  private fun batteryLevel(): Int {
    val manager = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
    return manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).coerceIn(0, 100)
  }

  private fun shutdown() {
    handler.removeCallbacksAndMessages(null)
    if (locationUpdatesStarted) {
      try {
        locationManager.removeUpdates(this)
      } catch (_: Exception) {
        // Best effort.
      }
      locationUpdatesStarted = false
    }
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  private fun isoTimestamp(epochMillis: Long) =
    java.time.Instant.ofEpochMilli(epochMillis).toString()

  companion object {
    const val ACTION_START = "com.cenciss.rider.tracking.START"
    const val ACTION_STOP = "com.cenciss.rider.tracking.STOP"
    private const val CHANNEL_ID = "cenciss-active-tracking"
    private const val NOTIFICATION_ID = 481757
    private const val LOCATION_INTERVAL_MS = 10_000L
    private const val LOCATION_THROTTLE_MS = 8_000L
    private const val HEARTBEAT_INTERVAL_MS = 30_000L
    private const val NETWORK_TIMEOUT_MS = 15_000
    private const val WAKE_LOCK_TIMEOUT_MS = 45_000L
    private const val TAG = "CencissTracking"
  }
}

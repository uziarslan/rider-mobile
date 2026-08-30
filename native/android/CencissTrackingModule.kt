package com.cenciss.rider.tracking

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap

class CencissTrackingModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context) {

  override fun getName() = "CencissBackgroundTracking"

  @ReactMethod
  fun start(options: ReadableMap, promise: Promise) {
    try {
      val apiBaseUrl = options.getString("apiBaseUrl").orEmpty().trim()
      val accessToken = options.getString("accessToken").orEmpty().trim()
      val deviceId = options.getString("deviceId").orEmpty().trim()
      if (!(apiBaseUrl.startsWith("https://") || apiBaseUrl.startsWith("http://"))) {
        throw IllegalArgumentException("A valid tracking server URL is required.")
      }
      if (accessToken.isBlank() || deviceId.isBlank()) {
        throw IllegalArgumentException("The rider session and device ID are required.")
      }
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
        val message = "Precise location permission is required before tracking can start."
        CencissTrackingStore.pauseWithError(context, message)
        throw SecurityException(message)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED
      ) {
        val message = "Background location permission is required before tracking can start."
        CencissTrackingStore.pauseWithError(context, message)
        throw SecurityException(message)
      }
      CencissTrackingStore.configure(context, apiBaseUrl, accessToken, deviceId)
      val intent = Intent(context, CencissTrackingService::class.java).setAction(CencissTrackingService.ACTION_START)
      ContextCompat.startForegroundService(context, intent)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("TRACKING_START_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      CencissTrackingStore.deactivate(context)
      context.startService(
        Intent(context, CencissTrackingService::class.java).setAction(CencissTrackingService.ACTION_STOP),
      )
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("TRACKING_STOP_FAILED", error.message, error)
    }
  }

  @ReactMethod
  fun getStatus(promise: Promise) {
    try {
      val result = Arguments.createMap().apply {
        putBoolean("active", CencissTrackingStore.isActive(context))
        putDouble("lastLocationAt", CencissTrackingStore.lastLocationAt(context).toDouble())
        putDouble("lastUploadAt", CencissTrackingStore.lastUploadAt(context).toDouble())
        putDouble("lastServiceSignalAt", CencissTrackingStore.lastServiceSignalAt(context).toDouble())
        putInt("queueDepth", CencissTrackingStore.queueDepth(context))
        putInt("consecutiveFailures", CencissTrackingStore.consecutiveFailures(context))
        putString("lastError", CencissTrackingStore.lastError(context))
      }
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("TRACKING_STATUS_FAILED", error.message, error)
    }
  }
}

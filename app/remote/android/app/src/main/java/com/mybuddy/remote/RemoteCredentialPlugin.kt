package com.mybuddy.remote

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@CapacitorPlugin(name = "RemoteCredential")
class RemoteCredentialPlugin : Plugin() {

    companion object {
        private const val KEY_ALIAS = "mybuddy_remote_device_credential"
        private const val PREFS = "mybuddy_remote_secure"
        private const val CIPHER_TEXT = "ciphertext"
        private const val IV = "iv"
        // 多电脑配置必须与旧版单条凭据分开存：否则 saveToken 会把整份服务器列表覆盖掉
        private const val CONFIG_CIPHER_TEXT = "config_ciphertext"
        private const val CONFIG_IV = "config_iv"
        private const val INSTALLATION_ID = "installation_id"
        private const val ANDROID_KEY_STORE = "AndroidKeyStore"
        private const val AES_GCM_NO_PADDING = "AES/GCM/NoPadding"
        private const val GCM_TAG_LENGTH = 128
    }

    @PluginMethod
    fun saveConfig(call: PluginCall) {
        val configJson = call.getString("configJson")
        if (configJson == null) {
            call.reject("configJson is required")
            return
        }

        try {
            val payload = JSONObject().apply {
                put("configJson", configJson)
            }
            val cipher = Cipher.getInstance(AES_GCM_NO_PADDING).apply {
                init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            }
            val encrypted = cipher.doFinal(payload.toString().toByteArray(StandardCharsets.UTF_8))
            preferences.edit()
                .putString(CONFIG_CIPHER_TEXT, Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .putString(CONFIG_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .apply()
            call.resolve()
        } catch (error: Exception) {
            call.reject("Unable to protect remote credential", error)
        }
    }

    @PluginMethod
    fun loadConfig(call: PluginCall) {
        // 1) 新版独立键：多电脑配置的唯一权威来源
        readPayload(CONFIG_CIPHER_TEXT, CONFIG_IV)?.let { payload ->
            val result = JSObject()
            if (payload.has("configJson")) result.put("configJson", payload.optString("configJson"))
            call.resolve(result)
            return
        }

        // 2) 旧版键里的 configJson（0.1.54 前后写入过 config 的那批安装）：读出来顺手迁移到新键
        val legacy = readPayload(CIPHER_TEXT, IV)
        if (legacy == null) {
            call.resolve(JSObject())
            return
        }
        val result = JSObject()
        if (legacy.has("configJson")) {
            result.put("configJson", legacy.optString("configJson"))
            writePayload(CONFIG_CIPHER_TEXT, CONFIG_IV, legacy)
        } else if (legacy.has("baseUrl") && legacy.has("deviceToken")) {
            // 3) 更早的单条凭据
            result.put("legacyBaseUrl", legacy.optString("baseUrl"))
            result.put("legacyDeviceToken", legacy.optString("deviceToken"))
        }
        call.resolve(result)
    }

    /** 读并解密某个键位的 payload；缺失或损坏返回 null（损坏时清掉该键位，避免永久卡死） */
    private fun readPayload(cipherKey: String, ivKey: String): JSONObject? {
        val encrypted = preferences.getString(cipherKey, null)
        val iv = preferences.getString(ivKey, null)
        if (encrypted.isNullOrEmpty() || iv.isNullOrEmpty()) return null
        return try {
            val cipher = Cipher.getInstance(AES_GCM_NO_PADDING).apply {
                init(
                    Cipher.DECRYPT_MODE,
                    getOrCreateKey(),
                    GCMParameterSpec(GCM_TAG_LENGTH, Base64.decode(iv, Base64.NO_WRAP))
                )
            }
            val plain = cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP))
            JSONObject(String(plain, StandardCharsets.UTF_8))
        } catch (error: Exception) {
            preferences.edit().remove(cipherKey).remove(ivKey).apply()
            null
        }
    }

    private fun writePayload(cipherKey: String, ivKey: String, payload: JSONObject) {
        try {
            val cipher = Cipher.getInstance(AES_GCM_NO_PADDING).apply {
                init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            }
            val encrypted = cipher.doFinal(payload.toString().toByteArray(StandardCharsets.UTF_8))
            preferences.edit()
                .putString(cipherKey, Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .putString(ivKey, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .apply()
        } catch (error: Exception) {
            // 迁移失败不影响本次读取
        }
    }

    @PluginMethod
    fun saveToken(call: PluginCall) {
        val baseUrl = call.getString("baseUrl")
        val deviceToken = call.getString("deviceToken")
        if (baseUrl.isNullOrEmpty() || deviceToken.isNullOrEmpty()) {
            call.reject("baseUrl and deviceToken are required")
            return
        }

        try {
            val payload = JSONObject().apply {
                put("baseUrl", baseUrl)
                put("deviceToken", deviceToken)
            }
            val cipher = Cipher.getInstance(AES_GCM_NO_PADDING).apply {
                init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            }
            val encrypted = cipher.doFinal(payload.toString().toByteArray(StandardCharsets.UTF_8))
            preferences.edit()
                .putString(CIPHER_TEXT, Base64.encodeToString(encrypted, Base64.NO_WRAP))
                .putString(IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .apply()
            call.resolve()
        } catch (error: Exception) {
            call.reject("Unable to protect remote credential", error)
        }
    }

    @PluginMethod
    fun loadToken(call: PluginCall) {
        val encrypted = preferences.getString(CIPHER_TEXT, null)
        val iv = preferences.getString(IV, null)
        if (encrypted.isNullOrEmpty() || iv.isNullOrEmpty()) {
            call.resolve(JSObject())
            return
        }

        try {
            val cipher = Cipher.getInstance(AES_GCM_NO_PADDING).apply {
                init(
                    Cipher.DECRYPT_MODE,
                    getOrCreateKey(),
                    GCMParameterSpec(GCM_TAG_LENGTH, Base64.decode(iv, Base64.NO_WRAP))
                )
            }
            val plain = cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP))
            val payload = JSONObject(String(plain, StandardCharsets.UTF_8))
            val result = JSObject().apply {
                put("baseUrl", payload.optString("baseUrl"))
                put("deviceToken", payload.optString("deviceToken"))
            }
            call.resolve(result)
        } catch (error: Exception) {
            preferences.edit().remove(CIPHER_TEXT).remove(IV).apply()
            call.reject("Unable to read remote credential", error)
        }
    }

    @PluginMethod
    fun clearToken(call: PluginCall) {
        // 只清连接凭证，不清 installationId；同一安装实例重新配对时必须保持设备身份稳定。
        preferences.edit().remove(CIPHER_TEXT).remove(IV).apply()
        call.resolve()
    }

    @PluginMethod
    fun getInstallationId(call: PluginCall) {
        var installationId = preferences.getString(INSTALLATION_ID, null)
        if (installationId.isNullOrBlank()) {
            installationId = UUID.randomUUID().toString()
            preferences.edit().putString(INSTALLATION_ID, installationId).apply()
        }
        call.resolve(JSObject().apply { put("installationId", installationId) })
    }

    private val preferences: SharedPreferences
        get() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    @Synchronized
    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return keyStore.getKey(KEY_ALIAS, null) as SecretKey
        }

        val keyGenerator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE)
        val keyGenSpec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build()

        keyGenerator.init(keyGenSpec)
        return keyGenerator.generateKey()
    }
}

package com.mybuddy.remote

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.nio.charset.StandardCharsets
import java.util.Collections
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

@CapacitorPlugin(name = "RemoteDiscovery")
class RemoteDiscoveryPlugin : Plugin() {
    companion object {
        private const val SERVICE_TYPE = "_mybuddy-remote._tcp."
        private const val DISCOVERY_PORT = 3353
        private const val DISCOVERY_MAGIC = "MYBUDDY_DISCOVER_V1"
        private const val RESPONSE_MAGIC = "MYBUDDY_DISCOVERY_RESPONSE_V1"
    }

    private data class Candidate(
        val name: String,
        val hostname: String,
        val host: String,
        val port: Int,
        val source: String,
    ) {
        val url: String get() = "http://$host:$port"
    }

    private val executor = Executors.newSingleThreadExecutor()

    @PluginMethod
    fun discover(call: PluginCall) {
        val totalTimeoutMs = (call.getInt("timeoutMs") ?: 3200).coerceIn(1200, 8000)
        executor.execute {
            val candidates = ConcurrentHashMap<String, Candidate>()
            var mdnsError: String? = null
            var udpError: String? = null
            val appContext = context.applicationContext
            val wifiManager = appContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val multicastLock = try {
                wifiManager?.createMulticastLock("mybuddy_remote_discovery")?.apply {
                    setReferenceCounted(false)
                    acquire()
                }
            } catch (_: Exception) {
                null
            }

            try {
                mdnsError = discoverMdns(candidates, (totalTimeoutMs * 0.55).toLong().coerceAtLeast(900))
                if (candidates.isEmpty()) {
                    udpError = discoverUdp(candidates, (totalTimeoutMs * 0.45).toLong().coerceAtLeast(900))
                }
            } finally {
                try { multicastLock?.release() } catch (_: Exception) { }
            }

            val ordered = candidates.values
                .sortedWith(compareBy<Candidate> { if (it.source == "mdns") 0 else 1 }.thenBy { it.hostname }.thenBy { it.host })
            val devices = JSArray()
            for (candidate in ordered) {
                devices.put(JSObject().apply {
                    put("name", candidate.name)
                    put("hostname", candidate.hostname)
                    put("host", candidate.host)
                    put("port", candidate.port)
                    put("url", candidate.url)
                    put("source", candidate.source)
                })
            }
            val result = JSObject().apply {
                put("devices", devices)
                if (mdnsError != null) put("mdnsError", mdnsError)
                if (udpError != null) put("udpError", udpError)
            }
            Handler(Looper.getMainLooper()).post { call.resolve(result) }
        }
    }

    private fun discoverMdns(candidates: ConcurrentHashMap<String, Candidate>, timeoutMs: Long): String? {
        val nsdManager = context.getSystemService(Context.NSD_SERVICE) as? NsdManager
            ?: return "NsdManager unavailable"
        val finished = CountDownLatch(1)
        val resolving = AtomicBoolean(false)
        var error: String? = null

        lateinit var listener: NsdManager.DiscoveryListener
        listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                if (!serviceInfo.serviceType.startsWith("_mybuddy-remote._tcp")) return
                if (!resolving.compareAndSet(false, true)) return
                @Suppress("DEPRECATION")
                nsdManager.resolveService(serviceInfo, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                        resolving.set(false)
                    }

                    override fun onServiceResolved(resolved: NsdServiceInfo) {
                        try {
                            val host = resolved.host?.hostAddress ?: return
                            if (!isPrivateIpv4(host)) return
                            val service = resolved.attributes["service"]?.toString(StandardCharsets.UTF_8)
                            if (!service.isNullOrBlank() && service != "mybuddy-remote") return
                            val hostname = resolved.attributes["hostname"]?.toString(StandardCharsets.UTF_8)
                                ?.takeIf { it.isNotBlank() }
                                ?: resolved.serviceName.removePrefix("MyBuddy ").trim().ifBlank { host }
                            val name = resolved.serviceName.ifBlank { "MyBuddy $hostname" }
                            if (resolved.port in 1..65535) {
                                candidates["$host:${resolved.port}"] = Candidate(name, hostname, host, resolved.port, "mdns")
                            }
                        } finally {
                            resolving.set(false)
                        }
                    }
                })
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) = Unit

            override fun onDiscoveryStopped(serviceType: String) {
                finished.countDown()
            }

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                error = "mDNS start failed: $errorCode"
                try { nsdManager.stopServiceDiscovery(this) } catch (_: Exception) { }
                finished.countDown()
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                error = "mDNS stop failed: $errorCode"
                finished.countDown()
            }
        }

        Handler(Looper.getMainLooper()).post {
            try {
                nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
                Handler(Looper.getMainLooper()).postDelayed({
                    try { nsdManager.stopServiceDiscovery(listener) } catch (_: Exception) { finished.countDown() }
                }, timeoutMs)
            } catch (e: Exception) {
                error = e.message ?: e.javaClass.simpleName
                finished.countDown()
            }
        }
        finished.await(timeoutMs + 600, TimeUnit.MILLISECONDS)
        Thread.sleep(120)
        return error
    }

    private fun discoverUdp(candidates: ConcurrentHashMap<String, Candidate>, timeoutMs: Long): String? {
        return try {
            DatagramSocket().use { socket ->
                socket.broadcast = true
                socket.soTimeout = 240
                val nonce = UUID.randomUUID().toString()
                val request = JSONObject().apply {
                    put("type", DISCOVERY_MAGIC)
                    put("nonce", nonce)
                }.toString().toByteArray(StandardCharsets.UTF_8)

                for (target in broadcastAddresses()) {
                    try { socket.send(DatagramPacket(request, request.size, target, DISCOVERY_PORT)) } catch (_: Exception) { }
                }

                val deadline = System.currentTimeMillis() + timeoutMs
                val buffer = ByteArray(8192)
                while (System.currentTimeMillis() < deadline) {
                    try {
                        val packet = DatagramPacket(buffer, buffer.size)
                        socket.receive(packet)
                        val response = JSONObject(String(packet.data, packet.offset, packet.length, StandardCharsets.UTF_8))
                        if (response.optString("type") != RESPONSE_MAGIC || response.optString("service") != "mybuddy-remote") continue
                        if (response.optString("nonce").isNotBlank() && response.optString("nonce") != nonce) continue
                        val port = response.optInt("port", 0)
                        val host = packet.address.hostAddress ?: continue
                        if (port !in 1..65535 || !isPrivateIpv4(host)) continue
                        val hostname = response.optString("hostname").ifBlank { host }
                        val name = response.optString("name").ifBlank { "MyBuddy $hostname" }
                        candidates["$host:$port"] = Candidate(name, hostname, host, port, "udp")
                    } catch (_: SocketTimeoutException) {
                        // Keep receiving until the overall deadline expires.
                    }
                }
            }
            null
        } catch (e: Exception) {
            e.message ?: e.javaClass.simpleName
        }
    }

    private fun broadcastAddresses(): Set<InetAddress> {
        val result = linkedSetOf<InetAddress>()
        try { result.add(InetAddress.getByName("255.255.255.255")) } catch (_: Exception) { }
        try {
            for (network in Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!network.isUp || network.isLoopback || network.isVirtual) continue
                for (address in network.interfaceAddresses) {
                    val broadcast = address.broadcast
                    if (broadcast is Inet4Address) result.add(broadcast)
                }
            }
        } catch (_: Exception) { }
        return result
    }

    private fun isPrivateIpv4(value: String): Boolean {
        val parts = value.split('.').mapNotNull { it.toIntOrNull() }
        if (parts.size != 4 || parts.any { it !in 0..255 }) return false
        val a = parts[0]
        val b = parts[1]
        return a == 10 || (a == 172 && b in 16..31) || (a == 192 && b == 168)
    }
}

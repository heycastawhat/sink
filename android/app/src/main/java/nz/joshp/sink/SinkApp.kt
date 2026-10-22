package nz.joshp.sink

import android.app.Application
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import okhttp3.Interceptor
import nz.joshp.sink.capture.ScreenshotWatcher
import nz.joshp.sink.reminders.ReminderSync
import nz.joshp.sink.reminders.Reminders
import nz.joshp.sink.data.Http
import nz.joshp.sink.data.Session
import nz.joshp.sink.data.Settings

class SinkApp : Application(), SingletonImageLoader.Factory {
    val settings by lazy { Settings(this) }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Volatile
    var session: Session? = null
        private set

    override fun onCreate() {
        super.onCreate()
        Reminders.createChannels(this)
        ReminderSync.schedulePeriodic(this)
        scope.launch {
            settings.session.collect { session = it }
        }
        scope.launch {
            if (settings.autoImport.first() && ScreenshotWatcher.hasPermission(this@SinkApp)) {
                ScreenshotWatcher.arm(this@SinkApp)
            }
        }
    }

    // Thumbnails need the bearer token, but only when going to our own server.
    override fun newImageLoader(context: PlatformContext): ImageLoader {
        val authed = Http.client.newBuilder().addInterceptor(Interceptor { chain ->
            val s = session
            val req = chain.request()
            if (s != null && req.url.toString().startsWith(s.serverUrl)) {
                chain.proceed(req.newBuilder().header("Authorization", "Bearer ${s.token}").build())
            } else {
                chain.proceed(req)
            }
        }).build()
        return ImageLoader.Builder(context)
            .components { add(OkHttpNetworkFetcherFactory(callFactory = { authed })) }
            .build()
    }
}

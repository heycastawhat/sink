package nz.joshp.sink.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import nz.joshp.sink.R
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.LoadingIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import nz.joshp.sink.data.SignIn
import nz.joshp.sink.data.Settings
import nz.joshp.sink.data.normalizeServerUrl

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun LoginScreen(settings: Settings, initialServer: String?, busy: Boolean, error: String?) {
    var server by rememberSaveable(initialServer) { mutableStateOf(initialServer ?: "") }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()


    fun submit() {
        if (busy || server.isBlank()) return
        scope.launch { SignIn.start(context, settings, normalizeServerUrl(server)) }
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.surface)
            .imePadding()
            .verticalScroll(rememberScrollState()),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            Modifier
                .widthIn(max = 420.dp)
                .padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Spacer(Modifier.height(48.dp))
            // The app icon: the launcher foreground on its background colour (the adaptive mipmap can't be painted).
            Box(
                Modifier
                    .size(104.dp)
                    .clip(RoundedCornerShape(28))
                    .background(Color(0xFF4F378B)),
            ) {
                Image(painterResource(R.drawable.ic_launcher_foreground), null, Modifier.fillMaxSize())
            }
            Spacer(Modifier.height(8.dp))
            // Not inside a Surface, so content colour has to be explicit (it would default to black).
            Text("Sink", style = MaterialTheme.typography.displaySmall, color = MaterialTheme.colorScheme.onSurface)
            Text(
                "Everything but the kitchen sink. Well, including it.",
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(16.dp))
            OutlinedTextField(
                value = server,
                onValueChange = { server = it },
                label = { Text("Server") },
                placeholder = { Text("sink.example.com") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                keyboardActions = KeyboardActions(onGo = { submit() }),
                isError = error != null,
                supportingText = (error ?: cleartextWarning(server))?.let { { Text(it) } },
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(4.dp))
            Button(
                onClick = ::submit,
                enabled = !busy && server.isNotBlank(),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
            ) {
                if (busy) LoadingIndicator(Modifier.size(32.dp), color = MaterialTheme.colorScheme.onPrimary)
                else Text("Sign in", style = MaterialTheme.typography.titleMedium)
            }
        }
    }
}

/**
 * A warning for an http:// address that isn't on the local network: the sign-in token would cross the internet
 * unencrypted. Plain http stays allowed for a LAN or Tailscale server before it has a certificate.
 */
private fun cleartextWarning(server: String): String? {
    val url = server.trim().lowercase()
    if (!url.startsWith("http://")) return null
    val host = url.removePrefix("http://").substringBefore('/').substringBefore(':')
    val local = host == "localhost" || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".ts.net") ||
        Regex("""^(127|10)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.""").containsMatchIn(host)
    return if (local) null else "Not encrypted: anyone on this network could see your sign-in. Use https:// if you can."
}

import org.gradle.api.file.DirectoryProperty

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "nz.joshp.sink"
    compileSdk = 37

    defaultConfig {
        applicationId = "nz.joshp.sink"
        minSdk = 30
        targetSdk = 36
        // CI sets these from the release tag (v1.2.3 -> 1.2.3, code from the run number).
        versionCode = providers.environmentVariable("SINK_VERSION_CODE").orNull?.toInt() ?: 1
        versionName = providers.environmentVariable("SINK_VERSION_NAME").orNull ?: "0.1.0-dev"
    }

    // Release key from the environment (GitHub Actions secrets). Without it, release builds use the debug key,
    // which is fine for trying a build locally but can't update an APK from a GitHub release.
    val keystore = providers.environmentVariable("SINK_KEYSTORE_FILE").orNull
    signingConfigs {
        if (keystore != null) {
            create("release") {
                storeFile = file(keystore)
                storePassword = providers.environmentVariable("SINK_KEYSTORE_PASSWORD").get()
                keyAlias = providers.environmentVariable("SINK_KEY_ALIAS").get()
                keyPassword = providers.environmentVariable("SINK_KEY_PASSWORD").get()
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        // BuildConfig.DEBUG gates the emulator sign-in shortcut.
        buildConfig = true
    }
}

/**
 * The note editor is the web app's CodeMirror page (web/dist/editor.html), shipped inside the APK so notes edit
 * offline. The main app's and the board's bundles aren't needed here.
 */
abstract class CopyEditorTask : DefaultTask() {
    @get:Internal
    abstract val webDist: DirectoryProperty

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    val distFiles get() = webDist.asFileTree.matching { include("editor.html", "assets/**") }

    @get:OutputDirectory
    abstract val outputDir: DirectoryProperty

    @TaskAction
    fun copy() {
        val dist = webDist.get().asFile
        if (!dist.resolve("editor.html").isFile) {
            throw GradleException("${dist.resolve("editor.html")} is missing: run `bun run build` in web/ first")
        }
        val out = outputDir.get().asFile.resolve("web")
        out.deleteRecursively()
        dist.resolve("editor.html").copyTo(out.resolve("editor.html"))
        // Only what the editor page loads, following imports from file to file.
        val assets = dist.resolve("assets")
        val ref = Regex("""[\"'(/]([\w.-]+\.(?:js|css))[\"')]""")
        val seen = mutableSetOf<String>()
        val queue = ArrayDeque(ref.findAll(dist.resolve("editor.html").readText()).map { it.groupValues[1] }.toList())
        while (queue.isNotEmpty()) {
            val name = queue.removeFirst()
            val file = assets.resolve(name)
            if (!seen.add(name) || !file.isFile) continue
            file.copyTo(out.resolve("assets/$name"))
            if (name.endsWith(".js")) queue.addAll(ref.findAll(file.readText()).map { it.groupValues[1] })
        }
    }
}

val copyEditor = tasks.register<CopyEditorTask>("copyEditor") {
    webDist.set(rootProject.layout.projectDirectory.dir("../web/dist"))
    outputDir.set(layout.buildDirectory.dir("generated/editorAssets"))
}

androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyEditor, CopyEditorTask::outputDir)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.work)
    implementation(libs.androidx.datastore)
    implementation(libs.androidx.browser)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.compose.icons.extended)
    debugImplementation(libs.compose.ui.tooling)

    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.webkit)
}

-keepattributes *Annotation*, InnerClasses
-keepclassmembers @kotlinx.serialization.Serializable class ** { *; }

# The note editor WebView calls these by name from JavaScript.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# ML Kit (the QR scanner) builds its registrars by reflection from manifest names; R8 strips their constructors.
-keep class * implements com.google.firebase.components.ComponentRegistrar { <init>(); }

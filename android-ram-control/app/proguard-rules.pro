-keepattributes *Annotation*,JavascriptInterface
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keep class com.ramcontrol.owner.** { *; }
-dontwarn kotlin.**
-dontwarn **

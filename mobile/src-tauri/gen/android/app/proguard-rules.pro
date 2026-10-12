# Release shrinking rules for the mobile companion.
# Native, camera and barcode code is reached through reflection, JNI and binder
# interfaces that R8 cannot see. Stripping or renaming it crashed the app the
# moment the QR scanner started or delivered a result, so keep it intact.

-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod,Exceptions,SourceFile,LineNumberTable

# Tauri runtime and plugins (commands, invoke args and callbacks are looked up by name).
-keep class app.tauri.** { *; }
-keep interface app.tauri.** { *; }

# QR scanner: plugin, camera pipeline and the on-device barcode model client.
-keep class androidx.camera.** { *; }
-keep class com.google.mlkit.** { *; }
-keep class com.google.android.gms.vision.** { *; }
-keep class com.google.android.gms.internal.mlkit_vision_barcode** { *; }
-keep class com.google.android.gms.internal.mlkit_vision_common.** { *; }
-keep class com.google.android.gms.internal.mlkit_common.** { *; }
-keep class com.google.android.gms.dynamite.** { *; }
-keep class com.google.android.gms.common.** { *; }
-keep class * implements android.os.Parcelable { public static final ** CREATOR; }
-keep class * extends android.os.Binder { *; }
-keep class * implements android.os.IInterface { *; }
-dontwarn com.google.android.gms.**
-dontwarn com.google.mlkit.**

# JSON (invoke args and results are mapped by field name).
-keep class com.fasterxml.jackson.** { *; }
-dontwarn com.fasterxml.jackson.**
-keepclassmembers class org.json.** { *; }

# R8 rules for release (minification is on). Add rules for your own package here only if R8 breaks it.

# kotlinx.serialization: keep generated serializers and companions of @Serializable classes.
-keepattributes *Annotation*, InnerClasses, Signature, EnclosingMethod
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *** Companion; }
-keepclasseswithmembers class kotlinx.serialization.json.** { kotlinx.serialization.KSerializer serializer(...); }
-if @kotlinx.serialization.Serializable class dev.aethernet.linkpearl.**
-keepclassmembers class <1> { static <1>$Companion Companion; }
-if @kotlinx.serialization.Serializable class dev.aethernet.linkpearl.** { static **$* *; }
-keepclassmembers class <2>$<3> { kotlinx.serialization.KSerializer serializer(...); }
-if @kotlinx.serialization.Serializable class dev.aethernet.linkpearl.** { public static ** INSTANCE; }
-keepclassmembers class <1> { public static <1> INSTANCE; kotlinx.serialization.KSerializer serializer(...); }
-keep,includedescriptorclasses class dev.aethernet.linkpearl.**$$serializer { *; }

# OkHttp 5 / Okio ship their own consumer rules; these only silence optional-platform warnings.
-dontwarn org.bouncycastle.**
-dontwarn org.conscrypt.**
-dontwarn org.openjsse.**

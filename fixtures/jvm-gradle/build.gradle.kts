plugins {
    id("com.android.application") version "8.3.0"
}

android {
    namespace = "com.acme.app"
    compileSdk = 34
}

dependencies {
    implementation("androidx.compose.ui:ui:1.6.7")
    testImplementation("junit:junit:4.13.2")
}

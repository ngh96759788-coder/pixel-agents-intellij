plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.25"
    id("org.jetbrains.intellij.platform") version "2.2.1"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        create(
            providers.gradleProperty("platformType").get(),
            providers.gradleProperty("platformVersion").get()
        )
        bundledPlugin("org.jetbrains.plugins.terminal")
        testFramework(org.jetbrains.intellij.platform.gradle.TestFrameworkType.Platform)
    }
    implementation("com.google.code.gson:gson:2.11.0")

    testImplementation("org.junit.jupiter:junit-jupiter:5.10.2")
    testImplementation("org.opentest4j:opentest4j:1.3.0")
    testRuntimeOnly("junit:junit:4.13.2")
}

tasks.test {
    useJUnitPlatform()
}

kotlin {
    jvmToolchain(providers.gradleProperty("javaVersion").get().toInt())
}

intellijPlatform {
    pluginConfiguration {
        name = providers.gradleProperty("pluginName")
        version = providers.gradleProperty("pluginVersion")
        ideaVersion {
            sinceBuild = providers.gradleProperty("sinceBuild")
            untilBuild = providers.gradleProperty("untilBuild")
        }
    }

    publishing {
        token = providers.environmentVariable("PUBLISH_TOKEN")
    }

    signing {
        certificateChainFile = providers.environmentVariable("SIGNING_CERTIFICATE_CHAIN")
            .map { file(it) }
        privateKeyFile = providers.environmentVariable("SIGNING_PRIVATE_KEY")
            .map { file(it) }
        password = providers.environmentVariable("SIGNING_PASSWORD")
    }

    // Plugin Verifier — catches deprecated/removed API usage against target IDEs
    // before publishing. Run via `./gradlew verifyPlugin`. Failure level is set
    // to NOT_DYNAMIC so deprecation warnings stay informational and don't fail
    // the build, while structural / scheduled-for-removal issues do fail.
    pluginVerification {
        ides {
            recommended()
        }
        failureLevel = listOf(
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.COMPATIBILITY_PROBLEMS,
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.INVALID_PLUGIN,
        )
    }
}

// Copy webview build output into plugin resources
val copyWebview by tasks.registering(Copy::class) {
    from(file("dist/webview"))
    into(layout.buildDirectory.dir("resources/main/webview"))
}

tasks.named("processResources") {
    dependsOn(copyWebview)
}

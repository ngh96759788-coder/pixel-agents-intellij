import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "1.9.25"
    id("org.jetbrains.intellij.platform") version "2.9.0"
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
            // A blank `untilBuild` property drops the attribute entirely, which is
            // what keeps the plugin listed on new IDE releases. `provider { null }`
            // is the documented way to unset it; assigning the property directly
            // would fall back to the plugin's default upper bound instead.
            val untilBuildProperty = providers.gradleProperty("untilBuild").getOrElse("").trim()
            untilBuild = if (untilBuildProperty.isEmpty()) {
                provider { null }
            } else {
                provider { untilBuildProperty }
            }
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
    // before publishing. Run via `./gradlew verifyPlugin`. Deprecated usages stay
    // informational: the two we have (FileSaverDescriptor, createShellWidget)
    // have no replacement that also exists in 2024.2 (sinceBuild 242). What does
    // fail is anything that turns into breakage later — an API JetBrains marks
    // scheduled-for-removal, internal, override-only or non-extendable — so the
    // release stops here instead of the Marketplace verification mail being the
    // first notice.
    pluginVerification {
        ides {
            // Explicit list rather than `recommended()`: that helper resolves
            // Community only, and it offers ideaIC-2025.3, which JetBrains never
            // published as a downloadable distribution (404) — so the whole task
            // failed to resolve. Community ends at 2025.2.6; 261+ ships as
            // Ultimate only, which is where the users hitting build 262 are.
            // IntellijIdeaCommunity is deprecated as a target but is still the only
            // way to check the 242/252 floor the plugin claims to support.
            @Suppress("DEPRECATION")
            create(IntelliJPlatformType.IntellijIdeaCommunity, "2024.2.6")  // sinceBuild floor
            @Suppress("DEPRECATION")
            create(IntelliJPlatformType.IntellijIdeaCommunity, "2025.2.6")  // last Community
            create(IntelliJPlatformType.IntellijIdea, "2026.1.4")
            create(IntelliJPlatformType.IntellijIdea, "2026.2")             // current
        }
        failureLevel = listOf(
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.COMPATIBILITY_PROBLEMS,
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.INVALID_PLUGIN,
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.SCHEDULED_FOR_REMOVAL_API_USAGES,
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.INTERNAL_API_USAGES,
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.OVERRIDE_ONLY_API_USAGES,
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.NON_EXTENDABLE_API_USAGES,
        )
    }
}

// Sync (not Copy) so bundles from earlier builds are removed instead of
// piling up in the plugin jar: every Vite build emits a new hashed index-*.js.
val copyWebview by tasks.registering(Sync::class) {
    from(file("dist/webview"))
    into(layout.buildDirectory.dir("resources/main/webview"))
}

tasks.named("processResources") {
    dependsOn(copyWebview)
}

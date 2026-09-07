# Color Lab app packages

Version 0.1.0 is a connected app edition. Both packages open https://colorslab.top, retaining same-origin account cookies, cloud sync, browser file import, and the website's local color engine. A network connection is required to load the editor; this is not an offline native rewrite.

## Windows

Run `npm ci`, then `npm run package:win`. The NSIS installer is written to `release/Color-Lab-Windows-Setup.exe`. It installs per user and offers an installation directory. The renderer is sandboxed with Node integration disabled; external HTTPS links open in the default browser. The package has no commercial code-signing certificate yet.

## Android

The Android project uses Google's Android Browser Helper (Trusted Web Activity). A compatible browser supplies rendering, file selection, downloads, and sharing. Without verified Digital Asset Links, it falls back to a browser Custom Tab.

For a locally signed release, install JDK 17 under `.native-tools/jdk`, Gradle 8.11.1 under `.native-tools/gradle`, and the Android SDK under `.native-tools/sdk`, then run `scripts/package-android.ps1`. Its signing key remains at `.native-tools/color-lab.keystore`. The password is protected by Windows DPAPI in `.native-tools/android-signing.xml`. Back up the key and its credential securely; future updates must use the same key. Never commit either file. CI builds a separate debug-signed test artifact, not the locally signed update package.

The website's `.well-known/assetlinks.json` must contain the release certificate fingerprint to enable verified full-screen launching. Do not substitute a CI debug fingerprint for the release certificate.

## Distribution

Publish installer files as GitHub Release assets named exactly `Color-Lab-Android.apk` and `Color-Lab-Windows-Setup.exe`. The website queries the latest published release and enables each download only when the matching asset exists. Large installers are not placed in Cloudflare Pages static assets. The release workflow provides build artifacts for manual verification; it does not automatically publish untested installers.

## Acceptance

Run `npm run verify:all`. Test native launch, login, image selection, reference import, before/after comparison, grading, export, network failure recovery, and relaunch on Windows and Android before treating a package as device-verified. Browser emulation alone is not native-device acceptance.

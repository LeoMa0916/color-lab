# Android 0.1.1 startup recovery

User evidence: Xiaomi 15 Pro / HyperOS 3 opens colorslab.top in its browser, but APK 0.1.0 leaves a blank recent-task preview. Browser-provider handoff is suspected, not proven by device logs.

Changes: replace the transparent launcher entry with a visible recovery activity; retain the previous TWA path behind it; allow retry and explicit ordinary-browser selection; cancel a handoff still covering the recovery activity after eight seconds. Remove the app's HTTPS intent interception to prevent a normal browser fallback from resolving into the app itself. Bump versionCode to 2 and keep the same signing key for an in-place update.

Compatibility entry opens the website in a browser. It is not an embedded native renderer and does not establish that TWA mode works on HyperOS. No engine, account storage or photo data changes.

Acceptance: release build, lint, certificate and manifest checks locally; Xiaomi device confirmation still required. User should install over 0.1.0, not uninstall/clear data, and try the browser button if App mode does not display.

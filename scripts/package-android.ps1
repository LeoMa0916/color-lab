$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$toolRoot = Join-Path $projectRoot '.native-tools'
$javaRoot = (Get-ChildItem (Join-Path $toolRoot 'jdk') -Directory | Select-Object -First 1).FullName
if (!$javaRoot) { throw 'JDK 17 is required under .native-tools/jdk.' }
$env:JAVA_HOME = $javaRoot
$env:ANDROID_HOME = Join-Path $toolRoot 'sdk'
$keyPath = Join-Path $toolRoot 'color-lab.keystore'
$credentialPath = Join-Path $toolRoot 'android-signing.xml'
if (!(Test-Path -LiteralPath $credentialPath)) {
    if (Test-Path -LiteralPath $keyPath) { throw 'Signing key exists without its credential. Restore the credential; do not replace the key.' }
    $randomBytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
    $secret = [Convert]::ToBase64String($randomBytes)
    $secure = ConvertTo-SecureString $secret -AsPlainText -Force
    [PSCredential]::new('colorlab', $secure) | Export-Clixml -LiteralPath $credentialPath
}
$credential = Import-Clixml -LiteralPath $credentialPath
$env:COLORLAB_SIGN_PASSWORD = $credential.GetNetworkCredential().Password
$env:COLORLAB_KEYSTORE = $keyPath
try {
    if (!(Test-Path -LiteralPath $keyPath)) {
        & "$javaRoot/bin/keytool.exe" -genkeypair -keystore $keyPath -storepass:env COLORLAB_SIGN_PASSWORD -keypass:env COLORLAB_SIGN_PASSWORD -alias colorlab -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Color Lab, O=Color Lab' -noprompt
        if ($LASTEXITCODE) { throw 'Signing key generation failed' }
    }
    & "$toolRoot/gradle/gradle-8.11.1/bin/gradle.bat" -p "$projectRoot/android" assembleRelease
    if ($LASTEXITCODE) { throw 'Android build failed' }
    New-Item -ItemType Directory -Force (Join-Path $projectRoot 'release') | Out-Null
    Copy-Item -LiteralPath "$projectRoot/android/app/build/outputs/apk/release/app-release.apk" -Destination "$projectRoot/release/Color-Lab-Android.apk"
} finally {
    Remove-Item Env:COLORLAB_SIGN_PASSWORD -ErrorAction SilentlyContinue
    Remove-Item Env:COLORLAB_KEYSTORE -ErrorAction SilentlyContinue
}

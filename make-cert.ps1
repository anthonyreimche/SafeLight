# make-cert.ps1 — self-signed code-signing certificate for Safelight.
#
# Creates build\safelight-cert.pfx (reused on later builds) under the name
# "Safelight" and trusts it locally so the signed .exe shows that
# publisher on this PC instead of "Unknown Publisher". Run the .bat as
# Administrator to trust it machine-wide; otherwise it trusts per-user.
#
# NOTE: a self-signed cert is trusted only where you install it. It does NOT
# remove SmartScreen warnings on other people's machines — that needs a
# CA-issued certificate.

$ErrorActionPreference = "Stop"

$root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$buildDir = Join-Path $root "build"
$pfxPath  = Join-Path $buildDir "safelight-cert.pfx"
$password = "safelight"
$subject  = "CN=Safelight"

New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

if (Test-Path $pfxPath) {
    # Regenerate if the cached cert was made under an old subject name.
    $existing = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($pfxPath, $password)
    if ($existing.Subject -eq $subject) {
        Write-Host "[cert] Reusing existing certificate: $pfxPath"
        exit 0
    }
    Write-Host "[cert] Cached cert is '$($existing.Subject)', want '$subject' - regenerating..."
    Remove-Item $pfxPath -Force
}

Write-Host "[cert] Generating self-signed code-signing certificate ($subject)..."
$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $subject `
    -FriendlyName "Safelight Code Signing" `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -KeyExportPolicy Exportable `
    -KeySpec Signature `
    -KeyLength 2048 `
    -HashAlgorithm SHA256 `
    -KeyUsage DigitalSignature `
    -NotAfter (Get-Date).AddYears(5)

$securePwd = ConvertTo-SecureString -String $password -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $securePwd | Out-Null
Write-Host "[cert] Exported: $pfxPath"

# Trust locally. Prefer machine-wide (needs admin); fall back to per-user.
function Add-ToStore($scope) {
    foreach ($name in @("Root", "TrustedPublisher")) {
        $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($name, $scope)
        $store.Open("ReadWrite"); $store.Add($cert); $store.Close()
    }
}
try {
    Add-ToStore "LocalMachine"
    Write-Host "[cert] Trusted in LocalMachine Root + TrustedPublisher."
} catch {
    try {
        Add-ToStore "CurrentUser"
        Write-Host "[cert] Trusted in CurrentUser stores (run the build as Administrator for machine-wide trust)."
    } catch {
        Write-Warning "[cert] Could not install to trust stores: $($_.Exception.Message)"
    }
}

# The PFX is the source of truth; drop the working key from the personal store.
Remove-Item -Path ("Cert:\CurrentUser\My\" + $cert.Thumbprint) -ErrorAction SilentlyContinue
Write-Host "[cert] Done."

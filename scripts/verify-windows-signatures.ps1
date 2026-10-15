$ErrorActionPreference = 'Stop'

$dir = $env:IRIS_WINDOWS_SIGNED_DIR
$version = $env:IRIS_INPUT_VERSION
$requestId = $env:IRIS_INPUT_WINDOWS_REQUEST_ID
$inputDigest = $env:IRIS_INPUT_WINDOWS_INPUT_DIGEST
$expectedSubject = 'CN=VOIDCARVE LABS, O=VOIDCARVE LABS, L=Mississauga, S=Ontario, C=CA'

if (-not [System.IO.Path]::IsPathFullyQualified($dir) -or $version -notmatch '^\d+\.\d+\.\d+$' -or $requestId -notmatch '^[0-9a-f-]{36}$' -or $inputDigest -notmatch '^sha256:[a-f0-9]{64}$') {
  throw 'INVALID_INPUT'
}

$installerName = "IRIS-$version-win-x64.exe"
$portableName = "IRIS-$version-win-x64-portable.exe"
$report = Get-Content -LiteralPath (Join-Path $dir 'verification.json') -Raw | ConvertFrom-Json
$manifest = Get-Content -LiteralPath (Join-Path $dir 'windows-signed.json') -Raw | ConvertFrom-Json
if ($report.request_id -cne $requestId -or $report.input_digest -cne $inputDigest -or $report.version -cne $version -or $report.architecture -cne 'x64' -or $report.nested_signatures_verified -cne $true) {
  throw 'VERIFICATION_REPORT_INVALID'
}
if ($manifest.request_id -cne $requestId -or $manifest.input_digest -cne $inputDigest -or $manifest.version -cne $version) {
  throw 'SIGNING_CONTEXT_MISMATCH'
}

$expectedFiles = @{
  'product.exe' = $installerName
  'product-portable.exe' = $portableName
}
if ($report.files.Count -ne 2) { throw 'VERIFICATION_REPORT_INVALID' }
foreach ($entry in $report.files) {
  if (-not $expectedFiles.ContainsKey([string]$entry.path)) { throw 'VERIFICATION_REPORT_INVALID' }
  $path = Join-Path $dir $expectedFiles[[string]$entry.path]
  $item = Get-Item -LiteralPath $path
  $digest = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($item.Length -ne $entry.size -or $digest -cne $entry.sha256) { throw 'VERIFICATION_REPORT_INVALID' }
}

$signtool = (Get-Command signtool.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $signtool) {
  $sdkBins = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
  $signtool = Get-ChildItem -LiteralPath $sdkBins -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName 'x64/signtool.exe' } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
}
if (-not $signtool) { throw 'SIGNTOOL_UNAVAILABLE' }
foreach ($name in @($installerName, $portableName)) {
  $path = Join-Path $dir $name
  $signature = Get-AuthenticodeSignature -LiteralPath $path
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or $signature.SignerCertificate.Subject -cne $expectedSubject -or $null -eq $signature.TimeStamperCertificate) {
    throw 'WINDOWS_SIGNATURE_INVALID'
  }
  & $signtool verify /pa /all /tw $path *> $null
  if ($LASTEXITCODE -ne 0) { throw 'WINDOWS_SIGNATURE_INVALID' }
}

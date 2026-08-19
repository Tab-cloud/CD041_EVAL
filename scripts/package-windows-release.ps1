#requires -Version 7.0

[CmdletBinding()]
param(
  [string]$KeyDirectory = (Join-Path $env:LOCALAPPDATA "Eval\release-signing")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent $repoRoot
$appRoot = Join-Path $repoRoot "app"
$tauriRoot = Join-Path $appRoot "src-tauri"
$tauriCommand = Join-Path $repoRoot "node_modules\.bin\tauri.cmd"
$privateKeyPath = Join-Path $KeyDirectory "updater.key"
$publicKeyPath = Join-Path $KeyDirectory "updater.pub"
$passwordPath = Join-Path $KeyDirectory "updater.password.dpapi"
$entropy = [Text.Encoding]::UTF8.GetBytes("Eval/TauriUpdater/Password/v1")

foreach ($required in @($privateKeyPath, $publicKeyPath, $passwordPath)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "签名凭据文件不存在: $required"
  }
}
if (-not (Test-Path -LiteralPath $tauriCommand -PathType Leaf)) {
  throw "Tauri CLI 不存在: $tauriCommand"
}

$resolvedKeyDirectory = (Resolve-Path -LiteralPath $KeyDirectory).Path.TrimEnd("\")
$resolvedRepoRoot = (Resolve-Path -LiteralPath $repoRoot).Path.TrimEnd("\")
if ($resolvedKeyDirectory.StartsWith("$resolvedRepoRoot\", [StringComparison]::OrdinalIgnoreCase)) {
  throw "签名私钥目录不能位于仓库内"
}

$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowedSids = @($currentSid, "S-1-5-18")
$acl = Get-Acl -LiteralPath $resolvedKeyDirectory
if (-not $acl.AreAccessRulesProtected) {
  throw "签名私钥目录仍继承上级 ACL，已拒绝打包"
}
foreach ($rule in $acl.Access) {
  if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
  $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  if ($sid -notin $allowedSids) {
    throw "签名私钥目录包含未授权主体: $($rule.IdentityReference)"
  }
}

$package = Get-Content -LiteralPath (Join-Path $appRoot "package.json") -Raw | ConvertFrom-Json
$tauri = Get-Content -LiteralPath (Join-Path $tauriRoot "tauri.conf.json") -Raw | ConvertFrom-Json
$cargo = Get-Content -LiteralPath (Join-Path $tauriRoot "Cargo.toml") -Raw
$cargoVersion = [regex]::Match($cargo, '(?m)^version\s*=\s*"([^"]+)"').Groups[1].Value
$version = [string]$package.version
if ($version -ne [string]$tauri.version -or $version -ne $cargoVersion) {
  throw "版本不一致: package=$version, tauri=$($tauri.version), cargo=$cargoVersion"
}

$publicKey = [IO.File]::ReadAllText($publicKeyPath).Trim()
if ($publicKey -ne [string]$tauri.plugins.updater.pubkey) {
  throw "受保护目录中的 updater 公钥与客户端内置公钥不一致"
}

$protectedPassword = [IO.File]::ReadAllBytes($passwordPath)
$plainPasswordBytes = $null
$password = $null
$previousKeyPath = $env:TAURI_SIGNING_PRIVATE_KEY_PATH
$previousPassword = $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD

try {
  $plainPasswordBytes = [Security.Cryptography.ProtectedData]::Unprotect(
    $protectedPassword,
    $entropy,
    [Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $password = [Text.Encoding]::UTF8.GetString($plainPasswordBytes)
  if ([string]::IsNullOrWhiteSpace($password)) { throw "DPAPI 密码内容为空" }

  $sourceExe = Join-Path $tauriRoot "target\release\bundle\nsis\Eval_${version}_x64-setup.exe"
  $sourceSig = "$sourceExe.sig"
  if (Test-Path -LiteralPath $sourceSig) { [IO.File]::Delete($sourceSig) }

  Push-Location $appRoot
  try {
    & $tauriCommand build --bundles nsis --config src-tauri/tauri.bundle-only.conf.json
    if ($LASTEXITCODE -ne 0) { throw "Tauri NSIS 构建失败: $LASTEXITCODE" }

    $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $privateKeyPath
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $password
    $signOutput = & $tauriCommand signer sign --private-key-path $privateKeyPath $sourceExe 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Tauri updater 签名失败: $LASTEXITCODE" }
  } finally {
    Pop-Location
  }

  if (-not (Test-Path -LiteralPath $sourceExe -PathType Leaf)) { throw "NSIS 安装包不存在" }
  if (-not (Test-Path -LiteralPath $sourceSig -PathType Leaf)) { throw "NSIS 签名文件不存在" }

  $destinationDirectory = Join-Path $workspaceRoot "dist\$version"
  [IO.Directory]::CreateDirectory($destinationDirectory) | Out-Null
  $destinationExe = Join-Path $destinationDirectory "Eval_${version}_x64-setup.exe"
  $destinationSig = "$destinationExe.sig"
  $destinationChecksum = "$destinationExe.sha256.key"
  [IO.File]::Copy($sourceExe, $destinationExe, $true)
  [IO.File]::Copy($sourceSig, $destinationSig, $true)

  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $destinationExe).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText($destinationChecksum, "$hash *$([IO.Path]::GetFileName($destinationExe))`r`n", [Text.UTF8Encoding]::new($false))
  $versionPublicKey = Join-Path $destinationDirectory "Eval_${version}_updater.pub"
  if (Test-Path -LiteralPath $versionPublicKey) { [IO.File]::Delete($versionPublicKey) }

  [pscustomobject]@{
    Version = $version
    Installer = $destinationExe
    Signature = $destinationSig
    Checksum = $destinationChecksum
    Sha256 = $hash
    PublicKeySha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $publicKeyPath).Hash.ToLowerInvariant()
  }
} finally {
  $env:TAURI_SIGNING_PRIVATE_KEY_PATH = $previousKeyPath
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $previousPassword
  if ($plainPasswordBytes) { [Array]::Clear($plainPasswordBytes, 0, $plainPasswordBytes.Length) }
  if ($protectedPassword) { [Array]::Clear($protectedPassword, 0, $protectedPassword.Length) }
  if ($entropy) { [Array]::Clear($entropy, 0, $entropy.Length) }
  $password = $null
}

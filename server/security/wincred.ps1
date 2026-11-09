<#
.SYNOPSIS
    AI Test Studio -- Windows Credential Manager helper (ATS-402).

.DESCRIPTION
    Reads and writes ONE credential in the **Windows Credential Manager**
    (the system credential store). The Bridge calls this helper as a child
    process; the helper is the only component that talks to advapi32.

    WHY A HELPER AND NOT THE BRIDGE ITSELF
    --------------------------------------
    Node has no binding for CredWriteW/CredReadW. The alternatives are a
    native module (a new build + dependency + supply-chain surface) or a
    helper process. The helper process is used because it keeps the
    credential store behind ONE audited interface.

    THE SECRET NEVER APPEARS IN THE COMMAND LINE
    ---------------------------------------------
    The secret is read from STDIN and written to STDOUT. Passing it as an
    argument would expose it in the process table (`tasklist`, Procmon,
    WMI) to every other process of the same user.

    The helper NEVER prints the secret to STDERR and never echoes it into an
    error message.

.PARAMETER Action
    write | read | delete

.PARAMETER Target
    The credential target name (the "resource" in Credential Manager).

.PARAMETER User
    The credential user name (the account the secret belongs to).

.EXAMPLE
    echo -n 'secret' | powershell -NoProfile -File wincred.ps1 write -Target T -User U
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('write', 'read', 'delete')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$Target,

  [string]$User = 'ai-test-studio'
)

$ErrorActionPreference = 'Stop'

# --- The credential manager API (advapi32) ---------------------------------
# The WinRT PasswordVault was tried first and rejected: its async surface
# does not map onto a synchronous child process without a helper that blocks
# on a WinRT task, and it is not available on Windows Server Core.
$source = @'
using System;
using System.Runtime.InteropServices;

public static class AtsWinCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags;
    public uint Type;                 // 1 = CRED_TYPE_GENERIC
    public IntPtr TargetName;
    public IntPtr Comment;
    public long LastWritten;
    public uint CredentialBlobSize;   // BYTES, not characters
    public IntPtr CredentialBlob;
    public uint Persist;              // 2 = CRED_PERSIST_LOCAL_MACHINE
    public uint AttributeCount;
    public IntPtr Attributes;
    public IntPtr TargetAlias;
    public IntPtr UserName;
  }

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWriteW(ref CREDENTIAL credential, uint flags);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string target, uint type, int reservedFlag, out IntPtr credentialPtr);

  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr credentialPtr);

  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDeleteW(string target, uint type, int reservedFlag);

  public static string PtrToString(IntPtr pointer) {
    return pointer == IntPtr.Zero ? null : Marshal.PtrToStringUni(pointer);
  }
}
'@

Add-Type -TypeDefinition $source -Language CSharp

# --- Console encoding ------------------------------------------------------
# PowerShell 5.1 defaults the console to the ANSI code page, so a secret
# containing non-ASCII characters would be corrupted on the way in or out.
# Both directions are pinned to UTF-8.
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

function Fail([string]$code, [int]$win32) {
  # The message names the code and the Win32 error, never the secret.
  $detail = if ($win32 -ne 0) { " (win32=$win32)" } else { '' }
  [Console]::Error.WriteLine("$code$detail")
  exit 1
}

switch ($Action) {
  'write' {
    $secret = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrEmpty($secret)) { Fail 'CREDENTIAL_EMPTY' 0 }

    $targetPtr = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($Target)
    $userPtr = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($User)
    $blobPtr = [Runtime.InteropServices.Marshal]::StringToHGlobalUni($secret)
    try {
      $credential = New-Object AtsWinCred+CREDENTIAL
      $credential.Type = 1
      $credential.TargetName = $targetPtr
      $credential.CredentialBlobSize = [uint32]($secret.Length * 2)
      $credential.CredentialBlob = $blobPtr
      # CRED_PERSIST_LOCAL_MACHINE: the secret survives a logoff for THIS
      # machine only. It is not roamed to a domain profile.
      $credential.Persist = 2
      $credential.UserName = $userPtr
      if (-not [AtsWinCred]::CredWriteW([ref]$credential, 0)) {
        Fail 'CREDENTIAL_WRITE_FAILED' ([Runtime.InteropServices.Marshal]::GetLastWin32Error())
      }
    } finally {
      # Zero the WHOLE secret block (every byte of the credential blob) before
      # releasing it, not only its first byte.
      $zeros = New-Object byte[] $credential.CredentialBlobSize
      [Runtime.InteropServices.Marshal]::Copy($zeros, 0, $blobPtr, $zeros.Length)
      [void][Runtime.InteropServices.Marshal]::FreeHGlobal($targetPtr)
      [void][Runtime.InteropServices.Marshal]::FreeHGlobal($userPtr)
      [void][Runtime.InteropServices.Marshal]::FreeHGlobal($blobPtr)
      $secret = $null
    }
    [Console]::Out.Write('OK')
    exit 0
  }

  'read' {
    $pointer = [IntPtr]::Zero
    if (-not [AtsWinCred]::CredReadW($Target, 1, 0, [ref]$pointer)) {
      Fail 'CREDENTIAL_NOT_FOUND' ([Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
    try {
      $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][AtsWinCred+CREDENTIAL])
      $size = [int]$credential.CredentialBlobSize
      $bytes = New-Object byte[] $size
      [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $size)
      $secret = [System.Text.Encoding]::Unicode.GetString($bytes)
      [Console]::Out.Write($secret)
    } finally {
      [AtsWinCred]::CredFree($pointer)
    }
    exit 0
  }

  'delete' {
    if (-not [AtsWinCred]::CredDeleteW($Target, 1, 0)) {
      $win32 = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      # ERROR_NOT_FOUND (1168): the entry is already gone.
      if ($win32 -eq 1168) { Fail 'CREDENTIAL_NOT_FOUND' $win32 }
      Fail 'CREDENTIAL_DELETE_FAILED' $win32
    }
    [Console]::Out.Write('OK')
    exit 0
  }
}

Fail 'CREDENTIAL_UNKNOWN_ACTION' 0

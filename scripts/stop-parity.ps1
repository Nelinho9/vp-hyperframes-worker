Get-CimInstance Win32_Process -Filter "name='node.exe'" |
  Where-Object { $_.CommandLine -like '*parity-proofs*' } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force
    Write-Output ("STOPPED " + $_.ProcessId)
  }
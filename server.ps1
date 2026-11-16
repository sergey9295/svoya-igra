# Простой локальный веб-сервер для «Своей игры».
# Нужен потому, что браузер не даёт странице читать файлы колоды при открытии через file://
# Запускается из «Запустить игру.bat». Закройте окно, чтобы остановить сервер.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootFull = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'

$types = @{
  '.html' = 'text/html; charset=utf-8'; '.htm' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8';  '.js'  = 'text/javascript; charset=utf-8'
  '.txt'  = 'text/plain; charset=utf-8'; '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'
  '.gif'  = 'image/gif'; '.webp' = 'image/webp'; '.bmp' = 'image/bmp'; '.ico' = 'image/x-icon'
  '.mp3'  = 'audio/mpeg'; '.wav' = 'audio/wav'; '.ogg' = 'audio/ogg'; '.m4a' = 'audio/mp4'
  '.aac'  = 'audio/aac'; '.flac' = 'audio/flac'; '.opus' = 'audio/ogg'
  '.mp4'  = 'video/mp4'; '.webm' = 'video/webm'; '.mov' = 'video/quicktime'; '.mkv' = 'video/x-matroska'; '.m4v' = 'video/mp4'
}

$listener = $null
$port = 0
foreach ($p in 8777..8797) {
  try {
    $l = New-Object System.Net.HttpListener
    $l.Prefixes.Add("http://localhost:$p/")
    $l.Start()
    $listener = $l; $port = $p; break
  } catch { }
}
if (-not $listener) { Write-Host 'Не удалось занять порт 8777-8797.'; Read-Host 'Enter для выхода'; exit 1 }

$url = "http://localhost:$port/"
Write-Host ''
Write-Host "  СВОЯ ИГРА запущена: $url" -ForegroundColor Yellow
Write-Host '  Не закрывайте это окно во время игры.' -ForegroundColor Gray
Write-Host ''
Start-Process $url

function Send-Bytes($ctx, [byte[]]$bytes, $type, $status = 200) {
  $res = $ctx.Response
  $res.StatusCode = $status
  $res.ContentType = $type
  $res.Headers['Cache-Control'] = 'no-store'
  $res.ContentLength64 = $bytes.Length
  if ($ctx.Request.HttpMethod -ne 'HEAD') { $res.OutputStream.Write($bytes, 0, $bytes.Length) }
}

while ($listener.IsListening) {
  try { $ctx = $listener.GetContext() } catch { break }
  try {
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    $local = [IO.Path]::GetFullPath((Join-Path $root ($rel -replace '/', '\')))
    if (-not ($local + '\').StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
      Send-Bytes $ctx ([Text.Encoding]::UTF8.GetBytes('Forbidden')) 'text/plain' 403
    }
    elseif (Test-Path -LiteralPath $local -PathType Container) {
      $index = Join-Path $local 'index.html'
      if ($rel -eq '' -and (Test-Path -LiteralPath $index)) {
        Send-Bytes $ctx ([IO.File]::ReadAllBytes($index)) $types['.html']
      } else {
        # Список файлов папки — игра читает его, чтобы найти игроков и звуки
        $sb = New-Object Text.StringBuilder
        [void]$sb.Append('<!doctype html><meta charset="utf-8"><ul>')
        foreach ($item in Get-ChildItem -LiteralPath $local) {
          $name = $item.Name; if ($item.PSIsContainer) { $name += '/' }
          $href = [Uri]::EscapeDataString($item.Name); if ($item.PSIsContainer) { $href += '/' }
          [void]$sb.Append("<li><a href=`"$href`">$([Net.WebUtility]::HtmlEncode($name))</a></li>")
        }
        [void]$sb.Append('</ul>')
        Send-Bytes $ctx ([Text.Encoding]::UTF8.GetBytes($sb.ToString())) $types['.html']
      }
    }
    elseif (Test-Path -LiteralPath $local -PathType Leaf) {
      $ext = [IO.Path]::GetExtension($local).ToLower()
      $type = $types[$ext]; if (-not $type) { $type = 'application/octet-stream' }
      $res = $ctx.Response
      $fs = [IO.File]::Open($local, 'Open', 'Read', 'ReadWrite')
      try {
        $len = $fs.Length
        $start = 0; $end = $len - 1; $status = 200
        $range = $ctx.Request.Headers['Range']
        if ($range -and $range -match '^bytes=(\d*)-(\d*)$' -and $len -gt 0) {
          # Range-запросы нужны, чтобы аудио и видео можно было перематывать.
          # Большие файлы отдаём кусками по 4 МБ, чтобы сервер не «зависал» на одном видео.
          if ($Matches[1] -eq '') { $start = [Math]::Max(0, $len - [long]$Matches[2]) }
          else {
            $start = [long]$Matches[1]
            if ($Matches[2] -ne '') { $end = [Math]::Min([long]$Matches[2], $len - 1) }
          }
          if ($start -ge $len) { $start = 0 }
          $end = [Math]::Min($end, $start + 4MB - 1)
          $status = 206
          $res.Headers['Content-Range'] = "bytes $start-$end/$len"
        }
        $count = [Math]::Max(0, $end - $start + 1)
        $res.StatusCode = $status
        $res.ContentType = $type
        $res.Headers['Accept-Ranges'] = 'bytes'
        $res.Headers['Cache-Control'] = 'no-store'
        $res.ContentLength64 = $count
        if ($ctx.Request.HttpMethod -ne 'HEAD') {
          [void]$fs.Seek($start, 'Begin')
          $buf = New-Object byte[] 262144
          $left = $count
          while ($left -gt 0) {
            $n = $fs.Read($buf, 0, [int][Math]::Min($buf.Length, $left))
            if ($n -le 0) { break }
            $res.OutputStream.Write($buf, 0, $n)
            $left -= $n
          }
        }
      } finally { $fs.Close() }
    }
    else {
      Send-Bytes $ctx ([Text.Encoding]::UTF8.GetBytes('Not found')) 'text/plain; charset=utf-8' 404
    }
  } catch {
    try { $ctx.Response.StatusCode = 500 } catch { }
  } finally {
    try { $ctx.Response.OutputStream.Close() } catch { }
  }
}

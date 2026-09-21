# Synthesises the spike/demo utterances offline with Windows SAPI (System.Speech) as 24 kHz 16-bit mono WAV.
# Output: fixtures/audio/spike/*.wav (git-ignored; regenerate any time). Synthetic voice only: no real PII.
param([string]$OutDir = "fixtures/audio/spike", [string]$Voice = "")
Add-Type -AssemblyName System.Speech
New-Item -ItemType Directory -Force $OutDir | Out-Null
$clips = [ordered]@{
  "clean"            = "Two burgers and a coke."
  "inline_corr"      = "Two burgers, no wait, make it three."
  "two_burgers"      = "Two burgers."
  "no_wait_three"    = "No wait, make it three."
  "no_wait_three_b"  = "No wait, make it three burgers."
  "uhhuh"            = "Uh-huh."
  "yes_three"        = "Yes, three."
  "pickup_asap"      = "That's all. Pickup as soon as possible."
}
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($k in $clips.Keys) {
  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
  if ($Voice -ne "") { $synth.SelectVoice($Voice) }
  $synth.Rate = 1
  $path = Join-Path (Resolve-Path $OutDir) "$k.wav"
  $synth.SetOutputToWaveFile($path, $fmt)
  $synth.Speak($clips[$k])
  $synth.Dispose()
  Write-Host "wrote $path"
}

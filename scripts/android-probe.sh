#!/usr/bin/env bash
# Runs inside android-emulator-runner (emulator already booted).
set -eux
mkdir -p out/android
{
  echo "release=$(adb shell getprop ro.build.version.release | tr -d '\r')"
  echo "sdk=$(adb shell getprop ro.build.version.sdk | tr -d '\r')"
  echo "model=$(adb shell getprop ro.product.model | tr -d '\r')"
  echo "abi=$(adb shell getprop ro.product.cpu.abi | tr -d '\r')"
} > out/android/info.txt

adb shell input keyevent KEYCODE_HOME
adb shell screenrecord --time-limit 8 /sdcard/rec.mp4 &
rec=$!
sleep 1
adb shell am start -a android.settings.SETTINGS
sleep 3
adb exec-out screencap -p > out/android/settings.png
adb shell input swipe 540 1600 540 600 300   # scroll for motion in the recording
sleep 2
wait "$rec" || true
sleep 1
adb pull /sdcard/rec.mp4 out/android/recording.mp4
ls -la out/android

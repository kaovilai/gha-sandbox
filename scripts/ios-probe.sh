#!/usr/bin/env bash
# macOS runner: boot an iPhone simulator, capture screenshot + recording of Settings.
set -eux
mkdir -p out/ios
xcodebuild -version | tee out/ios/info.txt
udid=$(xcrun simctl list devices available -j |
  jq -r '[.devices | to_entries[] | select(.key|test("iOS")) | .value[] | select(.name|startswith("iPhone"))][0].udid')
echo "udid=$udid" | tee -a out/ios/info.txt
xcrun simctl boot "$udid"
xcrun simctl bootstatus "$udid" -b

xcrun simctl io "$udid" recordVideo --codec h264 out/ios/recording.mp4 &
rec=$!
sleep 2
xcrun simctl launch "$udid" com.apple.Preferences
sleep 4
xcrun simctl io "$udid" screenshot out/ios/settings.png
sleep 2
kill -INT "$rec"
wait "$rec" || true
ls -la out/ios

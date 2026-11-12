#!/usr/bin/env bash
#
# Generates the FLV fixtures used by the node tests into test/public using a locally installed ffmpeg. Run this from
# the repository root:
#
#   bash test/node/generate-flv-fixtures.sh
#
# The fixtures are intentionally tiny (a couple of seconds of synthetic audio/video) to keep the repository small.

set -euo pipefail

OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/public"
mkdir -p "$OUT_DIR"

# Common synthetic inputs. testsrc2 gives a moving pattern with clear keyframes; sine gives a clean audio tone.
VIDEO_SRC=(-f lavfi -i "testsrc2=size=320x240:rate=30:duration=3")
VIDEO_SRC_LONG=(-f lavfi -i "testsrc2=size=320x240:rate=30:duration=5")
AUDIO_SRC=(-f lavfi -i "sine=frequency=440:sample_rate=48000:duration=3")
AUDIO_SRC_LONG=(-f lavfi -i "sine=frequency=440:sample_rate=48000:duration=5")

# 1. Legacy FLV with H.264 (AVC) video and AAC audio - the most common real-world combination.
ffmpeg -hide_banner -loglevel error -y \
	"${VIDEO_SRC[@]}" "${AUDIO_SRC[@]}" \
	-c:v libx264 -pix_fmt yuv420p -g 30 \
	-c:a aac -ar 48000 -ac 2 \
	-f flv "$OUT_DIR/flv-avc-aac.flv"

# 2. Legacy FLV with H.264 video and MP3 audio.
ffmpeg -hide_banner -loglevel error -y \
	"${VIDEO_SRC[@]}" "${AUDIO_SRC[@]}" \
	-c:v libx264 -pix_fmt yuv420p -g 30 \
	-c:a libmp3lame -ar 44100 -ac 2 \
	-f flv "$OUT_DIR/flv-avc-mp3.flv"

# 3. Enhanced FLV carrying HEVC (ExVideoTag, FourCC 'hvc1') plus AAC.
ffmpeg -hide_banner -loglevel error -y \
	"${VIDEO_SRC[@]}" "${AUDIO_SRC[@]}" \
	-c:v libx265 -pix_fmt yuv420p -g 30 \
	-c:a aac -ar 48000 -ac 2 \
	-f flv "$OUT_DIR/flv-hevc-aac.flv"

# 4. Enhanced FLV carrying AV1 (ExVideoTag, FourCC 'av01') plus AAC.
ffmpeg -hide_banner -loglevel error -y \
	"${VIDEO_SRC[@]}" "${AUDIO_SRC[@]}" \
	-c:v libsvtav1 -g 30 \
	-c:a aac -ar 48000 -ac 2 \
	-f flv "$OUT_DIR/flv-av1-aac.flv"

# 5. Audio-only AAC FLV (no video track).
ffmpeg -hide_banner -loglevel error -y \
	"${AUDIO_SRC[@]}" \
	-c:a aac -ar 48000 -ac 2 \
	-f flv "$OUT_DIR/flv-aac-only.flv"

# 6. A longer AVC/AAC FLV whose onMetaData includes a keyframe seek index (times + filepositions).
ffmpeg -hide_banner -loglevel error -y \
	"${VIDEO_SRC_LONG[@]}" "${AUDIO_SRC_LONG[@]}" \
	-c:v libx264 -pix_fmt yuv420p -g 30 \
	-c:a aac -ar 48000 -ac 2 \
	-flvflags add_keyframe_index \
	-f flv "$OUT_DIR/flv-keyframe-index.flv"

# 7. The same longer clip without any onMetaData script tag, used to exercise the scanning fallback seek path.
ffmpeg -hide_banner -loglevel error -y \
	"${VIDEO_SRC_LONG[@]}" "${AUDIO_SRC_LONG[@]}" \
	-c:v libx264 -pix_fmt yuv420p -g 30 \
	-c:a aac -ar 48000 -ac 2 \
	-flvflags no_metadata \
	-f flv "$OUT_DIR/flv-no-metadata.flv"

echo "FLV fixtures written to $OUT_DIR"

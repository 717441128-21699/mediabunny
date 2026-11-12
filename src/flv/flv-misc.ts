/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { modEuclid } from '../misc';

// Resources:
// Adobe Flash Video File Format Specification Version 10.1 (E. 4, E. 5)
// Adobe's Enhanced FLV / Enhanced RTMP specification (ExVideoTag, FourCC)

export const FLV_SIGNATURE = 'FLV';
export const FLV_VERSION = 0x01;
export const FLV_HEADER_SIZE = 9;
export const FLV_TAG_HEADER_SIZE = 11;
export const PREVIOUS_TAG_SIZE_SIZE = 4;

/** FLV timestamps run on a 1 kHz (millisecond) clock. */
export const FLV_TIMESCALE = 1000;
/** The timestamp is a 32-bit unsigned value (24-bit base plus an 8-bit extended byte), so it wraps at 2^32. */
export const FLV_TIMESTAMP_MODULUS = 2 ** 32;

export const enum FlvTagType {
	Audio = 8,
	Video = 9,
	ScriptData = 18,
}

export const enum FlvSoundFormat {
	LinearPcmPlatformEndian = 0,
	Adpcm = 1,
	MP3 = 2,
	LinearPcmLittleEndian = 3,
	Nellymoser16Khz = 4,
	Nellymoser8Khz = 5,
	Nellymoser = 6,
	G711ALaw = 7,
	G711MuLaw = 8,
	Reserved = 9,
	AAC = 10,
	Speex = 11,
	MP3_8Khz = 14,
	DeviceSpecific = 15,
}

export const enum FlvAACPacketType {
	SequenceHeader = 0,
	Raw = 1,
}

export const enum FlvVideoCodecId {
	SorensonH263 = 2,
	ScreenVideo = 3,
	VP6 = 4,
	VP6WithAlpha = 5,
	ScreenVideoVersion2 = 6,
	AVC = 7,
	HEVC = 12,
}

export const enum FlvFrameType {
	KeyFrame = 1,
	InterFrame = 2,
	DisposableInterFrame = 3,
	GeneratedKeyFrame = 4,
	VideoInfoCommandFrame = 5,
}

export const enum FlvAvcPacketType {
	SequenceHeader = 0,
	Nalu = 1,
	EndOfSequence = 2,
}

/**
 * First byte of an Enhanced FLV (ExVideoTag) video tag. Bit 7 is always set, the high nibble carries the frame type
 * (0x9 = key, 0xa = inter) and the low nibble carries the packet type (see FlvEnhancedPacketType). ffmpeg and OBS write
 * key CodedFrames as 0x91, inter CodedFrames as 0xa1 and the key SequenceStart as 0x90.
 */
export const ENHANCED_FLV_EX_HEADER_MASK = 0x80;
export const ENHANCED_FLV_KEY_FRAME_MARKER = 0x90;
export const ENHANCED_FLV_INTER_FRAME_MARKER = 0xa0;
export const ENHANCED_FLV_PACKET_TYPE_MASK = 0x0f;

export const enum FlvEnhancedPacketType {
	SequenceStart = 0,
	CodedFrames = 1,
	SequenceEnd = 2,
	CodedFramesX = 3,
	Metadata = 4,
	Mpeg2TsSequenceStart = 5,
	MultitrackType2 = 6,
	MultitrackType3 = 7,
	AudioPrefetch = 8,
}

export const FLV_FOURCC_HVC1 = 'hvc1';
export const FLV_FOURCC_AV01 = 'av01';
export const FLV_FOURCC_VP09 = 'vp09';

export const buildFlvMimeType = (codecStrings: (string | null)[]) => {
	let string = 'video/x-flv';

	const uniqueCodecStrings = [...new Set(codecStrings.filter(Boolean))];
	if (uniqueCodecStrings.length > 0) {
		string += `; codecs="${uniqueCodecStrings.join(', ')}"`;
	}

	return string;
};

export const secondsToFlvTimestamp = (seconds: number) => {
	// This supports writing negative timestamps by simply Euclid-modding them. It is then up to the demuxer to
	// interpret them as negative, if it wants to.
	return modEuclid(Math.round(FLV_TIMESCALE * seconds), FLV_TIMESTAMP_MODULUS);
};

/**
 * Statefully unwraps the 32-bit millisecond timestamps of a single FLV track into a continuous, signed millisecond
 * timeline. Wrap-around is detected from the discontinuity between consecutive samples rather than assumed from the
 * first value, so ordinary short files (whose timestamps start at zero and never wrap) are left untouched. A stream
 * that begins near the modulus is treated as starting at a negative timestamp, matching how negative composition
 * offsets are encoded.
 */
export class FlvTimestampUnwrapper {
	private previousRaw: number | null = null;
	private offset = 0;

	next(rawTimestamp: number) {
		if (this.previousRaw === null) {
			// Values close to the modulus represent negative timestamps (Euclid-encoded on the muxer side)
			if (rawTimestamp > FLV_TIMESTAMP_MODULUS / 2) {
				this.offset = -FLV_TIMESTAMP_MODULUS;
			}

			this.previousRaw = rawTimestamp;
			return rawTimestamp + this.offset;
		}

		const delta = rawTimestamp - this.previousRaw;

		// A large negative jump means the 32-bit counter wrapped upwards; a large positive jump means it wrapped back
		// (e.g. after a negative region). Anything within half the modulus is ordinary monotonic progress.
		if (delta < -FLV_TIMESTAMP_MODULUS / 2) {
			this.offset += FLV_TIMESTAMP_MODULUS;
		} else if (delta > FLV_TIMESTAMP_MODULUS / 2) {
			this.offset -= FLV_TIMESTAMP_MODULUS;
		}

		this.previousRaw = rawTimestamp;
		return rawTimestamp + this.offset;
	}
}

/** Reads a FourCC string out of a 4-byte region. */
export const readFourCc = (bytes: Uint8Array, offset: number) => {
	return String.fromCharCode(
		bytes[offset]!,
		bytes[offset + 1]!,
		bytes[offset + 2]!,
		bytes[offset + 3]!,
	);
};

/** Writes a FourCC string into a 4-byte region. */
export const writeFourCc = (bytes: Uint8Array, offset: number, fourCc: string) => {
	for (let i = 0; i < 4; i++) {
		bytes[offset + i] = fourCc.charCodeAt(i);
	}
};

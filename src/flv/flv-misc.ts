/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { modEuclid } from '../misc';

// Resources:
// Adobe Flash Video File Format Specification Version 10.1 (Annex E)
// Adobe "Enhanced RTMP" / Enhanced FLV (FourCC-based video, packet type codes)

export const FLV_MIME_TYPE = 'video/x-flv';

/** FLV timestamps run on a millisecond clock. */
export const FLV_TIMESCALE = 1000;

/** The 24-bit base timestamp plus the 8-bit extension byte form a 32-bit millisecond value. */
export const FLV_TIMESTAMP_MODULUS = 2 ** 32;

/** Total size of the FLV header (the "FLV" signature up to and including the first PreviousTagSize0). */
export const FLV_HEADER_SIZE = 13;

export const enum FlvTagType {
	AUDIO = 8,
	VIDEO = 9,
	SCRIPT_DATA = 18,
}

/** Classic FLV SoundFormat values (first nibble of an audio tag's first byte). */
export const enum FlvSoundFormat {
	LINEAR_PCM_PLATFORM = 0,
	ADPCM = 1,
	MP3 = 2,
	LINEAR_PCM_LE = 3,
	NELLYMOSER_16K = 4,
	NELLYMOSER_8K = 5,
	NELLYMOSER = 6,
	G711_A_LAW = 7,
	G711_MU_LAW = 8,
	AAC = 10,
	SPEEX = 11,
	MP3_8K = 14,
	DEVICE_SPECIFIC = 15,
}

/** Classic FLV video frame type values (high nibble of a video tag's first byte). */
export const enum FlvVideoFrameType {
	KEY = 1,
	INTER = 2,
	DISPOSABLE_INTER = 3,
	GENERATED_KEY = 4,
	VIDEO_INFO = 5,
}

/** Classic FLV video codec ID values (low nibble of a video tag's first byte). */
export const enum FlvVideoCodecId {
	SORENSON_H263 = 2,
	SCREEN_VIDEO = 3,
	VP6 = 4,
	VP6_WITH_ALPHA = 5,
	SCREEN_VIDEO_V2 = 6,
	AVC = 7,
}

/**
 * Enhanced FLV packet type, held in the low nibble of the first video byte. The high bit (0x80) marks the tag as
 * enhanced (FourCC-based), and the frame type occupies the bits in between.
 */
export const enum FlvVideoPacketType {
	SEQUENCE_START = 0,
	CODED_FRAMES = 1,
	SEQUENCE_END = 2,
	CODED_FRAMES_X = 3,
	METADATA = 4,
	MPEG2_TS_SEQUENCE_START = 5,
}

/** Bit that signals the enhanced (FourCC-based) layout in the first video byte. */
export const FLV_ENHANCED_VIDEO_MASK = 0x80;

/**
 * Enhanced FLV frame type, held in bits 4-6 of the first video byte. Only key and inter frames carry decodable coded
 * frames.
 */
export const enum FlvEnhancedFrameType {
	KEY = 1,
	INTER = 2,
	DISPOSABLE_INTER = 3,
	GENERATED_KEY = 4,
}

/** Mask extracting the packet type from the first enhanced video byte. */
export const FLV_PACKET_TYPE_MASK = 0x0f;

/** Mask extracting the frame type from the first enhanced video byte. */
export const FLV_ENHANCED_FRAME_TYPE_MASK = 0x70;

/** FourCCs used by Enhanced FLV to identify the video codec. */
export const FLV_FOURCC_HEVC = 'hvc1';
export const FLV_FOURCC_AV1 = 'av01';
export const FLV_FOURCC_VP9 = 'vp09';
export const FLV_FOURCC_AVC = 'avc1';

/** AAC packet type (first byte following the sound format byte). */
export const enum FlvAacPacketType {
	SEQUENCE_HEADER = 0,
	RAW = 1,
}

/** AVC packet type (first byte following the frame/codec byte in classic AVC tags). */
export const enum FlvAvcPacketType {
	SEQUENCE_HEADER = 0,
	NALU = 1,
	END_OF_SEQUENCE = 2,
}

export type TimestampWrapInfo = {
	reference: number;
	offset: number;
};

/**
 * Anchors the wrap detection on the first timestamp observed in the file. Timestamps close to the 32-bit modulus are
 * interpreted as negative, matching how the MPEG-TS demuxer handles wrapped clocks.
 */
export const createTimestampWrapInfo = (firstTimestamp: number): TimestampWrapInfo => {
	const tolerance = 60 * FLV_TIMESCALE;
	return {
		reference: firstTimestamp - tolerance,
		offset: firstTimestamp >= FLV_TIMESTAMP_MODULUS - tolerance
			? -FLV_TIMESTAMP_MODULUS
			: FLV_TIMESTAMP_MODULUS,
	};
};

export const normalizeWrappedTimestamp = (timestamp: number, wrapInfo: TimestampWrapInfo) => {
	const { reference, offset } = wrapInfo;
	if (
		(offset < 0 && timestamp >= reference)
		|| (offset > 0 && timestamp < reference)
	) {
		return timestamp + offset;
	}

	return timestamp;
};

/** Euclid-modding keeps negative timestamps encodable in the unsigned 32-bit field; the demuxer reverses this. */
export const secondsToFlvTimestamp = (seconds: number) => {
	return modEuclid(Math.round(FLV_TIMESCALE * seconds), FLV_TIMESTAMP_MODULUS);
};

export const buildFlvMimeType = (codecStrings: (string | null)[]) => {
	let string = FLV_MIME_TYPE;

	const uniqueCodecStrings = [...new Set(codecStrings.filter(Boolean))];
	if (uniqueCodecStrings.length > 0) {
		string += `; codecs="${uniqueCodecStrings.join(', ')}"`;
	}

	return string;
};

/**
 * Reads an unsigned 24-bit big-endian integer directly from a byte array.
 */
export const readU24FromBytes = (bytes: Uint8Array, offset: number) => {
	return (bytes[offset]! << 16) | (bytes[offset + 1]! << 8) | bytes[offset + 2]!;
};

/**
 * Reads an unsigned 32-bit big-endian integer directly from a byte array.
 */
export const readU32FromBytes = (bytes: Uint8Array, offset: number) => {
	return (
		readU24FromBytes(bytes, offset) * 256 + bytes[offset + 3]!
	) >>> 0;
};

/**
 * Writes an unsigned 24-bit big-endian integer into the byte array.
 */
export const writeU24 = (bytes: Uint8Array, offset: number, value: number) => {
	bytes[offset] = (value >>> 16) & 0xff;
	bytes[offset + 1] = (value >>> 8) & 0xff;
	bytes[offset + 2] = value & 0xff;
};

/**
 * Writes an unsigned 32-bit big-endian integer into the byte array.
 */
export const writeU32 = (bytes: Uint8Array, offset: number, value: number) => {
	bytes[offset] = (value >>> 24) & 0xff;
	bytes[offset + 1] = (value >>> 16) & 0xff;
	bytes[offset + 2] = (value >>> 8) & 0xff;
	bytes[offset + 3] = value & 0xff;
};

/* ================================ AMF0 ================================ */

const enum Amf0Marker {
	NUMBER = 0x00,
	BOOLEAN = 0x01,
	STRING = 0x02,
	OBJECT = 0x03,
	NULL = 0x05,
	UNDEFINED = 0x06,
	ECMA_ARRAY = 0x08,
	OBJECT_END = 0x09,
	STRICT_ARRAY = 0x0a,
}

export type AmfValue =
	| number
	| boolean
	| string
	| null
	| AmfValue[]
	| { [key: string]: AmfValue };

/**
 * A tolerant AMF0 reader. It is intentionally lenient — malformed trailing data returns what it managed to decode
 * rather than throwing, so a corrupt `onMetaData` tag never takes down the whole demuxer.
 */
export class Amf0Reader {
	private pos = 0;

	constructor(private readonly bytes: Uint8Array) {}

	atEnd() {
		return this.pos >= this.bytes.byteLength;
	}

	/**
	 * Reads the next AMF0 value. Returns `undefined` when the byte stream ends or an unknown marker is encountered,
	 * which callers distinguish from a legitimately decoded `null` value.
	 */
	readValue(): AmfValue | undefined {
		if (this.atEnd()) {
			return undefined;
		}

		const marker = this.bytes[this.pos++]!;
		switch (marker) {
			case Amf0Marker.NUMBER:
				return this.readNumber();
			case Amf0Marker.BOOLEAN:
				if (this.pos + 1 > this.bytes.byteLength) {
					return undefined;
				}
				return this.bytes[this.pos++]! !== 0;
			case Amf0Marker.STRING:
				return this.readString();
			case Amf0Marker.OBJECT:
				return this.readObject();
			case Amf0Marker.NULL:
			case Amf0Marker.UNDEFINED:
				return null; // A legitimate AMF0 null value
			case Amf0Marker.ECMA_ARRAY:
				// The associative-count field is informational; the body is encoded exactly like an object
				if (this.pos + 4 > this.bytes.byteLength) {
					return undefined;
				}
				this.pos += 4;
				return this.readObject();
			case Amf0Marker.STRICT_ARRAY: {
				if (this.pos + 4 > this.bytes.byteLength) {
					return undefined;
				}
				const count = readU32FromBytes(this.bytes, this.pos);
				this.pos += 4;
				const array: AmfValue[] = [];
				for (let i = 0; i < count; i++) {
					const value = this.readValue();
					if (value === undefined) {
						break;
					}
					array.push(value);
				}
				return array;
			}
			default:
				// Unknown marker; stop decoding rather than risk reading garbage
				return undefined;
		}
	}

	private readNumber(): number | undefined {
		if (this.pos + 8 > this.bytes.byteLength) {
			return undefined;
		}
		const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
		const value = view.getFloat64(this.pos, false);
		this.pos += 8;
		return value;
	}

	private readString(): string | undefined {
		if (this.pos + 2 > this.bytes.byteLength) {
			return undefined;
		}
		const length = (this.bytes[this.pos]! << 8) | this.bytes[this.pos + 1]!;
		this.pos += 2;
		if (this.pos + length > this.bytes.byteLength) {
			return undefined;
		}
		let str = '';
		for (let i = 0; i < length; i++) {
			str += String.fromCharCode(this.bytes[this.pos + i]!);
		}
		this.pos += length;
		return str;
	}

	private readObject(): { [key: string]: AmfValue } | undefined {
		const object: { [key: string]: AmfValue } = {};

		while (true) {
			if (this.pos + 2 > this.bytes.byteLength) {
				break;
			}
			const keyLength = (this.bytes[this.pos]! << 8) | this.bytes[this.pos + 1]!;
			this.pos += 2;

			// The empty key followed by an OBJECT_END marker terminates the object
			if (keyLength === 0) {
				if (this.pos < this.bytes.byteLength && this.bytes[this.pos] === Amf0Marker.OBJECT_END) {
					this.pos += 1;
				}
				break;
			}

			if (this.pos + keyLength > this.bytes.byteLength) {
				break;
			}
			let key = '';
			for (let i = 0; i < keyLength; i++) {
				key += String.fromCharCode(this.bytes[this.pos + i]!);
			}
			this.pos += keyLength;

			const value = this.readValue();
			if (value === undefined) {
				// A decoding failure (truncated value or unknown marker); stop parsing the object
				break;
			}
			object[key] = value;
		}

		return object;
	}
}

/** A minimal AMF0 writer sufficient for emitting `onMetaData` script tags. */
export class Amf0Writer {
	private chunks: Uint8Array[] = [];
	private length = 0;

	private push(bytes: Uint8Array) {
		this.chunks.push(bytes);
		this.length += bytes.byteLength;
	}

	writeNumber(value: number) {
		const bytes = new Uint8Array(9);
		bytes[0] = Amf0Marker.NUMBER;
		const view = new DataView(bytes.buffer);
		view.setFloat64(1, value, false);
		this.push(bytes);
	}

	writeBoolean(value: boolean) {
		this.push(new Uint8Array([Amf0Marker.BOOLEAN, value ? 1 : 0]));
	}

	writeString(value: string) {
		const encoded: number[] = [];
		for (let i = 0; i < value.length; i++) {
			encoded.push(value.charCodeAt(i) & 0xff);
		}
		const bytes = new Uint8Array(3 + encoded.length);
		bytes[0] = Amf0Marker.STRING;
		bytes[1] = (encoded.length >>> 8) & 0xff;
		bytes[2] = encoded.length & 0xff;
		bytes.set(encoded, 3);
		this.push(bytes);
	}

	/**
	 * Writes an ECMA array (the encoding ffmpeg uses for `onMetaData`). The associative count is set to the number of
	 * entries, followed by key/value pairs and an object-end marker.
	 */
	writeEcmaObject(entries: { key: string; value: AmfValue }[]) {
		const header = new Uint8Array(5);
		header[0] = Amf0Marker.ECMA_ARRAY;
		writeU32(header, 1, entries.length);
		this.push(header);

		for (const { key, value } of entries) {
			const keyBytes: number[] = [];
			for (let i = 0; i < key.length; i++) {
				keyBytes.push(key.charCodeAt(i) & 0xff);
			}
			const keyHeader = new Uint8Array(2 + keyBytes.length);
			keyHeader[0] = (keyBytes.length >>> 8) & 0xff;
			keyHeader[1] = keyBytes.length & 0xff;
			keyHeader.set(keyBytes, 2);
			this.push(keyHeader);
			this.writeAny(value);
		}

		// Empty key + OBJECT_END
		this.push(new Uint8Array([0x00, 0x00, Amf0Marker.OBJECT_END]));
	}

	writeAny(value: AmfValue) {
		if (value === null) {
			this.push(new Uint8Array([Amf0Marker.NULL]));
		} else if (typeof value === 'number') {
			this.writeNumber(value);
		} else if (typeof value === 'boolean') {
			this.writeBoolean(value);
		} else if (typeof value === 'string') {
			this.writeString(value);
		} else if (Array.isArray(value)) {
			const header = new Uint8Array(5);
			header[0] = Amf0Marker.STRICT_ARRAY;
			writeU32(header, 1, value.length);
			this.push(header);
			for (const item of value) {
				this.writeAny(item);
			}
		} else {
			this.push(new Uint8Array([Amf0Marker.OBJECT]));
			const entries = Object.entries(value).map(([key, val]) => ({ key, value: val }));
			for (const { key, value: val } of entries) {
				const keyBytes: number[] = [];
				for (let i = 0; i < key.length; i++) {
					keyBytes.push(key.charCodeAt(i) & 0xff);
				}
				const keyHeader = new Uint8Array(2 + keyBytes.length);
				keyHeader[0] = (keyBytes.length >>> 8) & 0xff;
				keyHeader[1] = keyBytes.length & 0xff;
				keyHeader.set(keyBytes, 2);
				this.push(keyHeader);
				this.writeAny(val);
			}
			this.push(new Uint8Array([0x00, 0x00, Amf0Marker.OBJECT_END]));
		}
	}

	toBytes(): Uint8Array {
		const result = new Uint8Array(this.length);
		let offset = 0;
		for (const chunk of this.chunks) {
			result.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return result;
	}
}

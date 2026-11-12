/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// A minimal, defensive AMF0 (Action Message Format, version 0) parser used to read the `onMetaData` script-data tag of
// an FLV file. See the Adobe AMF0 specification for the wire format.

import { Logging } from '../logging';
import { FileSlice, readAscii, readF64Be, readU16Be, readU8 } from '../reader';

const enum Amf0TypeMarker {
	Number = 0x00,
	Boolean = 0x01,
	String = 0x02,
	Object = 0x03,
	Null = 0x05,
	Undefined = 0x06,
	Reference = 0x07,
	EcmaArray = 0x08,
	ObjectEnd = 0x09,
	StrictArray = 0x0a,
	Date = 0x0b,
	LongString = 0x0c,
	Unsupported = 0x0d,
}

export type AmfValue =
	| number
	| boolean
	| string
	| null
	| AmfValue[]
	| { [key: string]: AmfValue };

const readAmfString = (slice: FileSlice, long: boolean): string => {
	const length = long ? readU8(slice) * 0x10000 + readU16Be(slice) : readU16Be(slice);
	return readAscii(slice, length);
};

const readObjectEnd = (slice: FileSlice): boolean => {
	// An object ends with an empty (0-length) key followed by an ObjectEnd marker
	if (slice.remainingLength < 3) {
		return false;
	}

	const keyLength = readU16Be(slice);
	if (keyLength !== 0) {
		// Not an end marker; rewind so the caller can treat the key as a regular property
		slice.skip(-2);
		return false;
	}

	const marker = readU8(slice);
	return marker === Amf0TypeMarker.ObjectEnd;
};

const parseAmfValue = (slice: FileSlice): AmfValue | undefined => {
	if (slice.remainingLength < 1) {
		return undefined;
	}

	const marker = readU8(slice);

	switch (marker) {
		case Amf0TypeMarker.Number: {
			if (slice.remainingLength < 8) {
				return undefined;
			}
			return readF64Be(slice);
		}

		case Amf0TypeMarker.Boolean: {
			if (slice.remainingLength < 1) {
				return undefined;
			}
			return readU8(slice) !== 0;
		}

		case Amf0TypeMarker.String: {
			if (slice.remainingLength < 2) {
				return undefined;
			}
			return readAmfString(slice, false);
		}

		case Amf0TypeMarker.LongString: {
			if (slice.remainingLength < 2) {
				return undefined;
			}
			return readAmfString(slice, true);
		}

		case Amf0TypeMarker.Null:
		case Amf0TypeMarker.Undefined:
		case Amf0TypeMarker.Unsupported: {
			return null;
		}

		case Amf0TypeMarker.Date: {
			if (slice.remainingLength < 10) {
				return undefined;
			}
			const value = readF64Be(slice);
			slice.skip(2); // UTC offset, ignored
			return value;
		}

		case Amf0TypeMarker.Object:
		case Amf0TypeMarker.EcmaArray: {
			if (marker === Amf0TypeMarker.EcmaArray) {
				if (slice.remainingLength < 4) {
					return undefined;
				}
				slice.skip(4); // Associative count, which is unreliable and therefore ignored
			}

			const object: Record<string, AmfValue> = {};

			while (slice.remainingLength >= 2) {
				if (readObjectEnd(slice)) {
					return object;
				}

				const keyLength = readU16Be(slice);
				if (slice.remainingLength < keyLength) {
					return undefined;
				}
				const key = readAscii(slice, keyLength);

				const value = parseAmfValue(slice);
				if (value === undefined) {
					return object;
				}

				object[key] = value;
			}

			return object;
		}

		case Amf0TypeMarker.StrictArray: {
			if (slice.remainingLength < 4) {
				return undefined;
			}
			const count = readU32FromSlice(slice);
			const array: AmfValue[] = [];

			for (let i = 0; i < count; i++) {
				const value = parseAmfValue(slice);
				if (value === undefined) {
					break;
				}
				array.push(value);
			}

			return array;
		}

		case Amf0TypeMarker.Reference: {
			if (slice.remainingLength < 2) {
				return undefined;
			}
			slice.skip(2); // References are not needed for metadata parsing
			return null;
		}

		default: {
			Logging._warn(`Encountered unsupported AMF0 type marker ${marker}.`);
			return undefined;
		}
	}
};

const readU32FromSlice = (slice: FileSlice): number => {
	let value = 0;
	for (let i = 0; i < 4; i++) {
		value = value * 256 + readU8(slice);
	}
	return value;
};

/**
 * Parses an FLV script-data tag body. The body is expected to start with an AMF0 string (usually `'onMetaData'`)
 * followed by an AMF0 object/array. Returns the parsed metadata object, or null if the tag didn't contain any.
 */
export const parseFlvScriptData = (slice: FileSlice): Record<string, AmfValue> | null => {
	try {
		if (slice.remainingLength < 3) {
			return null;
		}

		const firstMarker = readU8(slice);
		if (firstMarker !== Amf0TypeMarker.String || slice.remainingLength < 2) {
			return null;
		}

		// The handler name (e.g. "onMetaData"); its value isn't needed
		readAmfString(slice, false);

		const metadata = parseAmfValue(slice);
		if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
			return metadata as Record<string, AmfValue>;
		}

		return null;
	} catch (error) {
		Logging._warn('Error while parsing FLV script-data tag:', error);
		return null;
	}
};

export type FlvKeyframeIndex = {
	times: number[];
	filePositions: number[];
};

/** Extracts the optional `keyframes` seek index (times in seconds and byte positions) from parsed metadata. */
export const extractFlvKeyframeIndex = (metadata: Record<string, AmfValue>): FlvKeyframeIndex | null => {
	const keyframes = metadata['keyframes'];
	if (!keyframes || typeof keyframes !== 'object' || Array.isArray(keyframes)) {
		return null;
	}

	const times = (keyframes as Record<string, AmfValue>)['times'];
	// ffmpeg writes the all-lowercase `filepositions`, while other tooling follows the camelCase convention
	const filePositions = (keyframes as Record<string, AmfValue>)['filepositions']
		?? (keyframes as Record<string, AmfValue>)['filePositions'];

	if (
		!Array.isArray(times)
		|| !Array.isArray(filePositions)
		|| times.length === 0
		|| times.length !== filePositions.length
	) {
		return null;
	}

	if (!times.every(x => typeof x === 'number') || !filePositions.every(x => typeof x === 'number')) {
		return null;
	}

	return {
		times: times.filter((x): x is number => typeof x === 'number'),
		filePositions: filePositions.filter((x): x is number => typeof x === 'number'),
	};
};

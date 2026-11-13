/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	Av1CodecInfo,
	av1CodecInfoHasColorInfo,
	extractAv1CodecInfoFromPacket,
	iterateAv1PacketObus,
} from '../codec-data';
import {
	COLOR_PRIMARIES_MAP_INVERSE,
	MATRIX_COEFFICIENTS_MAP_INVERSE,
	TRANSFER_CHARACTERISTICS_MAP_INVERSE,
} from '../misc';
import { Bitstream } from '../../shared/bitstream';

/**
 * Parsed information from an Enhanced FLV AV1 sequence start tag. The payload is an AV1CodecConfigurationRecord (the
 * same `av1C` box payload used in ISOBMFF).
 */
export type FlvAv1Config = {
	codecInfo: Av1CodecInfo;
	width: number;
	height: number;
	colorSpace: VideoColorSpaceInit;
};

/**
 * Parses an AV1CodecConfigurationRecord. Layout (big-endian):
 *   byte 0: marker(1) version(7)
 *   byte 1: profile(3) level(5)
 *   byte 2: tier(1) highBitdepth(1) twelveBit(1) monochrome(1) chromaSubsamplingX(1) chromaSubsamplingY(1)
 *           chromaSamplePosition(2)
 *   byte 3: reserved/initial presentation delay
 *   byte 4..: config OBUs (temporal delimiter + sequence header + metadata)
 */
export const parseFlvAv1ConfigRecord = (record: Uint8Array): FlvAv1Config | null => {
	if (record.byteLength < 4) {
		return null;
	}

	const secondByte = record[1]!;
	const profile = secondByte >> 5;
	const level = secondByte & 0b11111;

	const thirdByte = record[2]!;
	const tier = thirdByte >> 7;
	const highBitDepth = (thirdByte >> 6) & 1;
	const twelveBit = (thirdByte >> 5) & 1;
	const monochrome = (thirdByte >> 4) & 1;
	const chromaSubsamplingX = (thirdByte >> 3) & 1;
	const chromaSubsamplingY = (thirdByte >> 2) & 1;
	const chromaSamplePosition = thirdByte & 0b11;

	const bitDepth = profile === 2 && highBitDepth ? (twelveBit ? 12 : 10) : (highBitDepth ? 10 : 8);

	const configObus = record.subarray(4);
	const obuInfo = extractAv1CodecInfoFromPacket(configObus);
	const dimensions = extractAv1Dimensions(configObus);

	if (!dimensions) {
		return null;
	}

	const codecInfo: Av1CodecInfo = {
		profile,
		level,
		tier,
		bitDepth,
		monochrome,
		chromaSubsamplingX,
		chromaSubsamplingY,
		chromaSamplePosition,
		videoFullRangeFlag: obuInfo?.videoFullRangeFlag ?? 0,
		colourPrimaries: obuInfo?.colourPrimaries ?? 2,
		transferCharacteristics: obuInfo?.transferCharacteristics ?? 2,
		matrixCoefficients: obuInfo?.matrixCoefficients ?? 2,
	};

	let colorSpace: VideoColorSpaceInit = {
		primaries: null,
		transfer: null,
		matrix: null,
		fullRange: null,
	};
	if (obuInfo && av1CodecInfoHasColorInfo(obuInfo)) {
		colorSpace = {
			primaries: COLOR_PRIMARIES_MAP_INVERSE[obuInfo.colourPrimaries] as
			VideoColorPrimaries | undefined,
			transfer: TRANSFER_CHARACTERISTICS_MAP_INVERSE[obuInfo.transferCharacteristics] as
			VideoTransferCharacteristics | undefined,
			matrix: MATRIX_COEFFICIENTS_MAP_INVERSE[obuInfo.matrixCoefficients] as
			VideoMatrixCoefficients | undefined,
			fullRange: !!obuInfo.videoFullRangeFlag,
		};
	}

	return {
		codecInfo,
		width: dimensions.width,
		height: dimensions.height,
		colorSpace,
	};
};

/** Reads an unsigned variable-length integer (uvlc). */
const readUvlc = (bitstream: Bitstream): number => {
	let leadingZeros = 0;
	while (bitstream.getBitsLeft() > 0 && bitstream.readBits(1) === 0) {
		leadingZeros++;
	}
	let value = 0;
	for (let i = 0; i < leadingZeros; i++) {
		value = (value << 1) | bitstream.readBits(1);
	}
	return value + 2 ** leadingZeros - 1;
};

/**
 * Extracts the coded frame dimensions from an AV1 sequence header OBU. This is a focused port of the sequence-header
 * parsing in `extractAv1CodecInfoFromPacket`, stopping once the frame size fields have been read.
 */
export const extractAv1Dimensions = (configObus: Uint8Array): { width: number; height: number } | null => {
	for (const { type, data } of iterateAv1PacketObus(configObus)) {
		if (type !== 1) {
			continue; // 1 == OBU_SEQUENCE_HEADER
		}

		const bitstream = new Bitstream(data);

		bitstream.skipBits(3); // seq_profile
		bitstream.skipBits(1); // still_picture
		const reducedStillPictureHeader = bitstream.readBits(1);

		let decoderModelInfoPresentFlag = 0;

		if (!reducedStillPictureHeader) {
			const timingInfoPresentFlag = bitstream.readBits(1);
			let bufferDelayLengthMinus1 = 0;

			if (timingInfoPresentFlag) {
				bitstream.skipBits(32); // num_units_in_display_tick
				bitstream.skipBits(32); // time_scale
				const equalPictureInterval = bitstream.readBits(1);
				if (equalPictureInterval) {
					readUvlc(bitstream); // num_ticks_per_picture_minus_1
				}
				decoderModelInfoPresentFlag = bitstream.readBits(1);
				if (decoderModelInfoPresentFlag) {
					bufferDelayLengthMinus1 = bitstream.readBits(5);
					bitstream.skipBits(32); // num_units_in_decoding_tick
					bitstream.skipBits(5); // buffer_removal_time_length_minus_1
					bitstream.skipBits(5); // frame_presentation_time_length_minus_1
				}
			}

			const initialDisplayDelayPresentFlag = bitstream.readBits(1);
			const operatingPointsCntMinus1 = bitstream.readBits(5);

			for (let i = 0; i <= operatingPointsCntMinus1; i++) {
				bitstream.skipBits(12); // operating_point_idc
				const seqLevelIdx = bitstream.readBits(5);
				if (seqLevelIdx > 7) {
					bitstream.skipBits(1); // seq_tier
				}
				if (decoderModelInfoPresentFlag) {
					const decoderModelPresentForThisOp = bitstream.readBits(1);
					if (decoderModelPresentForThisOp) {
						bitstream.skipBits(bufferDelayLengthMinus1 + 1); // decoder_buffer_delay
						bitstream.skipBits(bufferDelayLengthMinus1 + 1); // encoder_buffer_delay
						bitstream.skipBits(1); // low_delay_mode_flag
					}
				}
				if (initialDisplayDelayPresentFlag) {
					bitstream.skipBits(4); // initial_display_delay_minus_1
				}
			}
		}

		const frameWidthBitsMinus1 = bitstream.readBits(4);
		const frameHeightBitsMinus1 = bitstream.readBits(4);
		// These are fixed-width fields (f(n)), where n is the preceding "*BitsMinus1" value plus one
		const maxFrameWidthMinus1 = bitstream.readBits(frameWidthBitsMinus1 + 1);
		const maxFrameHeightMinus1 = bitstream.readBits(frameHeightBitsMinus1 + 1);

		return {
			width: maxFrameWidthMinus1 + 1,
			height: maxFrameHeightMinus1 + 1,
		};
	}

	return null;
};

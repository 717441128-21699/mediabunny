/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { aacChannelMap, aacFrequencyTable, buildAacAudioSpecificConfig } from '../../shared/aac-misc';
import { MAX_ADTS_FRAME_HEADER_SIZE, MIN_ADTS_FRAME_HEADER_SIZE, readAdtsFrameHeader } from '../adts/adts-reader';
import { validateAudioChunkMetadata, validateVideoChunkMetadata } from '../codec';
import {
	AvcDecoderConfigurationRecord,
	concatNalUnitsInLengthPrefixed,
	deserializeAvcDecoderConfigurationRecord,
	deserializeHevcDecoderConfigurationRecord,
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	HevcDecoderConfigurationRecord,
	iterateNalUnitsInAnnexB,
	iterateNalUnitsInLengthPrefixed,
	serializeAvcDecoderConfigurationRecord,
	serializeHevcDecoderConfigurationRecord,
} from '../codec-data';
import { assert, toUint8Array } from '../misc';
import { Muxer } from '../muxer';
import { Output, OutputAudioTrack, OutputVideoTrack } from '../output';
import { FlvOutputFormat } from '../output-format';
import { EncodedPacket } from '../packet';
import { FileSlice } from '../reader';
import { Writer } from '../writer';
import {
	FLV_ENHANCED_VIDEO_MASK,
	FLV_FOURCC_AV1,
	FLV_FOURCC_HEVC,
	FLV_HEADER_SIZE,
	FlvAacPacketType,
	FlvEnhancedFrameType,
	FlvSoundFormat,
	FlvTagType,
	FlvVideoPacketType,
	secondsToFlvTimestamp,
	writeU24,
	writeU32,
} from './flv-misc';

const FLV_TAG_HEADER_SIZE = 11;
const PREV_TAG_SIZE_FIELD_SIZE = 4;

type FlvTrackData = {
	track: OutputVideoTrack | OutputAudioTrack;
	kind: 'video' | 'audio';
	codec: string;
	headerWritten: boolean;
};

type VideoTrackData = FlvTrackData & {
	kind: 'video';
	codec: 'avc' | 'hevc' | 'av1';
	enhanced: boolean;
	avcConfig: AvcDecoderConfigurationRecord | null;
	hevcConfig: HevcDecoderConfigurationRecord | null;
	/** Whether incoming AVC/HEVC packets are Annex B (no decoder description) rather than length-prefixed. */
	inputIsAnnexB: boolean;
};

type AudioTrackData = FlvTrackData & {
	kind: 'audio';
	codec: 'aac' | 'mp3';
	/** Whether incoming AAC packets carry ADTS headers that must be stripped. */
	inputIsAdts: boolean;
	soundRateIndex: number;
	soundType: number;
};

export class FlvMuxer extends Muxer {
	private format: FlvOutputFormat;
	private writer!: Writer;
	private trackDatas: FlvTrackData[] = [];
	private flvHeaderWritten = false;

	constructor(output: Output, format: FlvOutputFormat) {
		super(output);
		this.format = format;
	}

	async start() {
		const release = await this.mutex.acquire();
		this.writer = await this.output._getRootWriter(true);
		release();
	}

	async getMimeType() {
		return this.format.mimeType;
	}

	private getVideoTrackData(track: OutputVideoTrack, meta?: EncodedVideoChunkMetadata): VideoTrackData {
		const existing = this.trackDatas.find(x => x.track === track) as VideoTrackData | undefined;
		if (existing) {
			return existing;
		}

		validateVideoChunkMetadata(meta, track.source._codec);
		assert(meta?.decoderConfig);
		const codec = track.source._codec;
		assert(codec === 'avc' || codec === 'hevc' || codec === 'av1');

		const enhanced = codec !== 'avc'; // HEVC and AV1 always use the Enhanced FLV FourCC layout
		const description = meta.decoderConfig.description;
		const inputIsAnnexB = !description;

		let avcConfig: AvcDecoderConfigurationRecord | null = null;
		let hevcConfig: HevcDecoderConfigurationRecord | null = null;
		if (!inputIsAnnexB) {
			const bytes = toUint8Array(description);
			if (codec === 'avc') {
				avcConfig = deserializeAvcDecoderConfigurationRecord(bytes);
			} else if (codec === 'hevc') {
				hevcConfig = deserializeHevcDecoderConfigurationRecord(bytes);
			}
		}

		const trackData: VideoTrackData = {
			track,
			kind: 'video',
			codec,
			enhanced,
			avcConfig,
			hevcConfig,
			inputIsAnnexB,
			headerWritten: false,
		};
		this.trackDatas.push(trackData);
		return trackData;
	}

	private getAudioTrackData(track: OutputAudioTrack, meta?: EncodedAudioChunkMetadata): AudioTrackData {
		const existing = this.trackDatas.find(x => x.track === track) as AudioTrackData | undefined;
		if (existing) {
			return existing;
		}

		validateAudioChunkMetadata(meta, track.source._codec);
		assert(meta?.decoderConfig);
		const codec = track.source._codec;
		assert(codec === 'aac' || codec === 'mp3');

		const description = meta.decoderConfig.description;
		const inputIsAdts = codec === 'aac' && !description;

		const sampleRate = meta.decoderConfig.sampleRate;
		const numberOfChannels = meta.decoderConfig.numberOfChannels;

		const trackData: AudioTrackData = {
			track,
			kind: 'audio',
			codec,
			inputIsAdts,
			soundRateIndex: sampleRateToFlvIndex(sampleRate),
			soundType: numberOfChannels >= 2 ? 1 : 0,
			headerWritten: false,
		};
		this.trackDatas.push(trackData);
		return trackData;
	}

	async addEncodedVideoPacket(track: OutputVideoTrack, packet: EncodedPacket, meta?: EncodedVideoChunkMetadata) {
		const release = await this.mutex.acquire();
		try {
			const trackData = this.getVideoTrackData(track, meta);
			this.validateTimestamp(track, packet.timestamp, packet.type === 'key');
			this.ensureFlvHeader();

			if (!trackData.headerWritten) {
				this.writeVideoSequenceHeader(trackData, meta!, packet);
				trackData.headerWritten = true;
			}

			const payload = this.buildVideoFramePayload(trackData, packet);
			this.writeTag(FlvTagType.VIDEO, payload, packet.timestamp);
			await this.writer.flush();
		} finally {
			release();
		}
	}

	async addEncodedAudioPacket(track: OutputAudioTrack, packet: EncodedPacket, meta?: EncodedAudioChunkMetadata) {
		const release = await this.mutex.acquire();
		try {
			const trackData = this.getAudioTrackData(track, meta);
			this.validateTimestamp(track, packet.timestamp, packet.type === 'key');
			this.ensureFlvHeader();

			if (!trackData.headerWritten) {
				this.writeAudioSequenceHeader(trackData, meta!, packet);
				trackData.headerWritten = true;
			}

			const payload = this.buildAudioFramePayload(trackData, packet);
			if (payload) {
				this.writeTag(FlvTagType.AUDIO, payload, packet.timestamp);
			}
			await this.writer.flush();
		} finally {
			release();
		}
	}

	async addSubtitleCue(): Promise<void> {
		throw new Error('FLV does not support subtitles.');
	}

	async finalize() {
		const release = await this.mutex.acquire();
		try {
			this.ensureFlvHeader();
			await this.writer.flush();
			await this.writer.finalize();
		} finally {
			release();
		}
	}

	private ensureFlvHeader() {
		if (this.flvHeaderWritten) {
			return;
		}

		const hasAudio = this.trackDatas.some(x => x.kind === 'audio');
		const hasVideo = this.trackDatas.some(x => x.kind === 'video');

		const header = new Uint8Array(FLV_HEADER_SIZE);
		header[0] = 0x46; // 'F'
		header[1] = 0x4c; // 'L'
		header[2] = 0x56; // 'V'
		header[3] = 0x01; // Version 1
		header[4] = (hasAudio ? 0b0000_0001 : 0) | (hasVideo ? 0b0000_0100 : 0);
		// Data offset (bytes 5-8): always 9 for a header with no extra fields
		header[8] = 9;
		// PreviousTagSize0 (bytes 9-12): 0

		this.writer.write(header);
		this.flvHeaderWritten = true;
	}

	private writeVideoSequenceHeader(
		trackData: VideoTrackData,
		meta: EncodedVideoChunkMetadata,
		firstPacket: EncodedPacket,
	) {
		assert(meta.decoderConfig);
		if (trackData.codec === 'avc' && !trackData.enhanced) {
			const config = this.ensureAvcConfig(trackData, meta, firstPacket);
			const record = serializeAvcDecoderConfigurationRecord(config);

			// Legacy AVC: [0x17 (key+AVC)][0x00 (sequence header)][CTS 24-bit = 0][record]
			const payload = new Uint8Array(5 + record.byteLength);
			payload[0] = (FlvVideoFrame.KEY << 4) | FlvLegacyVideoCodec.AVC;
			payload[1] = 0x00; // AVC sequence header
			payload.set(record, 5);
			this.writeTag(FlvTagType.VIDEO, payload, 0);
			return;
		}

		if (trackData.codec === 'hevc') {
			const config = this.ensureHevcConfig(trackData, meta, firstPacket);
			const record = serializeHevcDecoderConfigurationRecord(config);

			// Enhanced: [IsExHeader|SEQUENCE_START(0)][FourCC 'hvc1'][record]
			const payload = new Uint8Array(5 + record.byteLength);
			payload[0] = buildEnhancedVideoByte(FlvVideoPacketType.SEQUENCE_START, FlvEnhancedFrameType.KEY);
			setFourCc(payload, 1, FLV_FOURCC_HEVC);
			payload.set(record, 5);
			this.writeTag(FlvTagType.VIDEO, payload, 0);
			return;
		}

		if (trackData.codec === 'av1') {
			// Enhanced AV1: the AV1CodecConfigurationRecord comes straight from the decoder description
			const description = meta.decoderConfig.description;
			if (!description) {
				throw new Error('AV1 FLV output requires a decoder configuration record (description).');
			}
			const record = toUint8Array(description);

			const payload = new Uint8Array(5 + record.byteLength);
			payload[0] = buildEnhancedVideoByte(FlvVideoPacketType.SEQUENCE_START, FlvEnhancedFrameType.KEY);
			setFourCc(payload, 1, FLV_FOURCC_AV1);
			payload.set(record, 5);
			this.writeTag(FlvTagType.VIDEO, payload, 0);
		}
	}

	private ensureAvcConfig(
		trackData: VideoTrackData,
		meta: EncodedVideoChunkMetadata,
		firstPacket: EncodedPacket,
	): AvcDecoderConfigurationRecord {
		assert(meta.decoderConfig);
		if (trackData.avcConfig) {
			return trackData.avcConfig;
		}
		const description = meta.decoderConfig.description;
		if (description) {
			trackData.avcConfig = deserializeAvcDecoderConfigurationRecord(toUint8Array(description));
			assert(trackData.avcConfig);
			return trackData.avcConfig;
		}
		// Annex B input: synthesize the record from the parameter sets embedded in the first packet
		trackData.avcConfig = extractAvcDecoderConfigurationRecord(firstPacket.data);
		if (!trackData.avcConfig) {
			throw new Error(
				'Could not extract an AVCDecoderConfigurationRecord from the first AVC packet. Provide a decoder'
				+ ' configuration record or ensure the first key frame contains SPS/PPS NAL units.',
			);
		}
		return trackData.avcConfig;
	}

	private ensureHevcConfig(
		trackData: VideoTrackData,
		meta: EncodedVideoChunkMetadata,
		firstPacket: EncodedPacket,
	): HevcDecoderConfigurationRecord {
		assert(meta.decoderConfig);
		if (trackData.hevcConfig) {
			return trackData.hevcConfig;
		}
		const description = meta.decoderConfig.description;
		if (description) {
			trackData.hevcConfig = deserializeHevcDecoderConfigurationRecord(toUint8Array(description));
			assert(trackData.hevcConfig);
			return trackData.hevcConfig;
		}
		// Annex B input: synthesize the record from the VPS/SPS/PPS NAL units in the first packet
		trackData.hevcConfig = extractHevcDecoderConfigurationRecord(firstPacket.data);
		if (!trackData.hevcConfig) {
			throw new Error(
				'Could not extract an HEVCDecoderConfigurationRecord from the first HEVC packet. Provide a decoder'
				+ ' configuration record or ensure the first key frame contains VPS/SPS/PPS NAL units.',
			);
		}
		return trackData.hevcConfig;
	}

	private buildVideoFramePayload(trackData: VideoTrackData, packet: EncodedPacket): Uint8Array {
		const isKey = packet.type === 'key';

		if (trackData.codec === 'avc' && !trackData.enhanced) {
			const avccData = this.toLengthPrefixed(trackData, packet.data);
			// Legacy AVC: [frameType|0x07][0x01 (NALU)][CTS 24-bit][AVCC data]. FLV stores DTS as the tag timestamp
			// and the PTS-DTS difference in the composition-time field; the muxer only receives PTS, so CTS is 0.
			const payload = new Uint8Array(5 + avccData.byteLength);
			payload[0] = ((isKey ? FlvVideoFrame.KEY : FlvVideoFrame.INTER) << 4) | FlvLegacyVideoCodec.AVC;
			payload[1] = 0x01; // AVC NALU
			payload.set(avccData, 5);
			return payload;
		}

		if (trackData.codec === 'hevc') {
			const naluBody = this.buildEnhancedNaluBody(trackData, packet.data);
			// Enhanced HEVC coded frame: [IsExHeader|FrameType|CODED_FRAMES(1)][FourCC][3-byte prefix][4-byte NALUs]
			const payload = new Uint8Array(5 + naluBody.byteLength);
			payload[0] = buildEnhancedVideoByte(
				FlvVideoPacketType.CODED_FRAMES,
				isKey ? FlvEnhancedFrameType.KEY : FlvEnhancedFrameType.INTER,
			);
			setFourCc(payload, 1, FLV_FOURCC_HEVC);
			payload.set(naluBody, 5);
			return payload;
		}

		// AV1: pass the low-overhead bitstream temporal unit through unchanged
		const payload = new Uint8Array(5 + packet.data.byteLength);
		payload[0] = buildEnhancedVideoByte(
			FlvVideoPacketType.CODED_FRAMES,
			isKey ? FlvEnhancedFrameType.KEY : FlvEnhancedFrameType.INTER,
		);
		setFourCc(payload, 1, FLV_FOURCC_AV1);
		payload.set(packet.data, 5);
		return payload;
	}

	/**
	 * Converts an incoming AVC/HEVC packet into the 4-byte length-prefixed framing required inside FLV. Annex B input
	 * (start codes) is converted directly; already length-prefixed input is normalized to the configured length size.
	 */
	private toLengthPrefixed(trackData: VideoTrackData, data: Uint8Array): Uint8Array {
		if (trackData.codec === 'avc') {
			const config = trackData.avcConfig;
			if (trackData.inputIsAnnexB || !config) {
				return annexBToLengthPrefixed(data, 4);
			}
			const lengthSize = (config.lengthSizeMinusOne + 1) as 1 | 2 | 3 | 4;
			return normalizeLengthPrefixed(data, lengthSize, 4);
		}

		// HEVC FLV always uses 4-byte lengths
		if (trackData.inputIsAnnexB || !trackData.hevcConfig) {
			return annexBToLengthPrefixed(data, 4);
		}
		return normalizeLengthPrefixed(data, 4, 4);
	}

	/**
	 * Builds the body of an Enhanced FLV (HEVC) coded-frame tag. Enhanced RTMP places a three-byte, ffmpeg-private
	 * context field (emitted as zeroes, which ffmpeg and other tolerant readers ignore) before the four-byte
	 * length-prefixed NAL units.
	 */
	private buildEnhancedNaluBody(trackData: VideoTrackData, data: Uint8Array): Uint8Array {
		const lengthPrefixed = this.toLengthPrefixed(trackData, data);
		const ENHANCED_PREFIX_SIZE = 3;
		const body = new Uint8Array(ENHANCED_PREFIX_SIZE + lengthPrefixed.byteLength);
		// The three-byte prefix stays zero; it carries no information required for decoding.
		body.set(lengthPrefixed, ENHANCED_PREFIX_SIZE);
		return body;
	}

	private writeAudioSequenceHeader(
		trackData: AudioTrackData,
		meta: EncodedAudioChunkMetadata,
		firstPacket: EncodedPacket,
	) {
		assert(meta.decoderConfig);
		const soundByte = this.buildSoundByte(trackData);

		if (trackData.codec === 'aac') {
			let configBytes: Uint8Array;
			const description = meta.decoderConfig.description;
			if (description) {
				// The decoder description for AAC is the AudioSpecificConfig
				configBytes = toUint8Array(description);
			} else {
				// Derive the AudioSpecificConfig from the first ADTS frame
				const adtsFrame = readAdtsFrameHeader(FileSlice.tempFromBytes(firstPacket.data));
				if (!adtsFrame) {
					throw new Error('Could not parse ADTS header from the first AAC packet.');
				}
				const sampleRate = aacFrequencyTable[adtsFrame.samplingFrequencyIndex] ?? 44100;
				const numberOfChannels = aacChannelMap[adtsFrame.channelConfiguration] ?? 2;
				configBytes = buildAacAudioSpecificConfig({
					objectType: adtsFrame.objectType,
					outputSampleRate: sampleRate,
					outputNumberOfChannels: numberOfChannels,
				});
			}

			// [soundByte][0x00 (AAC sequence header)][AudioSpecificConfig]
			const payload = new Uint8Array(2 + configBytes.byteLength);
			payload[0] = soundByte;
			payload[1] = FlvAacPacketType.SEQUENCE_HEADER;
			payload.set(configBytes, 2);
			this.writeTag(FlvTagType.AUDIO, payload, 0);
		}
		// MP3 has no sequence header; nothing to write here
	}

	private buildAudioFramePayload(trackData: AudioTrackData, packet: EncodedPacket): Uint8Array | null {
		const soundByte = this.buildSoundByte(trackData);

		if (trackData.codec === 'aac') {
			let rawData = packet.data;
			if (trackData.inputIsAdts) {
				const adtsFrame = readAdtsFrameHeader(FileSlice.tempFromBytes(rawData));
				if (!adtsFrame) {
					return null; // Skip malformed ADTS frames rather than corrupting the output
				}
				const headerLength = adtsFrame.crcCheck === null
					? MIN_ADTS_FRAME_HEADER_SIZE
					: MAX_ADTS_FRAME_HEADER_SIZE;
				rawData = rawData.subarray(headerLength);
			}
			const payload = new Uint8Array(2 + rawData.byteLength);
			payload[0] = soundByte;
			payload[1] = FlvAacPacketType.RAW;
			payload.set(rawData, 2);
			return payload;
		}

		// MP3: the sound header byte followed by the raw MP3 frame(s)
		const payload = new Uint8Array(1 + packet.data.byteLength);
		payload[0] = soundByte;
		payload.set(packet.data, 1);
		return payload;
	}

	private buildSoundByte(trackData: AudioTrackData): number {
		const soundFormat = trackData.codec === 'aac' ? FlvSoundFormat.AAC : FlvSoundFormat.MP3;
		// Sound size: AAC and MP3 are always 16-bit samples
		const soundSize = 1;
		return (soundFormat << 4)
			| ((trackData.soundRateIndex & 0b11) << 2)
			| ((soundSize & 0b01) << 1)
			| (trackData.soundType & 0b01);
	}

	/**
	 * Writes one complete FLV tag (header + payload) plus its PreviousTagSize field. The timestamp is normalized
	 * through Euclid modding so negative or wrapping values encode deterministically; the demuxer restores the sign.
	 */
	private writeTag(tagType: FlvTagType, payload: Uint8Array, timestampSeconds: number) {
		const timestamp = secondsToFlvTimestamp(timestampSeconds + (this.format._options.timestampOffset ?? 0));
		const timestampLow = timestamp & 0xffffff;
		const timestampExtended = (timestamp >>> 24) & 0xff;

		const header = new Uint8Array(FLV_TAG_HEADER_SIZE);
		header[0] = tagType;
		writeU24(header, 1, payload.byteLength);
		writeU24(header, 4, timestampLow);
		header[7] = timestampExtended;
		// Bytes 8-10 are the stream id, always 0

		this.writer.write(header);
		this.writer.write(payload);

		const prevTagSize = new Uint8Array(PREV_TAG_SIZE_FIELD_SIZE);
		writeU32(prevTagSize, 0, FLV_TAG_HEADER_SIZE + payload.byteLength);
		this.writer.write(prevTagSize);
	}
}

// Legacy FLV video frame-type nibble values
const enum FlvVideoFrame {
	KEY = 1,
	INTER = 2,
}

// Legacy FLV video codec id nibble values
const enum FlvLegacyVideoCodec {
	AVC = 7,
}

/**
 * Builds the first byte of an Enhanced FLV video tag: the IsExHeader flag (0x80), the frame type in bits 4-6, and the
 * packet type in the low nibble.
 */
const buildEnhancedVideoByte = (packetType: FlvVideoPacketType, frameType: FlvEnhancedFrameType): number => {
	return FLV_ENHANCED_VIDEO_MASK | ((frameType & 0x07) << 4) | (packetType & 0x0f);
};

const setFourCc = (bytes: Uint8Array, offset: number, fourCc: string) => {
	for (let i = 0; i < 4; i++) {
		bytes[offset + i] = fourCc.charCodeAt(i);
	}
};

/** The FLV sound-rate field only encodes four rates; pick the closest supported index. */
const sampleRateToFlvIndex = (sampleRate: number): number => {
	const rates = [5512, 11025, 22050, 44100];
	let bestIndex = 3;
	let bestDifference = Infinity;
	for (let i = 0; i < rates.length; i++) {
		const difference = Math.abs(rates[i]! - sampleRate);
		if (difference < bestDifference) {
			bestDifference = difference;
			bestIndex = i;
		}
	}
	return bestIndex;
};

const annexBToLengthPrefixed = (data: Uint8Array, lengthSize: 1 | 2 | 3 | 4): Uint8Array => {
	const nalUnits: Uint8Array[] = [];
	for (const loc of iterateNalUnitsInAnnexB(data)) {
		nalUnits.push(data.subarray(loc.offset, loc.offset + loc.length));
	}
	return concatNalUnitsInLengthPrefixed(nalUnits, lengthSize);
};

/**
 * Rewrites length-prefixed NAL units that use one length size into another by round-tripping through individual units.
 */
const normalizeLengthPrefixed = (
	data: Uint8Array,
	fromLengthSize: 1 | 2 | 3 | 4,
	toLengthSize: 1 | 2 | 3 | 4,
): Uint8Array => {
	const nalUnits: Uint8Array[] = [];
	for (const loc of iterateNalUnitsInLengthPrefixed(data, fromLengthSize)) {
		nalUnits.push(data.subarray(loc.offset, loc.offset + loc.length));
	}
	return concatNalUnitsInLengthPrefixed(nalUnits, toLengthSize);
};

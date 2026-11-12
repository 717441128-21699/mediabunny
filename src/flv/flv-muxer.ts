/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	aacChannelMap,
	aacFrequencyTable,
	buildAacAudioSpecificConfig,
} from '../../shared/aac-misc';
import { MAX_ADTS_FRAME_HEADER_SIZE, MIN_ADTS_FRAME_HEADER_SIZE, readAdtsFrameHeader } from '../adts/adts-reader';
import { validateAudioChunkMetadata, validateVideoChunkMetadata } from '../codec';
import {
	concatNalUnitsInLengthPrefixed,
	deserializeAvcDecoderConfigurationRecord,
	deserializeHevcDecoderConfigurationRecord,
	extractAvcDecoderConfigurationRecord,
	extractHevcDecoderConfigurationRecord,
	iterateNalUnitsInAnnexB,
	iterateNalUnitsInLengthPrefixed,
	serializeAvcDecoderConfigurationRecord,
	serializeHevcDecoderConfigurationRecord,
} from '../codec-data';
import { generateAv1CodecConfigurationFromCodecString } from '../codec';
import { FileSlice } from '../reader';
import { assert, modEuclid, promiseWithResolvers, toDataView, toUint8Array } from '../misc';
import { Muxer } from '../muxer';
import { Output, OutputAudioTrack, OutputTrack, OutputVideoTrack } from '../output';
import { FlvOutputFormat } from '../output-format';
import { EncodedPacket } from '../packet';
import { Writer } from '../writer';
import {
	buildFlvMimeType,
	ENHANCED_FLV_INTER_FRAME_MARKER,
	ENHANCED_FLV_KEY_FRAME_MARKER,
	FlvAACPacketType,
	FlvAvcPacketType,
	FlvEnhancedPacketType,
	FlvFrameType,
	FLV_FOURCC_AV01,
	FLV_FOURCC_HVC1,
	FLV_HEADER_SIZE,
	FLV_SIGNATURE,
	FLV_TAG_HEADER_SIZE,
	FLV_TIMESTAMP_MODULUS,
	FLV_TIMESCALE,
	FLV_VERSION,
	FlvSoundFormat,
	FlvTagType,
	FlvVideoCodecId,
	PREVIOUS_TAG_SIZE_SIZE,
	secondsToFlvTimestamp,
	writeFourCc,
} from './flv-misc';

// Resources:
// Adobe Flash Video File Format Specification Version 10.1
// Adobe's Enhanced FLV / Enhanced RTMP specification (ExVideoTag, FourCC)

type FlvTrackData = {
	kind: 'video' | 'audio';
	track: OutputVideoTrack | OutputAudioTrack;
	codecString: string;
	timestampProcessingQueue: QueuedPacket[];
	packetQueue: QueuedPacket[];
	closed: boolean;
	sequenceHeaderWritten: boolean;
};

type VideoTrackData = FlvTrackData & {
	kind: 'video';
	codec: 'avc' | 'hevc' | 'av1';
	/** Raw decoder configuration record bytes (AVCC/HVCC), or null for AV1 (which derives its own record). */
	description: Uint8Array | null;
	/** NAL length size when the input is length-prefixed; null while the input format is still unknown. */
	lengthSize: 1 | 2 | 3 | 4 | null;
	/** Whether input video arrives as Annex B instead of length-prefixed NAL units. */
	inputIsAnnexB: boolean;
};

type AudioTrackData = FlvTrackData & {
	kind: 'audio';
	codec: 'aac' | 'mp3';
	/** Raw AudioSpecificConfig bytes for AAC, or null for MP3. */
	description: Uint8Array | null;
	/** Whether input AAC arrives as ADTS frames instead of raw frames. */
	inputIsAdts: boolean;
};

type QueuedPacket = {
	data: Uint8Array;
	presentationTimestamp: number;
	decodeTimestamp: number | null;
	isKeyframe: boolean;
};

type AnyFlvTrackData = VideoTrackData | AudioTrackData;

const clampS24 = (value: number) => {
	return Math.max(-0x800000, Math.min(0x7fffff, value));
};

export class FlvMuxer extends Muxer {
	private format: FlvOutputFormat;
	private writer!: Writer;

	private trackDatas: AnyFlvTrackData[] = [];
	private headerWritten = false;
	private allTracksKnown = promiseWithResolvers();

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
		await this.allTracksKnown.promise;
		return buildFlvMimeType(this.trackDatas.map(x => x.codecString));
	}

	private getVideoTrackData(
		track: OutputVideoTrack,
		packet: EncodedPacket,
		meta?: EncodedVideoChunkMetadata,
	): VideoTrackData {
		const existingTrackData = this.trackDatas.find(x => x.track === track);
		if (existingTrackData) {
			return existingTrackData as VideoTrackData;
		}

		validateVideoChunkMetadata(meta, track.source._codec);
		assert(meta?.decoderConfig);

		const codec = track.source._codec;
		assert(codec === 'avc' || codec === 'hevc' || codec === 'av1');

		let description: Uint8Array | null = null;
		let inputIsAnnexB = false;
		let lengthSize: VideoTrackData['lengthSize'] = null;

		if (codec === 'av1') {
			// WebCodecs doesn't populate `description` for AV1, so the Enhanced FLV sequence start is derived from the
			// codec string, exactly like the ISOBMFF/Matroska muxers derive their av1C record.
			description = null;
		} else if (meta.decoderConfig.description) {
			const bytes = toUint8Array(meta.decoderConfig.description);
			description = bytes.slice();

			if (codec === 'avc') {
				const config = deserializeAvcDecoderConfigurationRecord(bytes);
				assert(config);
				lengthSize = (config.lengthSizeMinusOne + 1) as 1 | 2 | 3 | 4;
			} else {
				const config = deserializeHevcDecoderConfigurationRecord(bytes);
				assert(config);
				lengthSize = (config.lengthSizeMinusOne + 1) as 1 | 2 | 3 | 4;
			}
		} else {
			// A missing description means Annex B input; the decoder configuration record has to be extracted from the
			// first key packet so a sequence-header tag can still be written.
			inputIsAnnexB = true;

			if (codec === 'avc') {
				const config = extractAvcDecoderConfigurationRecord(packet.data);
				if (!config) {
					throw new Error(
						'Could not extract an AVCDecoderConfigurationRecord from the Annex B AVC packet.',
					);
				}
				description = serializeAvcDecoderConfigurationRecord(config);
			} else {
				const config = extractHevcDecoderConfigurationRecord(packet.data);
				if (!config) {
					throw new Error(
						'Could not extract an HEVCDecoderConfigurationRecord from the Annex B HEVC packet.',
					);
				}
				description = serializeHevcDecoderConfigurationRecord(config);
			}

			lengthSize = 4;
		}

		const newTrackData: VideoTrackData = {
			kind: 'video',
			track,
			codec,
			codecString: meta.decoderConfig.codec,
			description,
			lengthSize,
			inputIsAnnexB,
			timestampProcessingQueue: [],
			packetQueue: [],
			closed: false,
			sequenceHeaderWritten: false,
		};

		this.trackDatas.push(newTrackData);

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		return newTrackData;
	}

	private getAudioTrackData(
		track: OutputAudioTrack,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata,
	): AudioTrackData {
		const existingTrackData = this.trackDatas.find(x => x.track === track);
		if (existingTrackData) {
			return existingTrackData as AudioTrackData;
		}

		validateAudioChunkMetadata(meta, track.source._codec);
		assert(meta?.decoderConfig);

		const codec = track.source._codec;
		assert(codec === 'aac' || codec === 'mp3');

		let description: Uint8Array | null = null;
		let inputIsAdts = false;

		if (codec === 'aac') {
			if (meta.decoderConfig.description) {
				description = toUint8Array(meta.decoderConfig.description).slice();
			} else {
				// A missing description means ADTS input; derive the AudioSpecificConfig from the first frame.
				inputIsAdts = true;

				const adtsFrame = readAdtsFrameHeader(FileSlice.tempFromBytes(packet.data));
				if (!adtsFrame) {
					throw new Error('Could not parse an ADTS header from the AAC packet.');
				}

				const sampleRate = aacFrequencyTable[adtsFrame.samplingFrequencyIndex];
				const numberOfChannels = aacChannelMap[adtsFrame.channelConfiguration];
				if (sampleRate === undefined || numberOfChannels === undefined) {
					throw new Error('Invalid ADTS frame header.');
				}

				description = buildAacAudioSpecificConfig({
					objectType: adtsFrame.objectType,
					outputSampleRate: sampleRate,
					outputNumberOfChannels: numberOfChannels,
				});
			}
		}

		const newTrackData: AudioTrackData = {
			kind: 'audio',
			track,
			codec,
			codecString: meta.decoderConfig.codec,
			description,
			inputIsAdts,
			timestampProcessingQueue: [],
			packetQueue: [],
			closed: false,
			sequenceHeaderWritten: false,
		};

		this.trackDatas.push(newTrackData);

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		return newTrackData;
	}

	async addEncodedVideoPacket(
		track: OutputVideoTrack,
		packet: EncodedPacket,
		meta?: EncodedVideoChunkMetadata,
	) {
		const release = await this.mutex.acquire();

		try {
			const trackData = this.getVideoTrackData(track, packet, meta);

			this.validateTimestamp(track, packet.timestamp, packet.type === 'key');

			const preparedData = this.prepareVideoPacket(trackData, packet);

			if (packet.type === 'key') {
				await this.flushTimestampQueue(trackData);
			}

			trackData.timestampProcessingQueue.push({
				data: preparedData,
				presentationTimestamp: packet.timestamp,
				decodeTimestamp: null,
				isKeyframe: packet.type === 'key',
			});
		} finally {
			release();
		}
	}

	async addEncodedAudioPacket(
		track: OutputAudioTrack,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata,
	) {
		const release = await this.mutex.acquire();

		try {
			const trackData = this.getAudioTrackData(track, packet, meta);

			this.validateTimestamp(track, packet.timestamp, packet.type === 'key');

			const preparedData = this.prepareAudioPacket(trackData, packet);

			// Audio has no reordering, but it still goes through the queue so the interleave logic stays uniform
			if (packet.type === 'key') {
				await this.flushTimestampQueue(trackData);
			}

			trackData.timestampProcessingQueue.push({
				data: preparedData,
				presentationTimestamp: packet.timestamp,
				decodeTimestamp: null,
				isKeyframe: packet.type === 'key',
			});
		} finally {
			release();
		}
	}

	async addSubtitleCue(): Promise<void> {
		throw new Error('FLV does not support subtitles.');
	}

	private prepareVideoPacket(trackData: VideoTrackData, packet: EncodedPacket): Uint8Array {
		if (trackData.codec === 'av1') {
			// AV1 frames are low-overhead bitstream OBUs and pass through unchanged
			return packet.data;
		}

		assert(trackData.lengthSize !== null);

		if (trackData.inputIsAnnexB) {
			const nalUnits: Uint8Array[] = [];
			for (const loc of iterateNalUnitsInAnnexB(packet.data)) {
				nalUnits.push(packet.data.subarray(loc.offset, loc.offset + loc.length));
			}

			return concatNalUnitsInLengthPrefixed(nalUnits, 4);
		}

		const inputLengthSize = trackData.lengthSize;
		if (inputLengthSize === 4) {
			// Already in the 4-byte length-prefixed format FLV expects
			return packet.data;
		}

		const nalUnits: Uint8Array[] = [];
		for (const loc of iterateNalUnitsInLengthPrefixed(packet.data, inputLengthSize)) {
			nalUnits.push(packet.data.subarray(loc.offset, loc.offset + loc.length));
		}

		return concatNalUnitsInLengthPrefixed(nalUnits, 4);
	}

	private prepareAudioPacket(trackData: AudioTrackData, packet: EncodedPacket): Uint8Array {
		if (trackData.codec === 'mp3' || !trackData.inputIsAdts) {
			// MP3 passes through unchanged, as does raw AAC
			return packet.data;
		}

		// Strip the ADTS header so only the raw AAC frame remains
		const adtsFrame = readAdtsFrameHeader(FileSlice.tempFromBytes(packet.data));
		if (!adtsFrame) {
			throw new Error('Expected an ADTS frame, didn\'t get one.');
		}

		const headerLength = adtsFrame.crcCheck === null
			? MIN_ADTS_FRAME_HEADER_SIZE
			: MAX_ADTS_FRAME_HEADER_SIZE;

		return packet.data.subarray(headerLength);
	}

	private allTracksAreKnown() {
		for (const track of this.output.tracks) {
			if (!track.source._closed && !this.trackDatas.some(x => x.track === track)) {
				return false;
			}
		}

		return true;
	}

	private async flushTimestampQueue(trackData: AnyFlvTrackData, alsoInterleave = true) {
		if (trackData.timestampProcessingQueue.length === 0) {
			return;
		}

		const sortedTimestamps = trackData.timestampProcessingQueue
			.map(packet => packet.presentationTimestamp)
			.sort((a, b) => a - b);

		for (let i = 0; i < trackData.timestampProcessingQueue.length; i++) {
			const queuedPacket = trackData.timestampProcessingQueue[i]!;
			queuedPacket.decodeTimestamp = sortedTimestamps[i]!;
			trackData.packetQueue.push(queuedPacket);
		}

		trackData.timestampProcessingQueue.length = 0;

		if (alsoInterleave) {
			await this.interleavePackets();
		}
	}

	private async interleavePackets(isFinalCall = false) {
		this.ensureHeaderWritten();

		outer:
		while (true) {
			let trackWithMinTimestamp: AnyFlvTrackData | null = null;
			let minTimestamp = Infinity;

			for (const trackData of this.trackDatas) {
				if (
					!isFinalCall
					&& trackData.packetQueue.length === 0
					&& !trackData.closed
				) {
					break outer;
				}

				if (
					trackData.packetQueue.length > 0
					&& trackData.packetQueue[0]!.presentationTimestamp < minTimestamp
				) {
					trackWithMinTimestamp = trackData;
					minTimestamp = trackData.packetQueue[0]!.presentationTimestamp;
				}
			}

			if (!trackWithMinTimestamp) {
				break;
			}

			const queuedPacket = trackWithMinTimestamp.packetQueue.shift()!;
			this.writeMediaPacket(trackWithMinTimestamp, queuedPacket);
		}

		if (!isFinalCall) {
			await this.writer.flush();
		}
	}

	private ensureHeaderWritten() {
		if (this.headerWritten) {
			return;
		}

		const header = new Uint8Array(FLV_HEADER_SIZE + PREVIOUS_TAG_SIZE_SIZE);
		const view = toDataView(header);

		header[0] = FLV_SIGNATURE.charCodeAt(0); // 'F'
		header[1] = FLV_SIGNATURE.charCodeAt(1); // 'L'
		header[2] = FLV_SIGNATURE.charCodeAt(2); // 'V'
		header[3] = FLV_VERSION;

		const hasAudio = this.trackDatas.some(x => x.kind === 'audio');
		const hasVideo = this.trackDatas.some(x => x.kind === 'video');
		header[4] = (Number(hasAudio) << 2) | Number(hasVideo); // Type flags

		view.setUint32(5, FLV_HEADER_SIZE, false); // Data offset (header size)
		view.setUint32(FLV_HEADER_SIZE, 0, false); // PreviousTagSize0

		this.writer.write(header);
		this.headerWritten = true;
	}

	private writeTag(
		tagType: FlvTagType,
		timestampMs: number,
		body: Uint8Array,
	) {
		const tag = new Uint8Array(FLV_TAG_HEADER_SIZE + body.byteLength + PREVIOUS_TAG_SIZE_SIZE);
		const view = toDataView(tag);

		tag[0] = tagType;

		// 3-byte big-endian data size
		view.setUint8(1, (body.byteLength >> 16) & 0xff);
		view.setUint8(2, (body.byteLength >> 8) & 0xff);
		view.setUint8(3, body.byteLength & 0xff);

		const wrapped = modEuclid(Math.round(timestampMs), FLV_TIMESTAMP_MODULUS);
		// 24-bit timestamp base, then the extended most-significant byte
		view.setUint8(4, (wrapped >> 16) & 0xff);
		view.setUint8(5, (wrapped >> 8) & 0xff);
		view.setUint8(6, wrapped & 0xff);
		view.setUint8(7, (wrapped >>> 24) & 0xff);

		// Stream ID, always 0
		view.setUint8(8, 0);
		view.setUint8(9, 0);
		view.setUint8(10, 0);

		tag.set(body, FLV_TAG_HEADER_SIZE);

		// PreviousTagSize covers the tag header plus the body
		const previousTagSize = FLV_TAG_HEADER_SIZE + body.byteLength;
		view.setUint32(tag.byteLength - PREVIOUS_TAG_SIZE_SIZE, previousTagSize, false);

		this.writer.write(tag);
	}

	private writeMediaPacket(trackData: AnyFlvTrackData, queuedPacket: QueuedPacket) {
		assert(queuedPacket.decodeTimestamp !== null);

		if (!trackData.sequenceHeaderWritten) {
			this.writeSequenceHeader(trackData, queuedPacket.decodeTimestamp);
		}

		if (trackData.kind === 'video') {
			this.writeVideoPacket(trackData, queuedPacket);
		} else {
			this.writeAudioPacket(trackData, queuedPacket);
		}
	}

	private writeSequenceHeader(trackData: AnyFlvTrackData, decodeTimestampSeconds: number) {
		const timestampMs = secondsToFlvTimestamp(decodeTimestampSeconds);

		if (trackData.kind === 'video') {
			this.writeVideoSequenceHeader(trackData, timestampMs);
		} else {
			this.writeAudioSequenceHeader(trackData, timestampMs);
		}

		trackData.sequenceHeaderWritten = true;
	}

	private writeVideoSequenceHeader(trackData: VideoTrackData, timestampMs: number) {
		if (trackData.codec === 'av1') {
			// Enhanced FLV AV1 SequenceStart: marker, FourCC 'av01', then the 4-byte av1C header followed by the
			// config OBUs. The config OBUs are empty here since the codec string only yields the av1C header.
			const av1C = new Uint8Array(generateAv1CodecConfigurationFromCodecString(trackData.codecString));
			const body = new Uint8Array(1 + 4 + av1C.byteLength);
			body[0] = ENHANCED_FLV_KEY_FRAME_MARKER | FlvEnhancedPacketType.SequenceStart;
			writeFourCc(body, 1, FLV_FOURCC_AV01);
			body.set(av1C, 5);

			this.writeTag(FlvTagType.Video, timestampMs, body);
			return;
		}

		assert(trackData.description);

		if (trackData.codec === 'hevc') {
			// Enhanced FLV HEVC SequenceStart: marker 0x90 with the SequenceStart packet type, then FourCC 'hvc1'
			const body = new Uint8Array(1 + 4 + trackData.description.byteLength);
			body[0] = ENHANCED_FLV_KEY_FRAME_MARKER | FlvEnhancedPacketType.SequenceStart;
			writeFourCc(body, 1, FLV_FOURCC_HVC1);
			body.set(trackData.description, 5);

			this.writeTag(FlvTagType.Video, timestampMs, body);
			return;
		}

		// Legacy AVC sequence header: frame type key (1) in the high nibble, CodecID AVC (7) in the low nibble,
		// followed by AVCPacketType 0 and a 24-bit (zero) composition time
		const body = new Uint8Array(2 + 3 + trackData.description.byteLength);
		body[0] = (FlvFrameType.KeyFrame << 4) | FlvVideoCodecId.AVC;
		body[1] = FlvAvcPacketType.SequenceHeader;
		// Composition time bytes stay zero
		body.set(trackData.description, 5);

		this.writeTag(FlvTagType.Video, timestampMs, body);
	}

	private writeAudioSequenceHeader(trackData: AudioTrackData, timestampMs: number) {
		if (trackData.codec === 'mp3') {
			// MP3 has no sequence header
			trackData.sequenceHeaderWritten = true;
			return;
		}

		assert(trackData.description);

		// AAC sequence header: the audio header byte (SoundFormat 10), then AACPacketType 0, then the
		// AudioSpecificConfig
		const body = new Uint8Array(2 + trackData.description.byteLength);
		body[0] = FlvSoundFormat.AAC << 4; // Rate/size/type nibbles are irrelevant for the sequence header
		body[1] = FlvAACPacketType.SequenceHeader;
		body.set(trackData.description, 2);

		this.writeTag(FlvTagType.Audio, timestampMs, body);
	}

	private writeVideoPacket(trackData: VideoTrackData, queuedPacket: QueuedPacket) {
		const decodeTimestampMs = secondsToFlvTimestamp(queuedPacket.decodeTimestamp!);
		const compositionTimeMs = clampS24(
			Math.round((queuedPacket.presentationTimestamp - queuedPacket.decodeTimestamp!) * FLV_TIMESCALE),
		);

		if (trackData.codec === 'av1' || trackData.codec === 'hevc') {
			// Enhanced FLV ExVideoTag: key frames carry the 0x90 high nibble, inter frames the
			// 0xa0 high nibble, and the low nibble marks CodedFrames (with an explicit composition
			// time). This matches what ffmpeg writes (0x91 for key, 0xa1 for inter) and the demuxer.
			const marker = queuedPacket.isKeyframe
				? ENHANCED_FLV_KEY_FRAME_MARKER
				: ENHANCED_FLV_INTER_FRAME_MARKER;
			const fourCc = trackData.codec === 'hevc' ? FLV_FOURCC_HVC1 : FLV_FOURCC_AV01;
			const packetType = FlvEnhancedPacketType.CodedFrames;

			const headerSize = 1 + 4 + 3; // marker + FourCC + 24-bit composition time
			const body = new Uint8Array(headerSize + queuedPacket.data.byteLength);
			body[0] = marker | packetType;
			writeFourCc(body, 1, fourCc);
			this.writeS24(body, 5, compositionTimeMs);

			body.set(queuedPacket.data, headerSize);
			this.writeTag(FlvTagType.Video, decodeTimestampMs, body);
			return;
		}

		// Legacy AVC: key/inter frame nibble plus CodecID AVC, AVCPacketType 1 (NALU), then the composition time
		const body = new Uint8Array(2 + 3 + queuedPacket.data.byteLength);
		body[0] = (queuedPacket.isKeyframe ? FlvFrameType.KeyFrame : FlvFrameType.InterFrame) << 4
			| FlvVideoCodecId.AVC;
		body[1] = FlvAvcPacketType.Nalu;
		this.writeS24(body, 2, compositionTimeMs);
		body.set(queuedPacket.data, 5);

		this.writeTag(FlvTagType.Video, decodeTimestampMs, body);
	}

	private writeAudioPacket(trackData: AudioTrackData, queuedPacket: QueuedPacket) {
		const timestampMs = secondsToFlvTimestamp(queuedPacket.decodeTimestamp!);

		if (trackData.codec === 'mp3') {
			// SoundFormat MP3 (2) in the high nibble; the remaining nibbles describe a 44.1 kHz, 16-bit, stereo stream
			// unless the packets say otherwise, which players ignore for MP3 anyway
			const body = new Uint8Array(1 + queuedPacket.data.byteLength);
			body[0] = FlvSoundFormat.MP3 << 4;
			body.set(queuedPacket.data, 1);

			this.writeTag(FlvTagType.Audio, timestampMs, body);
			return;
		}

		// Raw AAC: audio header byte plus AACPacketType 1, then the raw frame
		const body = new Uint8Array(2 + queuedPacket.data.byteLength);
		body[0] = FlvSoundFormat.AAC << 4;
		body[1] = FlvAACPacketType.Raw;
		body.set(queuedPacket.data, 2);

		this.writeTag(FlvTagType.Audio, timestampMs, body);
	}

	private writeS24(bytes: Uint8Array, offset: number, value: number) {
		const unsigned = value & 0xffffff;
		bytes[offset] = (unsigned >> 16) & 0xff;
		bytes[offset + 1] = (unsigned >> 8) & 0xff;
		bytes[offset + 2] = unsigned & 0xff;
	}

	// eslint-disable-next-line @typescript-eslint/no-misused-promises
	override async onTrackClose(track: OutputTrack) {
		const release = await this.mutex.acquire();

		const trackData = this.trackDatas.find(x => x.track === track);
		if (trackData) {
			trackData.closed = true;
			await this.flushTimestampQueue(trackData, false);
		}

		if (this.allTracksAreKnown()) {
			this.allTracksKnown.resolve();
		}

		await this.interleavePackets();

		release();
	}

	async finalize() {
		const release = await this.mutex.acquire();

		try {
			this.allTracksKnown.resolve();

			for (const trackData of this.trackDatas) {
				trackData.closed = true;
				await this.flushTimestampQueue(trackData, false);
			}

			await this.interleavePackets(true);
		} finally {
			release();
		}
	}
}

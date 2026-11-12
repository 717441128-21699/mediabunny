/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	AudioCodec,
	buildAudioCodecString,
	extractAudioCodecString,
	extractVideoCodecString,
	VideoCodec,
} from '../codec';
import {
	AvcDecoderConfigurationRecord,
	deserializeAvcDecoderConfigurationRecord,
	deserializeHevcDecoderConfigurationRecord,
	extractAv1CodecInfoFromPacket,
	HevcDecoderConfigurationRecord,
	iterateAv1PacketObus,
	parseAvcSps,
	parseHevcSps,
} from '../codec-data';
import { Demuxer } from '../demuxer';
import { Input } from '../input';
import {
	InputAudioTrackBacking,
	InputVideoTrackBacking,
} from '../input-track';
import { Logging } from '../logging';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags } from '../metadata';
import { PacketRetrievalOptions } from '../media-sink';
import {
	assert,
	AsyncMutex,
	binarySearchLessOrEqual,
	COLOR_PRIMARIES_MAP_INVERSE,
	IDENTITY_MATRIX,
	isThenable,
	MATRIX_COEFFICIENTS_MAP_INVERSE,
	TRANSFER_CHARACTERISTICS_MAP_INVERSE,
	TransformationMatrix,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import { EncodedPacket, PLACEHOLDER_DATA } from '../packet';
import { Bitstream } from '../../shared/bitstream';
import { aacChannelMap, aacFrequencyTable, parseAacAudioSpecificConfig } from '../../shared/aac-misc';
import { getMp3ChannelCount, readMp3FrameHeader } from '../../shared/mp3-misc';
import {
	FileSlice,
	readAscii,
	readBytes,
	Reader,
	readU24Be,
	readU32Be,
	readU8,
} from '../reader';
import { extractFlvKeyframeIndex, FlvKeyframeIndex, parseFlvScriptData } from './flv-amf';
import {
	buildFlvMimeType,
	ENHANCED_FLV_EX_HEADER_MASK,
	ENHANCED_FLV_KEY_FRAME_MARKER,
	ENHANCED_FLV_PACKET_TYPE_MASK,
	FlvAACPacketType,
	FlvAvcPacketType,
	FlvEnhancedPacketType,
	FlvFrameType,
	FLV_FOURCC_AV01,
	FLV_FOURCC_HVC1,
	FLV_HEADER_SIZE,
	FLV_TAG_HEADER_SIZE,
	FLV_TIMESCALE,
	FlvSoundFormat,
	FlvTagType,
	FlvTimestampUnwrapper,
	FlvVideoCodecId,
} from './flv-misc';

// A tag larger than this is almost certainly the result of a corrupt size field, not real media
const MAX_REASONABLE_TAG_SIZE = 100 * 1024 * 1024;

// How many tags to scan while reading metadata before giving up on discovering further tracks. FLV keeps no track
// table, so headerless codecs (e.g. MP3) only reveal their track on the first frame, which can be preceded by many
// video tags. The limit bounds the upfront work while staying far beyond any realistic interleave interval.
const METADATA_SCAN_TAG_LIMIT = 256;

type Sample = {
	/** Presentation timestamp in seconds. */
	timestamp: number;
	/** Decode timestamp in seconds; only differs from the presentation timestamp for video with B-frames. */
	decodeTimestamp: number;
	duration: number;
	/** File byte offset at which the codec-specific packet data begins. */
	dataStart: number;
	dataSize: number;
	/** File byte offset at which the containing tag begins, used for keyframe-index seeks. */
	tagStart: number;
	isKey: boolean;
	/** The sequence number is simply the index of this sample within its track. */
	sequenceNumber: number;
};

type VideoTrackInfo = {
	codec: VideoCodec;
	width: number;
	height: number;
	squarePixelWidth: number;
	squarePixelHeight: number;
	colorSpace: VideoColorSpaceInit;
	avcCodecInfo: AvcDecoderConfigurationRecord | null;
	hevcCodecInfo: HevcDecoderConfigurationRecord | null;
	av1CodecInfo: ReturnType<typeof extractAv1CodecInfoFromPacket>;
	/** Raw decoder configuration record bytes, used as the WebCodecs `description`. */
	description: Uint8Array | null;
	nalLengthSize: 1 | 2 | 3 | 4;
};

type AudioTrackInfo = {
	codec: AudioCodec;
	numberOfChannels: number;
	sampleRate: number;
	/** Raw AudioSpecificConfig bytes for AAC, used as the WebCodecs `description`. */
	description: Uint8Array | null;
};

export class FlvDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	metadataTags: MetadataTags = {};

	videoInfo: VideoTrackInfo | null = null;
	audioInfo: AudioTrackInfo | null = null;

	videoSamples: Sample[] = [];
	audioSamples: Sample[] = [];

	videoBacking: FlvVideoTrackBacking | null = null;
	audioBacking: FlvAudioTrackBacking | null = null;

	/** Position right after the last tag that was fully scanned, including its PreviousTagSize field. */
	lastLoadedPos = 0;
	lastSampleLoaded = false;
	/** Number of tags indexed so far, used to bound the upfront metadata scan. */
	tagsScanned = 0;
	readingMutex = new AsyncMutex();

	/** Parsed duration from onMetaData, in seconds. */
	metadataDuration: number | null = null;
	/** Parsed keyframe seek index from onMetaData. */
	keyframeIndex: FlvKeyframeIndex | null = null;

	/** Per-track timestamp wraparound state, created lazily from the first timestamp of each track. */
	videoUnwrapper = new FlvTimestampUnwrapper();
	audioUnwrapper = new FlvTimestampUnwrapper();

	constructor(input: Input) {
		super(input);

		this.reader = input._reader;
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			// The FLV header plus the mandatory first PreviousTagSize come first
			let slice = this.reader.requestSlice(0, FLV_HEADER_SIZE + 4);
			if (isThenable(slice)) slice = await slice;

			if (!slice) {
				throw new Error('Invalid FLV file: header could not be read.');
			}

			const signature = readAscii(slice, 3);
			if (signature !== 'FLV') {
				throw new Error('Invalid FLV file: signature mismatch.');
			}

			slice.skip(2); // Version and flags
			const dataOffset = readU32Be(slice);
			this.lastLoadedPos = dataOffset + 4; // Skip the header and PreviousTagSize0

			// The track set can only be discovered while scanning: headerless codecs like MP3 create
			// their track on the first frame rather than on a sequence-header tag. Scan a bounded number
			// of tags up front so every track is initialized and has yielded its first media sample
			// (or the file ends), without reading the whole file. We can't stop as soon as the currently
			// known tracks have a sample, since a not-yet-seen track (e.g. an MP3 track whose first
			// frame is interleaved after several video tags) would be missed.
			while (!this.lastSampleLoaded && this.tagsScanned < METADATA_SCAN_TAG_LIMIT) {
				const advanced = await this.advanceReader();
				if (!advanced) {
					break;
				}
			}

			if (!this.videoInfo && !this.audioInfo) {
				throw new Error('Invalid FLV file: no supported media tracks found.');
			}

			if (this.videoInfo) {
				this.videoBacking = new FlvVideoTrackBacking(this);
			}
			if (this.audioInfo) {
				this.audioBacking = new FlvAudioTrackBacking(this);
			}
		})();
	}

	/**
	 * Reads and indexes the next tag. Returns false once the end of the file has been reached (or it is unreadable).
	 */
	async advanceReader(): Promise<boolean> {
		if (this.lastSampleLoaded) {
			return false;
		}

		let headerSlice = this.reader.requestSlice(this.lastLoadedPos, FLV_TAG_HEADER_SIZE);
		if (isThenable(headerSlice)) headerSlice = await headerSlice;

		if (!headerSlice) {
			this.lastSampleLoaded = true;
			return false;
		}

		const tagStart = headerSlice.filePos;
		const tagType = readU8(headerSlice);
		const dataSize = readU24Be(headerSlice);
		const timestampBase = readU24Be(headerSlice);
		const timestampExtended = readU8(headerSlice);
		headerSlice.skip(3); // Stream ID, always 0

		if (
			!Number.isFinite(dataSize)
			|| dataSize <= 0
			|| dataSize > MAX_REASONABLE_TAG_SIZE
		) {
			Logging._warn(`Encountered FLV tag with invalid data size ${dataSize}, stopping scan.`);
			this.lastSampleLoaded = true;
			return false;
		}

		const rawTimestamp = (timestampExtended * 0x1000000) + timestampBase; // Unsigned 32-bit
		const tagEnd = tagStart + FLV_TAG_HEADER_SIZE + dataSize;

		let bodySlice = this.reader.requestSlice(tagStart + FLV_TAG_HEADER_SIZE, dataSize);
		if (isThenable(bodySlice)) bodySlice = await bodySlice;

		if (!bodySlice) {
			// The tag is truncated; recover everything read so far
			this.lastSampleLoaded = true;
			return false;
		}

		try {
			if (tagType === FlvTagType.ScriptData) {
				this.handleScriptTag(bodySlice);
			} else if (tagType === FlvTagType.Audio) {
				this.handleAudioTag(bodySlice, rawTimestamp, tagStart);
			} else if (tagType === FlvTagType.Video) {
				this.handleVideoTag(bodySlice, rawTimestamp, tagStart);
			}
		} catch (error) {
			// A single corrupt tag must not take down the whole file
			Logging._warn('Error while parsing FLV tag, skipping it:', error);
		}

		this.tagsScanned++;

		// Verify the PreviousTagSize is readable before advancing, so we keep a valid position on a truncated file
		let tailSlice = this.reader.requestSlice(tagEnd, 4);
		if (isThenable(tailSlice)) tailSlice = await tailSlice;
		if (!tailSlice) {
			this.lastSampleLoaded = true;
			return false;
		}

		this.lastLoadedPos = tagEnd + 4;
		return true;
	}

	private handleScriptTag(slice: FileSlice) {
		const metadata = parseFlvScriptData(slice);
		if (!metadata) {
			return;
		}

		const duration = metadata['duration'];
		if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
			this.metadataDuration = duration;
		}

		const index = extractFlvKeyframeIndex(metadata);
		if (index) {
			this.keyframeIndex = index;
		}
	}

	private normalizeTimestamp(rawTimestamp: number, isVideo: boolean) {
		const unwrapper = isVideo ? this.videoUnwrapper : this.audioUnwrapper;
		return unwrapper.next(rawTimestamp) / FLV_TIMESCALE;
	}

	private handleAudioTag(slice: FileSlice, rawTimestamp: number, tagStart: number) {
		const firstByte = readU8(slice);
		const soundFormat = firstByte >> 4;
		const soundRateIndex = (firstByte >> 2) & 0b1;
		const soundType = firstByte & 0b1;

		if (soundFormat === FlvSoundFormat.AAC) {
			const aacPacketType = readU8(slice);
			const payloadStart = slice.filePos;
			const payload = readBytes(slice, slice.remainingLength);

			if (aacPacketType === FlvAACPacketType.SequenceHeader) {
				this.initAacInfo(payload);
				return;
			}

			if (!this.audioInfo) {
				return; // No AudioSpecificConfig seen yet, so the frame can't be interpreted
			}

			const timestamp = this.normalizeTimestamp(rawTimestamp, false);
			this.audioSamples.push({
				timestamp,
				decodeTimestamp: timestamp,
				duration: 0,
				dataStart: payloadStart,
				dataSize: payload.byteLength,
				tagStart,
				isKey: true,
				sequenceNumber: this.audioSamples.length,
			});
		} else if (soundFormat === FlvSoundFormat.MP3) {
			const payloadStart = slice.filePos; // Skip the FLV audio header byte; MP3 frames begin after it
			const payload = readBytes(slice, slice.remainingLength);

			if (!this.audioInfo) {
				this.initMp3Info(payload, soundRateIndex, soundType);
				if (!this.audioInfo) {
					return;
				}
			}

			const timestamp = this.normalizeTimestamp(rawTimestamp, false);
			this.audioSamples.push({
				timestamp,
				decodeTimestamp: timestamp,
				duration: 0,
				dataStart: payloadStart,
				dataSize: payload.byteLength,
				tagStart,
				isKey: true,
				sequenceNumber: this.audioSamples.length,
			});
		}
	}

	private initAacInfo(audioSpecificConfig: Uint8Array) {
		if (this.audioInfo) {
			return;
		}

		try {
			const config = parseAacAudioSpecificConfig(audioSpecificConfig);
			const sampleRate = config.outputSampleRate
				?? (config.frequencyIndex < aacFrequencyTable.length ? aacFrequencyTable[config.frequencyIndex] : null)
				?? 44100;
			const numberOfChannels = config.outputNumberOfChannels
				?? aacChannelMap[config.channelConfiguration]
				?? 2;

			this.audioInfo = {
				codec: 'aac',
				numberOfChannels,
				sampleRate,
				description: audioSpecificConfig.slice(),
			};
		} catch (error) {
			Logging._warn('Failed to parse AAC AudioSpecificConfig:', error);
		}
	}

	private initMp3Info(firstFrame: Uint8Array, soundRateIndex: number, soundType: number) {
		if (firstFrame.byteLength < 4) {
			return;
		}

		const view = new DataView(firstFrame.buffer, firstFrame.byteOffset, firstFrame.byteLength);
		const word = view.getUint32(0, false);
		const result = readMp3FrameHeader(word, firstFrame.byteLength);
		if (!result.header) {
			return;
		}

		this.audioInfo = {
			codec: 'mp3',
			numberOfChannels: getMp3ChannelCount(result.header.channel) || (soundType === 1 ? 2 : 1),
			sampleRate: result.header.sampleRate || (soundRateIndex === 0 ? 44100 : 11025),
			description: null,
		};
	}

	private handleVideoTag(slice: FileSlice, rawTimestamp: number, tagStart: number) {
		const firstByte = readU8(slice);

		// Enhanced FLV ExVideoTag: bit 7 is always set (the marker byte is 0x9x/0xax/0xdx ...), the low nibble is the
		// packet type. Legacy tags never set bit 7 (frame type 1-5, codec id < 16).
		const isEnhanced = (firstByte & ENHANCED_FLV_EX_HEADER_MASK) !== 0;

		if (isEnhanced) {
			this.handleEnhancedVideoTag(slice, firstByte, rawTimestamp, tagStart);
			return;
		}

		const frameType = firstByte >> 4;
		const codecId = firstByte & 0x0f;

		if (codecId !== FlvVideoCodecId.AVC && codecId !== FlvVideoCodecId.HEVC) {
			return; // Legacy codecs (Sorenson, VP6, ...) are not supported
		}

		const avcPacketType = readU8(slice);
		const compositionTime = readI24(slice); // Signed 24-bit, in milliseconds

		if (avcPacketType === FlvAvcPacketType.SequenceHeader) {
			const configRecord = readBytes(slice, slice.remainingLength);

			if (codecId === FlvVideoCodecId.AVC) {
				this.initAvcInfo(configRecord);
			} else {
				this.initHevcInfo(configRecord);
			}
			return;
		}

		if (avcPacketType === FlvAvcPacketType.EndOfSequence) {
			return;
		}

		if (!this.videoInfo) {
			return; // No sequence header seen yet
		}

		const payloadStart = slice.filePos;
		const payload = readBytes(slice, slice.remainingLength);
		const isKey = frameType === FlvFrameType.KeyFrame;
		this.pushVideoSample(payload, payloadStart, rawTimestamp, compositionTime, isKey, tagStart);
	}

	private handleEnhancedVideoTag(
		slice: FileSlice,
		markerByte: number,
		rawTimestamp: number,
		tagStart: number,
	) {
		const isKey = (markerByte & 0xf0) === ENHANCED_FLV_KEY_FRAME_MARKER;
		const packetType = markerByte & ENHANCED_FLV_PACKET_TYPE_MASK;
		const fourCc = readAscii(slice, 4);

		if (fourCc !== FLV_FOURCC_HVC1 && fourCc !== FLV_FOURCC_AV01) {
			return;
		}

		if (packetType === FlvEnhancedPacketType.SequenceStart) {
			const configRecord = readBytes(slice, slice.remainingLength);

			if (fourCc === FLV_FOURCC_HVC1) {
				this.initHevcInfo(configRecord);
			} else {
				this.initAv1Info(configRecord);
			}
			return;
		}

		if (
			packetType !== FlvEnhancedPacketType.CodedFrames
			&& packetType !== FlvEnhancedPacketType.CodedFramesX
		) {
			return;
		}

		if (!this.videoInfo) {
			return;
		}

		// CodedFramesX never carry a composition time. CodedFrames do in the general case, but ffmpeg writes AV1 with
		// a CodedFrames marker while omitting the field because AV1 has no B-frames and hence PTS always equals DTS.
		// The Enhanced FLV spec has no presence flag, so treat the field as absent for AV1 (its composition offset is
		// always zero); HEVC always emits it.
		let compositionTime = 0;
		if (
			packetType === FlvEnhancedPacketType.CodedFrames
			&& fourCc === FLV_FOURCC_HVC1
		) {
			compositionTime = readI24(slice);
		}

		const payloadStart = slice.filePos;
		const payload = readBytes(slice, slice.remainingLength);
		this.pushVideoSample(payload, payloadStart, rawTimestamp, compositionTime, isKey, tagStart);
	}

	private initAvcInfo(configRecord: Uint8Array) {
		if (this.videoInfo) {
			return;
		}

		const avcCodecInfo = deserializeAvcDecoderConfigurationRecord(configRecord);
		if (!avcCodecInfo) {
			return;
		}

		const spsUnit = avcCodecInfo.sequenceParameterSets[0];
		if (!spsUnit) {
			return;
		}

		const spsInfo = parseAvcSps(spsUnit);
		if (!spsInfo) {
			return;
		}

		const dimensions = extractSpsDimensions(
			spsInfo.displayWidth,
			spsInfo.displayHeight,
			spsInfo.pixelAspectRatio.num,
			spsInfo.pixelAspectRatio.den,
			spsInfo.colourPrimaries,
			spsInfo.transferCharacteristics,
			spsInfo.matrixCoefficients,
			spsInfo.fullRangeFlag,
		);

		this.videoInfo = {
			codec: 'avc',
			...dimensions,
			avcCodecInfo,
			hevcCodecInfo: null,
			av1CodecInfo: null,
			description: configRecord.slice(),
			nalLengthSize: (avcCodecInfo.lengthSizeMinusOne + 1) as 1 | 2 | 3 | 4,
		};
	}

	private initHevcInfo(configRecord: Uint8Array) {
		if (this.videoInfo) {
			return;
		}

		const hevcCodecInfo = deserializeHevcDecoderConfigurationRecord(configRecord);
		if (!hevcCodecInfo) {
			return;
		}

		const spsArray = hevcCodecInfo.arrays.find(a => a.nalUnits.length > 0 && isHevcSps(a.nalUnitType));
		const spsUnit = spsArray?.nalUnits[0];
		if (!spsUnit) {
			return;
		}

		const spsInfo = parseHevcSps(spsUnit);
		if (!spsInfo) {
			return;
		}

		const dimensions = extractSpsDimensions(
			spsInfo.displayWidth,
			spsInfo.displayHeight,
			spsInfo.pixelAspectRatio.num,
			spsInfo.pixelAspectRatio.den,
			spsInfo.colourPrimaries,
			spsInfo.transferCharacteristics,
			spsInfo.matrixCoefficients,
			spsInfo.fullRangeFlag,
		);

		this.videoInfo = {
			codec: 'hevc',
			...dimensions,
			avcCodecInfo: null,
			hevcCodecInfo,
			av1CodecInfo: null,
			description: configRecord.slice(),
			nalLengthSize: (hevcCodecInfo.lengthSizeMinusOne + 1) as 1 | 2 | 3 | 4,
		};
	}

	private initAv1Info(configRecord: Uint8Array) {
		if (this.videoInfo) {
			return;
		}

		// The Enhanced FLV AV1 sequence start carries a raw AV1CodecConfigurationRecord: a 4-byte av1C header
		// followed by the config OBUs. Some muxers (including ours when only the codec string is known) write just the
		// header, so the config OBUs may be empty; in that case the codec info and dimensions are filled in lazily from
		// the sequence header inside the first keyframe.
		const configObus = configRecord.byteLength > 4 ? configRecord.subarray(4) : new Uint8Array(0);
		const av1CodecInfo = extractAv1CodecInfoFromPacket(configObus);
		const dimensions = extractAv1FrameDimensions(configObus);

		this.videoInfo = {
			codec: 'av1',
			// Placeholder dimensions until a real sequence header has been parsed
			width: dimensions?.width ?? 0,
			height: dimensions?.height ?? 0,
			squarePixelWidth: dimensions?.width ?? 0,
			squarePixelHeight: dimensions?.height ?? 0,
			colorSpace: av1CodecInfo
				? {
						primaries: COLOR_PRIMARIES_MAP_INVERSE[av1CodecInfo.colourPrimaries] as
						VideoColorPrimaries | undefined,
						transfer: TRANSFER_CHARACTERISTICS_MAP_INVERSE[av1CodecInfo.transferCharacteristics] as
						VideoTransferCharacteristics | undefined,
						matrix: MATRIX_COEFFICIENTS_MAP_INVERSE[av1CodecInfo.matrixCoefficients] as
						VideoMatrixCoefficients | undefined,
						fullRange: !!av1CodecInfo.videoFullRangeFlag,
					}
				: {},
			avcCodecInfo: null,
			hevcCodecInfo: null,
			av1CodecInfo,
			description: configRecord.slice(),
			nalLengthSize: 4,
		};
	}

	/**
	 * Fills in AV1 codec info and dimensions from the sequence-header OBU embedded in a keyframe. Used when the
	 * sequence-start tag carried no config OBUs. Only runs until the information becomes available.
	 */
	private enrichAv1InfoFromKeyframe(payload: Uint8Array) {
		assert(this.videoInfo?.codec === 'av1');

		const av1CodecInfo = extractAv1CodecInfoFromPacket(payload);
		const dimensions = extractAv1FrameDimensions(payload);

		if (av1CodecInfo) {
			this.videoInfo.av1CodecInfo = av1CodecInfo;
			this.videoInfo.colorSpace = {
				primaries: COLOR_PRIMARIES_MAP_INVERSE[av1CodecInfo.colourPrimaries] as
					VideoColorPrimaries | undefined,
				transfer: TRANSFER_CHARACTERISTICS_MAP_INVERSE[av1CodecInfo.transferCharacteristics] as
					VideoTransferCharacteristics | undefined,
				matrix: MATRIX_COEFFICIENTS_MAP_INVERSE[av1CodecInfo.matrixCoefficients] as
					VideoMatrixCoefficients | undefined,
				fullRange: !!av1CodecInfo.videoFullRangeFlag,
			};
		}

		if (dimensions) {
			this.videoInfo.width = dimensions.width;
			this.videoInfo.height = dimensions.height;
			this.videoInfo.squarePixelWidth = dimensions.width;
			this.videoInfo.squarePixelHeight = dimensions.height;
		}
	}

	private pushVideoSample(
		payload: Uint8Array,
		payloadStart: number,
		rawTimestamp: number,
		compositionTimeMs: number,
		isKey: boolean,
		tagStart: number,
	) {
		assert(this.videoInfo);

		// Recover AV1 codec info/dimensions from the keyframe when the sequence-start tag lacked config OBUs
		if (
			this.videoInfo.codec === 'av1'
			&& isKey
			&& (this.videoInfo.width === 0 || this.videoInfo.av1CodecInfo === null)
		) {
			this.enrichAv1InfoFromKeyframe(payload);
		}

		const decodeTimestamp = this.normalizeTimestamp(rawTimestamp, true);
		// The composition time is a signed millisecond offset on top of the (already normalized) decode timestamp
		const presentationTimestamp = decodeTimestamp + compositionTimeMs / FLV_TIMESCALE;

		this.videoSamples.push({
			timestamp: presentationTimestamp,
			decodeTimestamp,
			duration: 0,
			dataStart: payloadStart,
			dataSize: payload.byteLength,
			tagStart,
			isKey,
			sequenceNumber: this.videoSamples.length,
		});
	}

	buildVideoCodecString() {
		assert(this.videoInfo);
		const info = this.videoInfo;

		return extractVideoCodecString({
			width: info.width,
			height: info.height,
			codec: info.codec,
			codecDescription: null,
			colorSpace: info.colorSpace,
			avcType: 1,
			avcCodecInfo: info.avcCodecInfo,
			hevcCodecInfo: info.hevcCodecInfo,
			vp9CodecInfo: null,
			av1CodecInfo: info.av1CodecInfo,
			proresFormat: null,
		});
	}

	buildAudioCodecString() {
		assert(this.audioInfo);
		const info = this.audioInfo;

		if (info.codec === 'aac' && info.description) {
			return extractAudioCodecString({
				codec: 'aac',
				codecDescription: info.description,
				aacCodecInfo: { isMpeg2: false, objectType: null },
				dtsFormat: null,
			});
		}

		return buildAudioCodecString(info.codec, info.numberOfChannels, info.sampleRate);
	}

	async getMimeType() {
		await this.readMetadata();

		const codecStrings: (string | null)[] = [];
		if (this.videoInfo) {
			codecStrings.push(this.buildVideoCodecString());
		}
		if (this.audioInfo) {
			codecStrings.push(this.buildAudioCodecString());
		}

		return buildFlvMimeType(codecStrings);
	}

	async getTrackBackings() {
		await this.readMetadata();

		const backings = [];
		if (this.videoBacking) {
			backings.push(this.videoBacking);
		}
		if (this.audioBacking) {
			backings.push(this.audioBacking);
		}

		return backings;
	}

	async getMetadataTags() {
		const release = await this.readingMutex.acquire();

		try {
			await this.readMetadata();
			return this.metadataTags;
		} finally {
			release();
		}
	}

	/** Ensures every tag up to the end of the file has been indexed, then fills in any missing sample durations. */
	async ensureFullyScanned() {
		while (!this.lastSampleLoaded) {
			const advanced = await this.advanceReader();
			if (!advanced) {
				break;
			}
		}

		this.computeDurations(this.videoSamples);
		this.computeDurations(this.audioSamples);
	}

	/**
	 * Fills in the duration of every sample that doesn't have one yet, using the gap to the following sample. This is
	 * incremental, so calling it repeatedly while scanning only touches newly added samples.
	 */
	computeDurations(samples: Sample[]) {
		for (let i = 0; i < samples.length; i++) {
			const current = samples[i]!;
			if (current.duration > 0) {
				continue;
			}

			const next = samples[i + 1];
			if (next) {
				current.duration = Math.max(0, next.timestamp - current.timestamp);
			} else if (i > 0) {
				// Last known sample: reuse the previous duration as a heuristic
				current.duration = samples[i - 1]!.duration;
			}
		}
	}
}

const readI24 = (slice: FileSlice) => {
	const value = readU24Be(slice);
	return value & 0x800000 ? value - 0x1000000 : value;
};

const isHevcSps = (nalUnitType: number) => {
	// SPS_NUT is 33 and SPS_EXTENSION_NUT is 63
	return nalUnitType === 33 || nalUnitType === 63;
};

const extractSpsDimensions = (
	displayWidth: number,
	displayHeight: number,
	parNum: number,
	parDen: number,
	colourPrimaries: number,
	transferCharacteristics: number,
	matrixCoefficients: number,
	fullRangeFlag: number,
) => {
	let squarePixelWidth = displayWidth;
	let squarePixelHeight = displayHeight;

	if (parNum > 0 && parDen > 0) {
		if (parNum > parDen) {
			squarePixelWidth = Math.round(displayWidth * parNum / parDen);
		} else {
			squarePixelHeight = Math.round(displayHeight * parDen / parNum);
		}
	}

	return {
		width: displayWidth,
		height: displayHeight,
		squarePixelWidth,
		squarePixelHeight,
		colorSpace: {
			primaries: COLOR_PRIMARIES_MAP_INVERSE[colourPrimaries] as VideoColorPrimaries | undefined,
			transfer: TRANSFER_CHARACTERISTICS_MAP_INVERSE[transferCharacteristics] as
				VideoTransferCharacteristics | undefined,
			matrix: MATRIX_COEFFICIENTS_MAP_INVERSE[matrixCoefficients] as VideoMatrixCoefficients | undefined,
			fullRange: !!fullRangeFlag,
		},
	};
};

/**
 * Reads the maximum frame dimensions out of an AV1 sequence-header OBU. The config OBUs of an
 * AV1CodecConfigurationRecord always contain exactly one sequence header. Returns null if unparseable.
 */
const extractAv1FrameDimensions = (configObus: Uint8Array): { width: number; height: number } | null => {
	try {
		for (const { type, data } of iterateAv1PacketObus(configObus)) {
			if (type !== 1) {
				continue; // OBU_SEQUENCE_HEADER
			}

			const bitstream = new Bitstream(data);

			bitstream.skipBits(3); // seq_profile
			bitstream.skipBits(1); // still_picture
			const reducedStillPictureHeader = bitstream.readBits(1);

			if (!reducedStillPictureHeader) {
				const timingInfoPresentFlag = bitstream.readBits(1);
				let decoderModelInfoPresentFlag = 0;
				let bufferDelayLengthMinus1 = 0;

				if (timingInfoPresentFlag) {
					bitstream.skipBits(64); // num_units_in_display_tick + time_scale
					const equalPictureInterval = bitstream.readBits(1);

					if (equalPictureInterval) {
						skipUnsignedExpGolomb(bitstream); // num_ticks_per_picture_minus_1
					}

					decoderModelInfoPresentFlag = bitstream.readBits(1);

					if (decoderModelInfoPresentFlag) {
						bufferDelayLengthMinus1 = bitstream.readBits(5);
						bitstream.skipBits(32 + 5 + 5); // num_units_in_decoding_tick and the two length fields
					}
				}

				// These fields (and the operating-point loop below) are present regardless of timing_info_present_flag
				const initialDisplayDelayPresentFlag = bitstream.readBits(1);
				const operatingPointsCntMinus1 = bitstream.readBits(5);

				for (let i = 0; i <= operatingPointsCntMinus1; i++) {
					bitstream.skipBits(12); // operating_point_idc
					const seqLevelIdx = bitstream.readBits(5);

					if (seqLevelIdx > 7) {
						bitstream.skipBits(1); // seq_tier
					}

					if (decoderModelInfoPresentFlag) {
						if (bitstream.readBits(1)) { // decoder_model_present_for_this_op
							const n = bufferDelayLengthMinus1 + 1;
							bitstream.skipBits(n); // decoder_buffer_delay
							bitstream.skipBits(n); // encoder_buffer_delay
							bitstream.skipBits(1); // low_delay_mode_flag
						}
					}

					if (initialDisplayDelayPresentFlag && bitstream.readBits(1)) {
						bitstream.skipBits(4); // initial_display_delay_minus_1
					}
				}
			} else {
				bitstream.skipBits(5); // seq_level_idx
			}

			const frameWidthBitsMinus1 = bitstream.readBits(4);
			const frameHeightBitsMinus1 = bitstream.readBits(4);
			const maxFrameWidth = bitstream.readBits(frameWidthBitsMinus1 + 1) + 1;
			const maxFrameHeight = bitstream.readBits(frameHeightBitsMinus1 + 1) + 1;

			return { width: maxFrameWidth, height: maxFrameHeight };
		}
	} catch {
		return null;
	}

	return null;
};

/** Skips one unsigned Exp-Golomb coded value in the bitstream. */
const skipUnsignedExpGolomb = (bitstream: Bitstream) => {
	let leadingZeros = 0;
	while (leadingZeros < 32 && bitstream.readBits(1) === 0) {
		leadingZeros++;
	}

	if (leadingZeros > 0) {
		bitstream.skipBits(leadingZeros);
	}
};

abstract class FlvTrackBacking {
	constructor(public demuxer: FlvDemuxer) {}

	getTimeResolution() {
		return FLV_TIMESCALE;
	}

	isRelativeToUnixEpoch() {
		return false;
	}

	getUnixTimeForTimestamp() {
		return null;
	}

	getBitrate() {
		return null;
	}

	getAverageBitrate() {
		return null;
	}

	async getLiveRefreshInterval() {
		return null;
	}

	getName() {
		return null;
	}

	getLanguageCode() {
		return UNDETERMINED_LANGUAGE;
	}

	getInternalCodecId() {
		return null;
	}

	getDisposition() {
		return { ...DEFAULT_TRACK_DISPOSITION };
	}

	async getDurationFromMetadata() {
		return this.demuxer.metadataDuration;
	}
}

class FlvVideoTrackBacking extends FlvTrackBacking implements InputVideoTrackBacking {
	getType() {
		return 'video' as const;
	}

	getId() {
		return 1;
	}

	getNumber() {
		return 1;
	}

	getPairingMask() {
		return 1n;
	}

	getCodec(): VideoCodec {
		assert(this.demuxer.videoInfo);
		return this.demuxer.videoInfo.codec;
	}

	getCodedWidth() {
		assert(this.demuxer.videoInfo);
		return this.demuxer.videoInfo.width;
	}

	getCodedHeight() {
		assert(this.demuxer.videoInfo);
		return this.demuxer.videoInfo.height;
	}

	getSquarePixelWidth() {
		assert(this.demuxer.videoInfo);
		return this.demuxer.videoInfo.squarePixelWidth;
	}

	getSquarePixelHeight() {
		assert(this.demuxer.videoInfo);
		return this.demuxer.videoInfo.squarePixelHeight;
	}

	getTransformationMatrix(): TransformationMatrix {
		return [...IDENTITY_MATRIX];
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		assert(this.demuxer.videoInfo);
		return this.demuxer.videoInfo.colorSpace;
	}

	async canBeTransparent() {
		return false;
	}

	async getHasOnlyKeyPackets() {
		return false;
	}

	async getDecoderConfig(): Promise<VideoDecoderConfig | null> {
		const info = this.demuxer.videoInfo;
		assert(info);

		const config: VideoDecoderConfig = {
			codec: this.demuxer.buildVideoCodecString(),
			codedWidth: info.width,
			codedHeight: info.height,
			colorSpace: info.colorSpace,
		};

		if (info.description) {
			config.description = info.description.slice();
		}

		if (info.width !== info.squarePixelWidth || info.height !== info.squarePixelHeight) {
			config.displayAspectWidth = info.squarePixelWidth;
			config.displayAspectHeight = info.squarePixelHeight;
		}

		return config;
	}

	async getPacketAtIndex(sampleIndex: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		if (sampleIndex === -1) {
			return null;
		}

		const sample = this.demuxer.videoSamples[sampleIndex];
		if (!sample) {
			return null;
		}

		let data: Uint8Array;
		if (options.metadataOnly) {
			data = PLACEHOLDER_DATA;
		} else {
			let slice = this.demuxer.reader.requestSlice(sample.dataStart, sample.dataSize);
			if (isThenable(slice)) slice = await slice;

			if (!slice) {
				return null;
			}

			data = readBytes(slice, sample.dataSize);
		}

		return new EncodedPacket(
			data,
			sample.isKey ? 'key' : 'delta',
			sample.timestamp,
			sample.duration,
			sample.sequenceNumber,
			sample.dataSize,
		);
	}

	async getFirstPacket(options: PacketRetrievalOptions) {
		const release = await this.demuxer.readingMutex.acquire();

		try {
			await this.demuxer.readMetadata();
			return this.getPacketAtIndex(0, options);
		} finally {
			release();
		}
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		const release = await this.demuxer.readingMutex.acquire();

		try {
			const sampleIndex = this.findSampleIndex(packet);
			if (sampleIndex === -1) {
				throw new Error('Packet was not created from this track.');
			}

			const nextIndex = sampleIndex + 1;
			while (
				nextIndex >= this.demuxer.videoSamples.length
				&& !this.demuxer.lastSampleLoaded
			) {
				await this.demuxer.advanceReader();
			}

			this.demuxer.computeDurations(this.demuxer.videoSamples);
			return this.getPacketAtIndex(nextIndex, options);
		} finally {
			release();
		}
	}

	async getPacket(timestamp: number, options: PacketRetrievalOptions) {
		const release = await this.demuxer.readingMutex.acquire();

		try {
			return await this.getPacketUnlocked(timestamp, options);
		} finally {
			release();
		}
	}

	/** Packet lookup that assumes the reading mutex has already been acquired by the caller. */
	private async getPacketUnlocked(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		while (true) {
			const index = binarySearchLessOrEqual(
				this.demuxer.videoSamples,
				timestamp,
				x => x.timestamp,
			);

			if (index === -1 && this.demuxer.videoSamples.length > 0) {
				return null; // Before the first sample
			}

			if (this.demuxer.lastSampleLoaded) {
				this.demuxer.computeDurations(this.demuxer.videoSamples);
				return this.getPacketAtIndex(index, options);
			}

			if (index >= 0 && index + 1 < this.demuxer.videoSamples.length) {
				this.demuxer.computeDurations(this.demuxer.videoSamples);
				return this.getPacketAtIndex(index, options);
			}

			await this.demuxer.advanceReader();
		}
	}

	async getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
		const release = await this.demuxer.readingMutex.acquire();

		try {
			// Fast path: jump using the onMetaData keyframe index, then return the keyframe at or before the target
			const indexedSample = await this.seekUsingKeyframeIndex(timestamp);
			if (indexedSample !== null) {
				this.demuxer.computeDurations(this.demuxer.videoSamples);
				return this.getPacketAtIndex(indexedSample, options);
			}

			// Fallback: scan forward to the target and walk back to the nearest keyframe
			const packet = await this.getPacketUnlocked(timestamp, options);
			if (!packet) {
				return null;
			}

			let index = this.findSampleIndex(packet);
			if (index === -1) {
				return null;
			}

			while (index > 0 && !this.demuxer.videoSamples[index]!.isKey) {
				index--;
			}

			return this.getPacketAtIndex(index, options);
		} finally {
			release();
		}
	}

	/**
	 * Uses the optional onMetaData keyframe index to locate the last keyframe whose time is at or before the target.
	 * Returns the sample index, or null when no usable index exists or the lookup fails.
	 */
	private async seekUsingKeyframeIndex(timestamp: number): Promise<number | null> {
		const index = this.demuxer.keyframeIndex;
		if (!index || index.times.length === 0) {
			return null;
		}

		let chosen = -1;
		for (let i = 0; i < index.times.length; i++) {
			if (index.times[i]! <= timestamp) {
				chosen = i;
			} else {
				break;
			}
		}

		if (chosen === -1) {
			return null;
		}

		const targetPosition = index.filePositions[chosen]!;

		// Scan tags until the keyframe's tag has been indexed (the index points at the start of the tag)
		while (
			!this.demuxer.lastSampleLoaded
			&& this.demuxer.lastLoadedPos <= targetPosition
		) {
			await this.demuxer.advanceReader();
		}

		const sampleIndex = this.demuxer.videoSamples.findIndex(sample => sample.tagStart === targetPosition);
		return sampleIndex === -1 ? null : sampleIndex;
	}

	async getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		const release = await this.demuxer.readingMutex.acquire();

		try {
			const sampleIndex = this.findSampleIndex(packet);
			if (sampleIndex === -1) {
				throw new Error('Packet was not created from this track.');
			}

			let nextIndex = sampleIndex + 1;
			while (true) {
				while (
					nextIndex >= this.demuxer.videoSamples.length
					&& !this.demuxer.lastSampleLoaded
				) {
					await this.demuxer.advanceReader();
				}

				const sample = this.demuxer.videoSamples[nextIndex];
				if (!sample) {
					return null;
				}

				if (sample.isKey) {
					this.demuxer.computeDurations(this.demuxer.videoSamples);
					return this.getPacketAtIndex(nextIndex, options);
				}

				nextIndex++;
			}
		} finally {
			release();
		}
	}

	private findSampleIndex(packet: EncodedPacket) {
		// The packet's sequence number is the index of its sample within the track, so use it directly rather than
		// searching by timestamp (which can be ambiguous with B-frames or coinciding timestamps).
		const sampleIndex = packet.sequenceNumber;
		return this.demuxer.videoSamples[sampleIndex] ? sampleIndex : -1;
	}
}

class FlvAudioTrackBacking extends FlvTrackBacking implements InputAudioTrackBacking {
	getType() {
		return 'audio' as const;
	}

	getId() {
		return 2;
	}

	getNumber() {
		return 1;
	}

	getPairingMask() {
		return 1n;
	}

	getCodec(): AudioCodec {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.codec;
	}

	getNumberOfChannels() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.numberOfChannels;
	}

	getSampleRate() {
		assert(this.demuxer.audioInfo);
		return this.demuxer.audioInfo.sampleRate;
	}

	async getHasOnlyKeyPackets() {
		return true;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		const info = this.demuxer.audioInfo;
		assert(info);

		const config: AudioDecoderConfig = {
			codec: this.demuxer.buildAudioCodecString(),
			numberOfChannels: info.numberOfChannels,
			sampleRate: info.sampleRate,
		};

		if (info.description) {
			config.description = info.description.slice();
		}

		return config;
	}

	async getPacketAtIndex(sampleIndex: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		if (sampleIndex === -1) {
			return null;
		}

		const sample = this.demuxer.audioSamples[sampleIndex];
		if (!sample) {
			return null;
		}

		let data: Uint8Array;
		if (options.metadataOnly) {
			data = PLACEHOLDER_DATA;
		} else {
			let slice = this.demuxer.reader.requestSlice(sample.dataStart, sample.dataSize);
			if (isThenable(slice)) slice = await slice;

			if (!slice) {
				return null;
			}

			data = readBytes(slice, sample.dataSize);
		}

		return new EncodedPacket(
			data,
			'key',
			sample.timestamp,
			sample.duration,
			sample.sequenceNumber,
			sample.dataSize,
		);
	}

	async getFirstPacket(options: PacketRetrievalOptions) {
		const release = await this.demuxer.readingMutex.acquire();

		try {
			await this.demuxer.readMetadata();
			return this.getPacketAtIndex(0, options);
		} finally {
			release();
		}
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		const release = await this.demuxer.readingMutex.acquire();

		try {
			// The packet's sequence number equals the sample index within the audio track
			const sampleIndex = packet.sequenceNumber;
			if (!this.demuxer.audioSamples[sampleIndex]) {
				throw new Error('Packet was not created from this track.');
			}

			const nextIndex = sampleIndex + 1;
			while (
				nextIndex >= this.demuxer.audioSamples.length
				&& !this.demuxer.lastSampleLoaded
			) {
				await this.demuxer.advanceReader();
			}

			this.demuxer.computeDurations(this.demuxer.audioSamples);
			return this.getPacketAtIndex(nextIndex, options);
		} finally {
			release();
		}
	}

	async getPacket(timestamp: number, options: PacketRetrievalOptions) {
		const release = await this.demuxer.readingMutex.acquire();

		try {
			while (true) {
				const index = binarySearchLessOrEqual(
					this.demuxer.audioSamples,
					timestamp,
					x => x.timestamp,
				);

				if (index === -1 && this.demuxer.audioSamples.length > 0) {
					return null;
				}

				if (this.demuxer.lastSampleLoaded) {
					this.demuxer.computeDurations(this.demuxer.audioSamples);
					return this.getPacketAtIndex(index, options);
				}

				if (index >= 0 && index + 1 < this.demuxer.audioSamples.length) {
					this.demuxer.computeDurations(this.demuxer.audioSamples);
					return this.getPacketAtIndex(index, options);
				}

				await this.demuxer.advanceReader();
			}
		} finally {
			release();
		}
	}

	getKeyPacket(timestamp: number, options: PacketRetrievalOptions) {
		return this.getPacket(timestamp, options);
	}

	getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions) {
		return this.getNextPacket(packet, options);
	}
}

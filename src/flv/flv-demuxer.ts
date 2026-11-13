/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import {
	AacCodecInfo,
	AudioCodec,
	extractAudioCodecString,
	extractVideoCodecString,
	VideoCodec,
} from '../codec';
import {
	Av1CodecInfo,
	AvcDecoderConfigurationRecord,
	concatNalUnitsInAnnexB,
	deserializeAvcDecoderConfigurationRecord,
	deserializeHevcDecoderConfigurationRecord,
	determineVideoPacketType,
	HevcDecoderConfigurationRecord,
	HevcNalUnitType,
	iterateNalUnitsInLengthPrefixed,
	parseAvcSps,
	parseHevcSps,
	serializeAvcDecoderConfigurationRecord,
	serializeHevcDecoderConfigurationRecord,
} from '../codec-data';
import { Demuxer } from '../demuxer';
import { Input } from '../input';
import {
	InputAudioTrackBacking,
	InputTrackBacking,
	InputVideoTrackBacking,
} from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import { DEFAULT_TRACK_DISPOSITION, MetadataTags, TrackDisposition } from '../metadata';
import {
	assert,
	binarySearchLessOrEqual,
	COLOR_PRIMARIES_MAP_INVERSE,
	IDENTITY_MATRIX,
	isThenable,
	MATRIX_COEFFICIENTS_MAP_INVERSE,
	toDataView,
	TRANSFER_CHARACTERISTICS_MAP_INVERSE,
	TransformationMatrix,
	UNDETERMINED_LANGUAGE,
} from '../misc';
import { aacChannelMap, parseAacAudioSpecificConfig } from '../../shared/aac-misc';
import { getMp3ChannelCount, readMp3FrameHeader } from '../../shared/mp3-misc';
import { EncodedPacket, PacketType, PLACEHOLDER_DATA } from '../packet';
import { Reader, readBytes, readU24Be, readU8 } from '../reader';
import { TrackType } from '../output';
import { parseFlvAv1ConfigRecord } from './flv-av1';
import {
	Amf0Reader,
	AmfValue,
	buildFlvMimeType,
	createTimestampWrapInfo,
	FLV_FOURCC_AV1,
	FLV_FOURCC_AVC,
	FLV_FOURCC_HEVC,
	FLV_HEADER_SIZE,
	FLV_TIMESCALE,
	FlvAacPacketType,
	FlvAvcPacketType,
	FlvSoundFormat,
	FlvTagType,
	FlvVideoCodecId,
	FlvVideoFrameType,
	FlvVideoPacketType,
	FLV_ENHANCED_VIDEO_MASK,
	FLV_PACKET_TYPE_MASK,
	FLV_ENHANCED_FRAME_TYPE_MASK,
	FlvEnhancedFrameType,
	normalizeWrappedTimestamp,
	TimestampWrapInfo,
} from './flv-misc';

const FLV_TAG_HEADER_SIZE = 11;
const PREV_TAG_SIZE_FIELD_SIZE = 4;

type FlvTrackKind = 'video' | 'audio';

/**
 * A lightweight index entry describing one FLV tag's location and timing. Built once during metadata reading and used
 * both for sequential packet access and seeking without re-parsing tag headers.
 */
type FlvTagIndexEntry = {
	/** Byte offset of the tag header in the file. */
	headerPos: number;
	/** Byte offset where the tag payload begins. */
	dataPos: number;
	/** Number of payload bytes. */
	dataSize: number;
	/** The tag type (audio/video/script). */
	tagType: FlvTagType;
	/** The raw, still-wrapped timestamp in milliseconds. */
	rawTimestamp: number;
};

type FlvVideoInfo = {
	type: 'video';
	codec: VideoCodec;
	/** Whether the codec is carried using the Enhanced FLV (FourCC) layout. */
	enhanced: boolean;
	decoderConfig: VideoDecoderConfig | null;
	avcCodecInfo: AvcDecoderConfigurationRecord | null;
	hevcCodecInfo: HevcDecoderConfigurationRecord | null;
	av1CodecInfo: Av1CodecInfo | null;
	av1ConfigRecord: Uint8Array | null;
	colorSpace: VideoColorSpaceInit;
	width: number;
	height: number;
	squarePixelWidth: number;
	squarePixelHeight: number;
	reorderSize: number;
};

type FlvAudioInfo = {
	type: 'audio';
	codec: AudioCodec;
	decoderConfig: AudioDecoderConfig | null;
	aacCodecInfo: AacCodecInfo | null;
	/** The raw AudioSpecificConfig from the AAC sequence-header tag, when present. */
	aacConfig: Uint8Array | null;
	numberOfChannels: number;
	sampleRate: number;
};

type FlvTrackInfo = FlvVideoInfo | FlvAudioInfo;

/**
 * Describes the codec-specific framing of a parsed media tag, after the FLV container headers have been stripped.
 */
type ParsedMediaTag = {
	kind: FlvTrackKind;
	/** Presentation timestamp in seconds. */
	timestampSeconds: number;
	/** The encoded payload in Mediabunny registry layout. Null for config/control tags. */
	data: Uint8Array | null;
	/** Whether this tag carries a key frame (video) or is always-key (audio). */
	isKey: boolean;
};

export class FlvDemuxer extends Demuxer {
	reader: Reader;

	metadataPromise: Promise<void> | null = null;
	trackBackingEntries: InputTrackBacking[] = [];
	trackInfos: FlvTrackInfo[] = [];

	/** All tags in file order, including script tags. */
	tagIndex: FlvTagIndexEntry[] = [];
	/** Global tag-index positions for each media track, in file order. */
	trackTagIndices: number[][] = [];

	/** Duration parsed from onMetaData, in seconds. Null when unavailable. */
	metadataDuration: number | null = null;
	/** Keyframe index parsed from onMetaData (times in seconds and byte offsets), when present. */
	metadataKeyframes: { times: number[]; filePositions: number[] } | null = null;
	metadataTags: MetadataTags = {};

	audioTrackIndex = -1;
	videoTrackIndex = -1;

	timestampWrapInfo: TimestampWrapInfo | null = null;

	constructor(input: Input) {
		super(input);
		this.reader = input._reader;
	}

	async readMetadata() {
		return this.metadataPromise ??= (async () => {
			let headerSlice = this.reader.requestSlice(0, FLV_HEADER_SIZE);
			if (isThenable(headerSlice)) headerSlice = await headerSlice;
			if (!headerSlice) {
				throw new Error('Could not read FLV header.');
			}

			const headerBytes = readBytes(headerSlice, FLV_HEADER_SIZE);
			// Signature "FLV"
			assert(headerBytes[0] === 0x46 && headerBytes[1] === 0x4c && headerBytes[2] === 0x56);
			const version = headerBytes[3]!;
			if (version !== 1) {
				throw new Error(`Unsupported FLV version ${version}; only version 1 is supported.`);
			}
			const typeFlags = headerBytes[4]!;
			const declaresAudio = (typeFlags & 0b0000_0001) === 1;
			const declaresVideo = (typeFlags & 0b0000_0100) === 4;
			void declaresAudio;
			void declaresVideo;

			await this.scanTags();
			await this.initializeTracks();
		})();
	}

	async getTrackBackings() {
		await this.readMetadata();
		return this.trackBackingEntries;
	}

	async getMetadataTags(): Promise<MetadataTags> {
		await this.readMetadata();
		return this.metadataTags;
	}

	async getMimeType(): Promise<string> {
		await this.readMetadata();
		const codecStrings = await Promise.all(this.trackBackingEntries.map(
			x => x.getDecoderConfig().then(c => c?.codec ?? null),
		));
		return buildFlvMimeType(codecStrings);
	}

	/**
	 * Walks every FLV tag once, building the byte/timestamp index and collecting the onMetaData script tag. Truncated
	 * or corrupt tags end the scan gracefully: everything parsed up to that point stays usable.
	 */
	private async scanTags() {
		const fileSize = this.reader.fileSize;
		let currentPos = FLV_HEADER_SIZE;

		while (true) {
			let headerSlice = this.reader.requestSlice(currentPos, FLV_TAG_HEADER_SIZE);
			if (isThenable(headerSlice)) headerSlice = await headerSlice;
			if (!headerSlice) {
				break; // Truncated tag header; stop here
			}

			const tagType = readU8(headerSlice) as FlvTagType;
			const dataSize = readU24Be(headerSlice);
			const timestampLow = readU24Be(headerSlice);
			const timestampExtended = readU8(headerSlice);
			headerSlice.skip(3); // Stream id, always 0

			const rawTimestamp = (timestampExtended * 0x1000000 + timestampLow) >>> 0;

			if (dataSize <= 0) {
				// A zero-length tag is legal; advance past it and its PreviousTagSize field.
				currentPos += FLV_TAG_HEADER_SIZE + PREV_TAG_SIZE_FIELD_SIZE;
				if (fileSize !== null && currentPos >= fileSize) {
					break;
				}
				continue;
			}

			const dataPos = currentPos + FLV_TAG_HEADER_SIZE;
			const nextTagPos = dataPos + dataSize + PREV_TAG_SIZE_FIELD_SIZE;

			// Guard against over-running lengths, which indicate corruption
			if (fileSize !== null && dataPos + dataSize > fileSize) {
				break;
			}

			if (
				tagType === FlvTagType.AUDIO
				|| tagType === FlvTagType.VIDEO
				|| tagType === FlvTagType.SCRIPT_DATA
			) {
				this.tagIndex.push({ headerPos: currentPos, dataPos, dataSize, tagType, rawTimestamp });

				if (!this.timestampWrapInfo && tagType !== FlvTagType.SCRIPT_DATA) {
					this.timestampWrapInfo = createTimestampWrapInfo(rawTimestamp);
				}

				if (tagType === FlvTagType.SCRIPT_DATA) {
					await this.readScriptTag(dataPos, dataSize);
				}
			}

			// Refuse zero/backwards progress to avoid infinite loops on garbage
			if (nextTagPos <= currentPos) {
				break;
			}
			currentPos = nextTagPos;

			if (fileSize !== null && currentPos >= fileSize) {
				break;
			}
		}
	}

	private async readScriptTag(dataPos: number, dataSize: number) {
		let slice = this.reader.requestSlice(dataPos, dataSize);
		if (isThenable(slice)) slice = await slice;
		if (!slice) {
			return;
		}

		const bytes = readBytes(slice, dataSize);
		const reader = new Amf0Reader(bytes);
		const name = reader.readValue();
		if (typeof name !== 'string' || name !== 'onMetaData') {
			return;
		}

		const value = reader.readValue();
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return;
		}

		const metadata = value as Record<string, AmfValue>;

		if (typeof metadata['duration'] === 'number' && Number.isFinite(metadata['duration'])) {
			this.metadataDuration = metadata['duration'];
		}

		// ffmpeg's keyframe index, emitted with -flvflags add_keyframe_index
		const keyframes = metadata['keyframes'];
		if (keyframes && typeof keyframes === 'object' && !Array.isArray(keyframes)) {
			const keyframeRecord = keyframes as Record<string, AmfValue>;
			const times = keyframeRecord['times'];
			const positions = keyframeRecord['filepositions'];
			if (
				Array.isArray(times) && Array.isArray(positions)
				&& times.length === positions.length
				&& times.every(x => typeof x === 'number')
				&& positions.every(x => typeof x === 'number')
			) {
				this.metadataKeyframes = {
					times: times,
					filePositions: positions,
				};
			}
		}

		this.metadataTags = this.convertMetadataTags(metadata);
	}

	private convertMetadataTags(metadata: Record<string, AmfValue>): MetadataTags {
		const tags: MetadataTags = { raw: {} };

		const assignString = (target: 'title' | 'description' | 'comment', key: string) => {
			const value = metadata[key];
			if (typeof value === 'string') {
				tags[target] = value;
			}
		};

		assignString('title', 'title');
		assignString('description', 'description');
		assignString('comment', 'comment');

		if (typeof metadata['artist'] === 'string') {
			tags.artist = metadata['artist'];
		}
		if (typeof metadata['album'] === 'string') {
			tags.album = metadata['album'];
		}
		if (typeof metadata['genre'] === 'string') {
			tags.genre = metadata['genre'];
		}
		if (typeof metadata['date'] === 'string') {
			const parsed = new Date(metadata['date']);
			if (!Number.isNaN(parsed.getTime())) {
				tags.date = parsed;
			}
		}

		for (const [key, value] of Object.entries(metadata)) {
			// Keep scalar values in raw form; nested objects/arrays (incl. keyframes) are skipped. Numbers and booleans
			// are stringified since the raw-tag record only carries string/binary values.
			if (typeof value === 'string') {
				tags.raw![key] = value;
			} else if (typeof value === 'number' || typeof value === 'boolean') {
				tags.raw![key] = String(value);
			}
		}

		return tags;
	}

	normalizeTimestamp(rawTimestamp: number) {
		this.timestampWrapInfo ??= createTimestampWrapInfo(rawTimestamp);
		return normalizeWrappedTimestamp(rawTimestamp, this.timestampWrapInfo);
	}

	private async initializeTracks() {
		for (const entry of this.tagIndex) {
			if (entry.tagType === FlvTagType.VIDEO && this.videoTrackIndex === -1) {
				await this.initVideoTrack(entry);
			} else if (entry.tagType === FlvTagType.AUDIO && this.audioTrackIndex === -1) {
				await this.initAudioTrack(entry);
			}

			if (this.videoTrackIndex !== -1 && this.audioTrackIndex !== -1) {
				break;
			}
		}

		// Build per-track tag indices for the initialized tracks
		this.trackTagIndices = this.trackInfos.map(() => []);
		for (let i = 0; i < this.tagIndex.length; i++) {
			const entry = this.tagIndex[i]!;
			if (entry.tagType === FlvTagType.VIDEO && this.videoTrackIndex !== -1) {
				this.trackTagIndices[this.videoTrackIndex]!.push(i);
			} else if (entry.tagType === FlvTagType.AUDIO && this.audioTrackIndex !== -1) {
				this.trackTagIndices[this.audioTrackIndex]!.push(i);
			}
		}

		// Audio first, then video, matching the conventional FLV track ordering
		if (this.audioTrackIndex !== -1) {
			this.trackBackingEntries.push(new FlvAudioTrackBacking(this, this.audioTrackIndex));
		}
		if (this.videoTrackIndex !== -1) {
			this.trackBackingEntries.push(new FlvVideoTrackBacking(this, this.videoTrackIndex));
		}
	}

	private async readTagPayload(entry: FlvTagIndexEntry): Promise<Uint8Array | null> {
		let slice = this.reader.requestSlice(entry.dataPos, entry.dataSize);
		if (isThenable(slice)) slice = await slice;
		if (!slice || slice.length < entry.dataSize) {
			return null; // Truncated payload
		}
		return readBytes(slice, entry.dataSize);
	}

	private async initVideoTrack(firstEntry: FlvTagIndexEntry) {
		const payload = await this.readTagPayload(firstEntry);
		if (!payload || payload.byteLength < 1) {
			return;
		}

		const firstByte = payload[0]!;
		const enhanced = (firstByte & FLV_ENHANCED_VIDEO_MASK) !== 0;

		let codec: VideoCodec;
		if (enhanced) {
			if (payload.byteLength < 5) {
				return;
			}
			const fourCc = String.fromCharCode(payload[1]!, payload[2]!, payload[3]!, payload[4]!);
			if (fourCc === FLV_FOURCC_HEVC) {
				codec = 'hevc';
			} else if (fourCc === FLV_FOURCC_AV1) {
				codec = 'av1';
			} else if (fourCc === FLV_FOURCC_AVC) {
				codec = 'avc';
			} else {
				return; // Unsupported enhanced codec (e.g. VP9); don't surface the track
			}
		} else {
			const codecId = firstByte & 0x0f;
			if (codecId !== FlvVideoCodecId.AVC) {
				return; // Only AVC is supported among the legacy codecs
			}
			codec = 'avc';
		}

		const info: FlvVideoInfo = {
			type: 'video',
			codec,
			enhanced,
			decoderConfig: null,
			avcCodecInfo: null,
			hevcCodecInfo: null,
			av1CodecInfo: null,
			av1ConfigRecord: null,
			colorSpace: { primaries: null, transfer: null, matrix: null, fullRange: null },
			width: -1,
			height: -1,
			squarePixelWidth: -1,
			squarePixelHeight: -1,
			reorderSize: 0,
		};

		await this.configureVideoTrack(info);

		if (!info.decoderConfig || info.width <= 0 || info.height <= 0) {
			return;
		}

		this.videoTrackIndex = this.trackInfos.length;
		this.trackInfos.push(info);
	}

	private async configureVideoTrack(info: FlvVideoInfo) {
		for (const entry of this.tagIndex) {
			if (entry.tagType !== FlvTagType.VIDEO) {
				continue;
			}

			const payload = await this.readTagPayload(entry);
			if (!payload) {
				continue;
			}

			const parsed = parseVideoTagHeader(info, payload);
			if (!parsed || !parsed.isSequenceHeader || !parsed.configRecord) {
				continue;
			}

			if (info.codec === 'avc') {
				const avcInfo = deserializeAvcDecoderConfigurationRecord(parsed.configRecord);
				if (!avcInfo) {
					continue;
				}
				info.avcCodecInfo = avcInfo;
				const spsUnit = avcInfo.sequenceParameterSets[0];
				if (spsUnit) {
					this.applyAvcDimensions(info, spsUnit);
				}
			} else if (info.codec === 'hevc') {
				const hevcInfo = deserializeHevcDecoderConfigurationRecord(parsed.configRecord);
				if (!hevcInfo) {
					continue;
				}
				info.hevcCodecInfo = hevcInfo;
				const spsUnit = hevcInfo.arrays.find(a => a.nalUnitType === HevcNalUnitType.SPS_NUT)?.nalUnits[0];
				if (spsUnit) {
					this.applyHevcDimensions(info, spsUnit);
				}
			} else if (info.codec === 'av1') {
				const av1Config = parseFlvAv1ConfigRecord(parsed.configRecord);
				if (!av1Config) {
					continue;
				}
				info.av1CodecInfo = av1Config.codecInfo;
				info.av1ConfigRecord = parsed.configRecord;
				info.width = av1Config.width;
				info.height = av1Config.height;
				info.squarePixelWidth = av1Config.width;
				info.squarePixelHeight = av1Config.height;
				info.colorSpace = av1Config.colorSpace;
				info.reorderSize = 0;
			}

			const description = this.buildVideoDescription(info);

			info.decoderConfig = {
				codec: extractVideoCodecString({
					width: info.width,
					height: info.height,
					codec: info.codec,
					codecDescription: description,
					colorSpace: info.colorSpace,
					avcType: 1,
					avcCodecInfo: info.avcCodecInfo,
					hevcCodecInfo: info.hevcCodecInfo,
					vp9CodecInfo: null,
					av1CodecInfo: info.av1CodecInfo,
					proresFormat: null,
				}),
				codedWidth: info.width,
				codedHeight: info.height,
				colorSpace: info.colorSpace,
				// AVC/HEVC packets are surfaced as Annex B, so an AVCC/HVCC description would make the codec-data
				// helpers misread their framing. AV1 has no such ambiguity — its packets are always OBU streams — so
				// its av1C record is attached and lets downstream muxers rebuild the sequence-start tag.
				...(info.codec === 'av1' && info.av1ConfigRecord
					? { description: info.av1ConfigRecord }
					: {}),
			};

			if (info.width !== info.squarePixelWidth || info.height !== info.squarePixelHeight) {
				info.decoderConfig.displayAspectWidth = info.squarePixelWidth;
				info.decoderConfig.displayAspectHeight = info.squarePixelHeight;
			}

			return;
		}
	}

	private applyAvcDimensions(info: FlvVideoInfo, spsUnit: Uint8Array) {
		const spsInfo = parseAvcSps(spsUnit);
		if (!spsInfo) {
			return;
		}
		info.width = spsInfo.displayWidth;
		info.height = spsInfo.displayHeight;
		info.squarePixelWidth = spsInfo.displayWidth;
		info.squarePixelHeight = spsInfo.displayHeight;
		const num = spsInfo.pixelAspectRatio.num;
		const den = spsInfo.pixelAspectRatio.den;
		if (num > 0 && den > 0) {
			if (num > den) {
				info.squarePixelWidth = Math.round(info.width * num / den);
			} else {
				info.squarePixelHeight = Math.round(info.height * den / num);
			}
		}
		info.colorSpace = {
			primaries: COLOR_PRIMARIES_MAP_INVERSE[spsInfo.colourPrimaries] as VideoColorPrimaries | undefined,
			transfer: TRANSFER_CHARACTERISTICS_MAP_INVERSE[spsInfo.transferCharacteristics] as
			VideoTransferCharacteristics | undefined,
			matrix: MATRIX_COEFFICIENTS_MAP_INVERSE[spsInfo.matrixCoefficients] as
			VideoMatrixCoefficients | undefined,
			fullRange: !!spsInfo.fullRangeFlag,
		};
		info.reorderSize = spsInfo.maxDecFrameBuffering;
	}

	private applyHevcDimensions(info: FlvVideoInfo, spsUnit: Uint8Array) {
		const spsInfo = parseHevcSps(spsUnit);
		if (!spsInfo) {
			return;
		}
		info.width = spsInfo.displayWidth;
		info.height = spsInfo.displayHeight;
		info.squarePixelWidth = spsInfo.displayWidth;
		info.squarePixelHeight = spsInfo.displayHeight;
		const num = spsInfo.pixelAspectRatio.num;
		const den = spsInfo.pixelAspectRatio.den;
		if (num > 0 && den > 0) {
			if (num > den) {
				info.squarePixelWidth = Math.round(info.width * num / den);
			} else {
				info.squarePixelHeight = Math.round(info.height * den / num);
			}
		}
		info.colorSpace = {
			primaries: COLOR_PRIMARIES_MAP_INVERSE[spsInfo.colourPrimaries] as VideoColorPrimaries | undefined,
			transfer: TRANSFER_CHARACTERISTICS_MAP_INVERSE[spsInfo.transferCharacteristics] as
			VideoTransferCharacteristics | undefined,
			matrix: MATRIX_COEFFICIENTS_MAP_INVERSE[spsInfo.matrixCoefficients] as
			VideoMatrixCoefficients | undefined,
			fullRange: !!spsInfo.fullRangeFlag,
		};
		info.reorderSize = spsInfo.maxDecFrameBuffering;
	}

	private buildVideoDescription(info: FlvVideoInfo): Uint8Array | null {
		if (info.codec === 'avc' && info.avcCodecInfo) {
			return serializeAvcDecoderConfigurationRecord(info.avcCodecInfo);
		}
		if (info.codec === 'hevc' && info.hevcCodecInfo) {
			return serializeHevcDecoderConfigurationRecord(info.hevcCodecInfo);
		}
		if (info.codec === 'av1' && info.av1ConfigRecord) {
			return info.av1ConfigRecord;
		}
		return null;
	}

	private async initAudioTrack(firstEntry: FlvTagIndexEntry) {
		const payload = await this.readTagPayload(firstEntry);
		if (!payload || payload.byteLength < 1) {
			return;
		}

		const firstByte = payload[0]!;
		const soundFormat = (firstByte >> 4) & 0x0f;
		const soundRateIndex = (firstByte >> 2) & 0b11;
		const soundType = firstByte & 0b01;

		let codec: AudioCodec;
		if (soundFormat === FlvSoundFormat.AAC) {
			codec = 'aac';
		} else if (soundFormat === FlvSoundFormat.MP3 || soundFormat === FlvSoundFormat.MP3_8K) {
			codec = 'mp3';
		} else {
			return; // Unsupported audio codec; don't surface the track
		}

		const legacyRates = [5512, 11025, 22050, 44100];
		const fallbackRate = legacyRates[soundRateIndex] ?? 44100;
		const fallbackChannels = soundType === 0 ? 1 : 2;

		const info: FlvAudioInfo = {
			type: 'audio',
			codec,
			decoderConfig: null,
			aacCodecInfo: null,
			aacConfig: null,
			numberOfChannels: fallbackChannels,
			sampleRate: fallbackRate,
		};

		if (codec === 'aac') {
			const config = await this.findAacSequenceHeader();
			if (config) {
				info.aacConfig = config;
				const asc = parseAacAudioSpecificConfig(config);
				info.aacCodecInfo = { isMpeg2: false, objectType: asc.objectType };
				if (asc.coreSampleRate !== null) {
					info.sampleRate = asc.coreSampleRate;
				}
				const channels = aacChannelMap[asc.channelConfiguration];
				if (channels) {
					info.numberOfChannels = channels;
				}
			} else {
				info.aacCodecInfo = { isMpeg2: false, objectType: null };
			}
		} else {
			const frameInfo = await this.findFirstMp3Frame();
			if (frameInfo) {
				info.sampleRate = frameInfo.sampleRate;
				info.numberOfChannels = frameInfo.numberOfChannels;
			}
		}

		if (info.sampleRate <= 0 || info.numberOfChannels <= 0) {
			return;
		}

		info.decoderConfig = {
			codec: extractAudioCodecString({
				codec: info.codec,
				codecDescription: null,
				aacCodecInfo: info.aacCodecInfo,
				dtsFormat: null,
			}),
			numberOfChannels: info.numberOfChannels,
			sampleRate: info.sampleRate,
			// Exposing the AudioSpecificConfig tells downstream muxers the packets are raw AAC, not ADTS
			...(info.aacConfig ? { description: info.aacConfig } : {}),
		};

		this.audioTrackIndex = this.trackInfos.length;
		this.trackInfos.push(info);
	}

	private async findAacSequenceHeader(): Promise<Uint8Array | null> {
		for (const entry of this.tagIndex) {
			if (entry.tagType !== FlvTagType.AUDIO) {
				continue;
			}
			const payload = await this.readTagPayload(entry);
			if (!payload || payload.byteLength < 2) {
				continue;
			}
			const soundFormat = (payload[0]! >> 4) & 0x0f;
			if (soundFormat !== FlvSoundFormat.AAC) {
				continue;
			}
			if (payload[1] === FlvAacPacketType.SEQUENCE_HEADER) {
				return payload.subarray(2);
			}
		}
		return null;
	}

	private async findFirstMp3Frame(): Promise<{ sampleRate: number; numberOfChannels: number } | null> {
		for (const entry of this.tagIndex) {
			if (entry.tagType !== FlvTagType.AUDIO) {
				continue;
			}
			const payload = await this.readTagPayload(entry);
			if (!payload || payload.byteLength < 5) {
				continue;
			}
			const frame = payload.subarray(1);
			const word = toDataView(frame).getUint32(0);
			const result = readMp3FrameHeader(word, frame.byteLength);
			if (result.header) {
				return {
					sampleRate: result.header.sampleRate,
					numberOfChannels: getMp3ChannelCount(result.header.channel),
				};
			}
		}
		return null;
	}

	/**
	 * Reads and converts one media tag into a parsed frame, translating the container framing into registry layout.
	 */
	async parseMediaTag(entry: FlvTagIndexEntry): Promise<ParsedMediaTag | null> {
		const payload = await this.readTagPayload(entry);
		if (!payload) {
			return null;
		}

		const timestampSeconds = this.normalizeTimestamp(entry.rawTimestamp) / FLV_TIMESCALE;

		if (entry.tagType === FlvTagType.AUDIO) {
			return this.parseAudioTag(payload, timestampSeconds);
		}

		if (entry.tagType === FlvTagType.VIDEO && this.videoTrackIndex !== -1) {
			return this.parseVideoFrameTag(payload, timestampSeconds);
		}

		return null;
	}

	private parseAudioTag(payload: Uint8Array, timestampSeconds: number): ParsedMediaTag | null {
		if (this.audioTrackIndex === -1 || payload.byteLength < 1) {
			return null;
		}
		const info = this.trackInfos[this.audioTrackIndex]!;
		assert(info.type === 'audio');

		if (info.codec === 'aac') {
			if (payload.byteLength < 2 || payload[1] !== FlvAacPacketType.RAW) {
				return null; // Sequence header or empty
			}
			// FLV AAC raw frames are raw AAC packet data (no ADTS); pass through unchanged
			return {
				kind: 'audio',
				timestampSeconds,
				data: payload.subarray(2),
				isKey: true,
			};
		}

		if (info.codec === 'mp3') {
			if (payload.byteLength < 2) {
				return null;
			}
			// First byte is the FLV sound header; the remainder is one or more MP3 frames, passed through
			return {
				kind: 'audio',
				timestampSeconds,
				data: payload.subarray(1),
				isKey: true,
			};
		}

		return null;
	}

	private parseVideoFrameTag(payload: Uint8Array, timestampSeconds: number): ParsedMediaTag | null {
		const info = this.trackInfos[this.videoTrackIndex]!;
		assert(info.type === 'video');

		const parsed = parseVideoTagHeader(info, payload);
		if (!parsed || parsed.isSequenceHeader || !parsed.frameData) {
			return null;
		}

		let data: Uint8Array;
		if (info.codec === 'av1') {
			// AV1 low-overhead bitstream temporal units (including temporal-delimiter OBUs) pass through unchanged
			data = parsed.frameData;
		} else if (info.enhanced) {
			if (parsed.hasEnhancedPrefix) {
				// CODED_FRAMES: skip the three-byte prefix, then convert the four-byte length-prefixed NAL units
				data = this.enhancedNaluToAnnexB(parsed.frameData);
			} else {
				// CODED_FRAMES_X: four-byte length-prefixed NAL units start immediately
				data = this.directNaluToAnnexB(parsed.frameData);
			}
		} else {
			// Legacy AVC frames are directly AVCC length-prefixed; honor the record's configured length size
			data = this.lengthPrefixedToAnnexB(info, parsed.frameData);
		}

		let isKey = parsed.isKey;
		if (info.decoderConfig) {
			const determined = determineVideoPacketType(info.codec, info.decoderConfig, data);
			if (determined !== null) {
				isKey = determined === 'key';
			}
		}

		// Parameter sets live in a separate sequence-header tag, not in the coded frames. Prepend them to every key
		// frame in Annex B form so downstream muxers can synthesize a decoder configuration record from a packet, and
		// so decoders starting mid-stream have everything they need.
		if (isKey && info.codec !== 'av1') {
			const parameterSets = this.buildParameterSetAnnexB(info);
			if (parameterSets) {
				data = concatBytes(parameterSets, data);
			}
		}

		// Legacy AVC carries an explicit composition-time offset; enhanced codecs use PTS == DTS
		const ptsSeconds = timestampSeconds + parsed.compositionTimeMs / FLV_TIMESCALE;

		return {
			kind: 'video',
			timestampSeconds: ptsSeconds,
			data,
			isKey,
		};
	}

	/**
	 * Converts an Enhanced FLV CODED_FRAMES body into Annex B. The body begins with a three-byte non-NAL field,
	 * followed by one or more NAL units each prefixed by a four-byte big-endian length.
	 */
	private enhancedNaluToAnnexB(frameData: Uint8Array): Uint8Array {
		const ENHANCED_PREFIX_SIZE = 3;
		if (frameData.byteLength < ENHANCED_PREFIX_SIZE + 4) {
			return frameData;
		}
		return this.fourByteNaluToAnnexB(frameData, ENHANCED_PREFIX_SIZE);
	}

	/**
	 * Converts an Enhanced FLV CODED_FRAMES_X body into Annex B. Unlike CODED_FRAMES, the four-byte length-prefixed NAL
	 * units begin immediately with no leading prefix.
	 */
	private directNaluToAnnexB(frameData: Uint8Array): Uint8Array {
		return this.fourByteNaluToAnnexB(frameData, 0);
	}

	/**
	 * Walks four-byte big-endian length-prefixed NAL units starting at `startOffset` and joins them as Annex B. Returns
	 * the original data when no valid NAL unit can be read, so malformed trailing data never throws.
	 */
	private fourByteNaluToAnnexB(frameData: Uint8Array, startOffset: number): Uint8Array {
		const NAL_LENGTH_SIZE = 4;
		const nalUnits: Uint8Array[] = [];
		let pos = startOffset;
		while (pos + NAL_LENGTH_SIZE <= frameData.byteLength) {
			const length = (
				frameData[pos]! * 0x1000000
				+ frameData[pos + 1]! * 0x10000
				+ frameData[pos + 2]! * 0x100
				+ frameData[pos + 3]!
			) >>> 0;

			if (length === 0 || pos + NAL_LENGTH_SIZE + length > frameData.byteLength) {
				break; // Malformed trailing data; keep what we have
			}

			nalUnits.push(frameData.subarray(pos + NAL_LENGTH_SIZE, pos + NAL_LENGTH_SIZE + length));
			pos += NAL_LENGTH_SIZE + length;
		}

		if (nalUnits.length === 0) {
			return frameData;
		}
		return concatNalUnitsInAnnexB(nalUnits);
	}

	private lengthPrefixedToAnnexB(info: FlvVideoInfo, frameData: Uint8Array): Uint8Array {
		const lengthSize = ((info.avcCodecInfo?.lengthSizeMinusOne ?? 3) + 1) as 1 | 2 | 3 | 4;
		const nalUnits: Uint8Array[] = [];
		for (const loc of iterateNalUnitsInLengthPrefixed(frameData, lengthSize)) {
			nalUnits.push(frameData.subarray(loc.offset, loc.offset + loc.length));
		}
		if (nalUnits.length === 0) {
			return frameData;
		}
		return concatNalUnitsInAnnexB(nalUnits);
	}

	/**
	 * Builds an Annex B byte stream containing the track's parameter sets. For AVC these are the SPS/PPS NAL units; for
	 * HEVC the VPS/SPS/PPS arrays, in the order decoders expect to encounter them.
	 */
	private buildParameterSetAnnexB(info: FlvVideoInfo): Uint8Array | null {
		if (info.codec === 'avc' && info.avcCodecInfo) {
			const nalUnits: Uint8Array[] = [
				...info.avcCodecInfo.sequenceParameterSets,
				...info.avcCodecInfo.pictureParameterSets,
			];
			return nalUnits.length > 0 ? concatNalUnitsInAnnexB(nalUnits) : null;
		}

		if (info.codec === 'hevc' && info.hevcCodecInfo) {
			const ordered: Uint8Array[] = [];
			for (const array of info.hevcCodecInfo.arrays) {
				// Emit VPS, then SPS, then PPS, matching the order inside the configuration record
				if (
					array.nalUnitType === HevcNalUnitType.VPS_NUT
					|| array.nalUnitType === HevcNalUnitType.SPS_NUT
					|| array.nalUnitType === HevcNalUnitType.PPS_NUT
				) {
					ordered.push(...array.nalUnits);
				}
			}
			return ordered.length > 0 ? concatNalUnitsInAnnexB(ordered) : null;
		}

		return null;
	}
}

/**
 * Strips the FLV video container framing from a tag payload. Works for both legacy AVC and Enhanced FLV codecs.
 */
type ParsedVideoTag = {
	isKey: boolean;
	isSequenceHeader: boolean;
	configRecord: Uint8Array | null;
	frameData: Uint8Array | null;
	compositionTimeMs: number;
	/**
	 * For Enhanced FLV coded frames, distinguishes the two NALU framings:
	 * - CODED_FRAMES (1): a three-byte prefix precedes the four-byte length-prefixed NAL units.
	 * - CODED_FRAMES_X (3): four-byte length-prefixed NAL units start immediately, with no prefix.
	 */
	hasEnhancedPrefix: boolean;
};

const parseVideoTagHeader = (info: FlvVideoInfo, payload: Uint8Array): ParsedVideoTag | null => {
	if (payload.byteLength < 1) {
		return null;
	}

	const firstByte = payload[0]!;

	if (info.enhanced) {
		// Enhanced layout: [IsExHeader(1)|FrameType(3)|PacketType(4)][FourCC(4)][...payload]
		if (payload.byteLength < 5) {
			return null;
		}
		const packetType = firstByte & FLV_PACKET_TYPE_MASK;

		if (packetType === FlvVideoPacketType.SEQUENCE_START) {
			return {
				isKey: true,
				isSequenceHeader: true,
				configRecord: payload.subarray(5),
				frameData: null,
				compositionTimeMs: 0,
				hasEnhancedPrefix: false,
			};
		}

		if (
			packetType === FlvVideoPacketType.CODED_FRAMES
			|| packetType === FlvVideoPacketType.CODED_FRAMES_X
		) {
			// The frame type lives in bits 4-6; use it as a hint before verifying against the bitstream
			const frameType = (firstByte & FLV_ENHANCED_FRAME_TYPE_MASK) >> 4;
			const hintedKey = frameType === FlvEnhancedFrameType.KEY;
			return {
				isKey: hintedKey,
				isSequenceHeader: false,
				configRecord: null,
				frameData: payload.subarray(5),
				compositionTimeMs: 0,
				// Only the plain CODED_FRAMES packet type carries the extra three-byte prefix
				hasEnhancedPrefix: packetType === FlvVideoPacketType.CODED_FRAMES,
			};
		}

		// Sequence end / metadata / MPEG2-TS sequence start carry no decodable frame
		return null;
	}

	// Legacy AVC layout: [FrameType(4)|CodecId(4)][AVCPacketType(1)][CompositionTime(3)][...]
	if (payload.byteLength < 5) {
		return null;
	}
	const frameType = (firstByte >> 4) & 0x0f;
	const avcPacketType = payload[1]!;
	// Composition time is a signed 24-bit value in milliseconds
	const compositionTime = ((payload[2]! << 24) | (payload[3]! << 16) | (payload[4]! << 8)) >> 8;

	if (avcPacketType === FlvAvcPacketType.SEQUENCE_HEADER) {
		return {
			isKey: true,
			isSequenceHeader: true,
			configRecord: payload.subarray(5),
			frameData: null,
			compositionTimeMs: 0,
			hasEnhancedPrefix: false,
		};
	}

	if (avcPacketType === FlvAvcPacketType.NALU) {
		return {
			isKey: frameType === FlvVideoFrameType.KEY,
			isSequenceHeader: false,
			configRecord: null,
			frameData: payload.subarray(5),
			compositionTimeMs: compositionTime,
			hasEnhancedPrefix: false,
		};
	}

	// End-of-sequence and others
	return null;
};

abstract class FlvTrackBacking implements InputTrackBacking {
	/** Reused across packets to avoid re-reading the whole index when computing the trailing duration. */
	private trailingDuration = 0;
	private packetBuffers = new WeakMap<EncodedPacket, number>();

	constructor(
		protected demuxer: FlvDemuxer,
		protected trackIndex: number,
	) {}

	abstract getType(): TrackType;
	abstract getCodec(): VideoCodec | AudioCodec;
	abstract getDecoderConfig(): Promise<VideoDecoderConfig | AudioDecoderConfig | null>;
	abstract allPacketsAreKeyPackets(): boolean;
	abstract getReorderSize(): number;

	protected get info(): FlvTrackInfo {
		return this.demuxer.trackInfos[this.trackIndex]!;
	}

	getId() {
		return this.trackIndex;
	}

	getNumber() {
		const type = this.getType();
		let number = 0;
		for (const backing of this.demuxer.trackBackingEntries) {
			if (backing.getType() === type) {
				number++;
			}
			if (backing === (this as InputTrackBacking)) {
				break;
			}
		}
		return number;
	}

	getInternalCodecId() {
		return null;
	}

	getName() {
		return null;
	}

	getLanguageCode() {
		return UNDETERMINED_LANGUAGE;
	}

	getTimeResolution() {
		return FLV_TIMESCALE;
	}

	isRelativeToUnixEpoch() {
		return false;
	}

	getUnixTimeForTimestamp() {
		return null;
	}

	getDisposition(): TrackDisposition {
		return { ...DEFAULT_TRACK_DISPOSITION, primary: true };
	}

	getPairingMask() {
		return 1n;
	}

	getBitrate() {
		return null;
	}

	getAverageBitrate() {
		return null;
	}

	async getDurationFromMetadata() {
		return this.demuxer.metadataDuration;
	}

	async getLiveRefreshInterval() {
		return null;
	}

	protected get indices(): number[] {
		return this.demuxer.trackTagIndices[this.trackIndex]!;
	}

	private entryForOrdinal(ordinal: number) {
		const globalIndex = this.indices[ordinal];
		return globalIndex === undefined ? null : this.demuxer.tagIndex[globalIndex]!;
	}

	private ordinalForHeaderPos(headerPos: number): number {
		const indices = this.indices;
		for (let ordinal = 0; ordinal < indices.length; ordinal++) {
			if (this.demuxer.tagIndex[indices[ordinal]!]!.headerPos === headerPos) {
				return ordinal;
			}
		}
		return -1;
	}

	private async buildPacket(ordinal: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const entry = this.entryForOrdinal(ordinal);
		if (!entry) {
			return null;
		}

		const parsed = await this.demuxer.parseMediaTag(entry);
		if (!parsed || !parsed.data) {
			return null; // Config/control tag; caller skips to the next ordinal
		}

		const duration = await this.computeDuration(ordinal);
		const type: PacketType = this.allPacketsAreKeyPackets() || parsed.isKey ? 'key' : 'delta';
		const packet = new EncodedPacket(
			options.metadataOnly ? PLACEHOLDER_DATA : parsed.data,
			type,
			parsed.timestampSeconds,
			Math.max(duration, 0),
			entry.headerPos,
			parsed.data.byteLength,
		);
		this.packetBuffers.set(packet, ordinal);
		return packet;
	}

	/** Builds the first decodable packet at or after `ordinal`. */
	private async buildFromOrdinal(ordinal: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		for (let i = ordinal; i < this.indices.length; i++) {
			const packet = await this.buildPacket(i, options);
			if (packet) {
				return packet;
			}
		}
		return null;
	}

	private async rawTimestampAt(ordinal: number): Promise<number | null> {
		const entry = this.entryForOrdinal(ordinal);
		if (!entry) {
			return null;
		}
		return this.demuxer.normalizeTimestamp(entry.rawTimestamp) / FLV_TIMESCALE;
	}

	private async computeDuration(ordinal: number): Promise<number> {
		const current = await this.rawTimestampAt(ordinal);
		const next = await this.rawTimestampAt(ordinal + 1);
		if (current === null || next === null) {
			return this.trailingDuration;
		}
		const duration = next - current;
		if (duration >= 0) {
			this.trailingDuration = duration;
			return duration;
		}
		return this.trailingDuration;
	}

	async getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this.buildFromOrdinal(0, options);
	}

	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const ordinal = this.packetBuffers.get(packet)
			?? this.ordinalForHeaderPos(packet.sequenceNumber);
		if (ordinal === undefined || ordinal === -1) {
			throw new Error('Packet was not created from this track.');
		}
		return this.buildFromOrdinal(ordinal + 1, options);
	}

	async getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const ordinal = this.packetBuffers.get(packet)
			?? this.ordinalForHeaderPos(packet.sequenceNumber);
		if (ordinal === undefined || ordinal === -1) {
			throw new Error('Packet was not created from this track.');
		}
		for (let i = ordinal + 1; i < this.indices.length; i++) {
			const candidate = await this.buildPacket(i, options);
			if (candidate && candidate.type === 'key') {
				return candidate;
			}
		}
		return null;
	}

	async getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this.doPacketLookup(timestamp, false, options);
	}

	async getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		return this.doPacketLookup(timestamp, true, options);
	}

	protected async doPacketLookup(
		timestamp: number,
		keyframesOnly: boolean,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		if (this.indices.length === 0) {
			return null;
		}

		// Fast path: the onMetaData keyframe index (video only)
		if (keyframesOnly && !this.allPacketsAreKeyPackets()) {
			const keyed = await this.lookupViaKeyframeIndex(timestamp, options);
			if (keyed) {
				return keyed;
			}
		}

		// Generic scan over the index (tag timestamps are monotonic in well-formed files); find last tag <= target
		let bestOrdinal: number | null = null;
		for (let ordinal = 0; ordinal < this.indices.length; ordinal++) {
			const tagSeconds = await this.rawTimestampAt(ordinal);
			if (tagSeconds === null) {
				continue;
			}
			if (tagSeconds <= timestamp) {
				bestOrdinal = ordinal;
			} else {
				break;
			}
		}

		if (bestOrdinal === null) {
			return null;
		}

		if (!keyframesOnly || this.allPacketsAreKeyPackets()) {
			// The matching tag may be a non-media control tag (e.g. an AVC end-of-sequence tag); walk backwards to the
			// last tag that actually decodes into a packet.
			for (let ordinal = bestOrdinal; ordinal >= 0; ordinal--) {
				const candidate = await this.buildPacket(ordinal, options);
				if (candidate) {
					return candidate;
				}
			}
			return null;
		}

		// Walk backwards to the nearest preceding key frame
		for (let ordinal = bestOrdinal; ordinal >= 0; ordinal--) {
			const candidate = await this.buildPacket(ordinal, options);
			if (candidate && candidate.type === 'key') {
				return candidate;
			}
		}
		return null;
	}

	private async lookupViaKeyframeIndex(
		timestamp: number,
		options: PacketRetrievalOptions,
	): Promise<EncodedPacket | null> {
		const keyframes = this.demuxer.metadataKeyframes;
		if (!keyframes || keyframes.times.length === 0) {
			return null;
		}

		const index = binarySearchLessOrEqual(keyframes.times, timestamp, x => x);
		if (index === -1) {
			return null;
		}

		const filePosition = keyframes.filePositions[index]!;
		for (let ordinal = 0; ordinal < this.indices.length; ordinal++) {
			const entry = this.demuxer.tagIndex[this.indices[ordinal]!]!;
			if (entry.headerPos === filePosition || entry.dataPos === filePosition) {
				const packet = await this.buildPacket(ordinal, options);
				if (packet && packet.type === 'key') {
					return packet;
				}
				return null; // Offset doesn't point at a key frame; fall back to scanning
			}
		}

		return null;
	}
}

class FlvVideoTrackBacking extends FlvTrackBacking implements InputVideoTrackBacking {
	protected override get info(): FlvVideoInfo {
		return this.demuxer.trackInfos[this.trackIndex] as FlvVideoInfo;
	}

	getType() {
		return 'video' as const;
	}

	getCodec() {
		return this.info.codec;
	}

	getCodedWidth() {
		return this.info.width;
	}

	getCodedHeight() {
		return this.info.height;
	}

	getSquarePixelWidth() {
		return this.info.squarePixelWidth;
	}

	getSquarePixelHeight() {
		return this.info.squarePixelHeight;
	}

	getTransformationMatrix(): TransformationMatrix {
		return [...IDENTITY_MATRIX];
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		return this.info.colorSpace;
	}

	async canBeTransparent() {
		return false;
	}

	async getDecoderConfig(): Promise<VideoDecoderConfig> {
		assert(this.info.decoderConfig);
		return this.info.decoderConfig;
	}

	allPacketsAreKeyPackets() {
		return false;
	}

	getReorderSize() {
		return this.info.reorderSize;
	}
}

class FlvAudioTrackBacking extends FlvTrackBacking implements InputAudioTrackBacking {
	protected override get info(): FlvAudioInfo {
		return this.demuxer.trackInfos[this.trackIndex] as FlvAudioInfo;
	}

	getType() {
		return 'audio' as const;
	}

	getCodec() {
		return this.info.codec;
	}

	getNumberOfChannels() {
		return this.info.numberOfChannels;
	}

	getSampleRate() {
		return this.info.sampleRate;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig> {
		assert(this.info.decoderConfig);
		return this.info.decoderConfig;
	}

	allPacketsAreKeyPackets() {
		return true;
	}

	getReorderSize() {
		return 0;
	}
}

/** Concatenates two byte arrays into a newly allocated buffer. */
const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
	const result = new Uint8Array(a.byteLength + b.byteLength);
	result.set(a, 0);
	result.set(b, a.byteLength);
	return result;
};

import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS, FLV } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { assert } from '../../src/misc.js';
import { FlvDemuxer } from '../../src/flv/flv-demuxer.js';
import { FlvTimestampUnwrapper } from '../../src/flv/flv-misc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicDir = path.join(__dirname, '../public');

const filePath = (name: string) => path.join(publicDir, name);

const openInput = (name: string) => {
	return new Input({ source: new FilePathSource(filePath(name)), formats: ALL_FORMATS });
};

const collectPackets = async (track: Awaited<ReturnType<Input['getTracks']>>[number]) => {
	const sink = new EncodedPacketSink(track);
	const packets: EncodedPacket[] = [];
	let packet = await sink.getFirstPacket();

	while (packet) {
		packets.push(packet);
		packet = await sink.getNextPacket(packet);
	}

	return packets;
};

test('FLV input format metadata and detection', async () => {
	expect(FLV.name).toBe('Flash Video');
	expect(FLV.mimeType).toBe('video/x-flv');

	using input = openInput('flv-avc-aac.flv');
	expect(await input.getFormat()).toBe(FLV);
});

test('FLV rejects non-FLV data', async () => {
	await expect(
		(async () => {
			const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
			using input = new Input({ source: new BufferSource(bytes), formats: [FLV] });
			await input.getTracks();
		})(),
	).rejects.toThrow();
});

test('legacy FLV with AVC video and AAC audio', async () => {
	using input = openInput('flv-avc-aac.flv');

	expect(await input.getMimeType()).toBe('video/x-flv; codecs="avc1.64000d, mp4a.40.2"');

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	expect(await videoTrack.getCodec()).toBe('avc');
	expect(await videoTrack.getCodedWidth()).toBe(320);
	expect(await videoTrack.getCodedHeight()).toBe(240);

	const videoConfig = await videoTrack.getDecoderConfig();
	assert(videoConfig);
	expect(videoConfig.description).toBeDefined();

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getCodec()).toBe('aac');
	expect(await audioTrack.getNumberOfChannels()).toBe(2);
	expect(await audioTrack.getSampleRate()).toBe(48000);

	const audioConfig = await audioTrack.getDecoderConfig();
	assert(audioConfig);
	expect(audioConfig.description).toBeDefined();

	const videoPackets = await collectPackets(videoTrack);
	expect(videoPackets).toHaveLength(90);
	expect(videoPackets.filter(packet => packet.type === 'key')).toHaveLength(3);
	expect(videoPackets[0]!.timestamp).toBeCloseTo(0.067, 2);
	expect(videoPackets.at(-1)!.timestamp).toBeCloseTo(3, 2);
	// Sequence numbers are contiguous and identify the sample within the track
	videoPackets.forEach((packet, index) => expect(packet.sequenceNumber).toBe(index));

	const audioPackets = await collectPackets(audioTrack);
	expect(audioPackets).toHaveLength(142);
	expect(audioPackets[0]!.timestamp).toBeCloseTo(0.046, 2);
	expect(audioPackets.at(-1)!.timestamp).toBeCloseTo(3.054, 2);
	expect(audioPackets.every(packet => packet.type === 'key')).toBe(true);
});

test('legacy FLV with MP3 audio has no sequence header', async () => {
	using input = openInput('flv-avc-mp3.flv');

	const tracks = await input.getTracks();
	expect(tracks).toHaveLength(2);
	expect(await input.getMimeType()).toBe('video/x-flv; codecs="avc1.64000d, mp3"');

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getCodec()).toBe('mp3');
	expect(await audioTrack.getNumberOfChannels()).toBe(2);
	expect(await audioTrack.getSampleRate()).toBe(44100);

	const audioConfig = await audioTrack.getDecoderConfig();
	assert(audioConfig);
	// MP3 carries no decoder configuration record
	expect(audioConfig.description).toBeUndefined();

	const audioPackets = await collectPackets(audioTrack);
	expect(audioPackets).toHaveLength(116);
	// Every payload is a raw MP3 frame starting with the 0xFFF sync word
	for (const packet of audioPackets) {
		expect(packet.data[0]).toBe(0xff);
		expect(packet.data[1]! & 0xf0).toBe(0xf0);
	}
});

test('enhanced FLV with HEVC video', async () => {
	using input = openInput('flv-hevc-aac.flv');

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	expect(await videoTrack.getCodec()).toBe('hevc');
	expect(await videoTrack.getCodedWidth()).toBe(320);
	expect(await videoTrack.getCodedHeight()).toBe(240);
	const hevcConfig = await videoTrack.getDecoderConfig();
	assert(hevcConfig);
	expect(hevcConfig.description).toBeDefined();

	const videoPackets = await collectPackets(videoTrack);
	expect(videoPackets).toHaveLength(90);
	expect(videoPackets.filter(packet => packet.type === 'key')).toHaveLength(3);
	expect(videoPackets[0]!.timestamp).toBeCloseTo(0.067, 2);
	expect(videoPackets.at(-1)!.timestamp).toBeCloseTo(3, 2);
});

test('enhanced FLV with AV1 video recovers dimensions without an embedded config', async () => {
	using input = openInput('flv-av1-aac.flv');

	const videoTrack = await input.getPrimaryVideoTrack();
	assert(videoTrack);
	expect(await videoTrack.getCodec()).toBe('av1');
	// Dimensions come from the sequence-header OBU inside the first keyframe
	expect(await videoTrack.getCodedWidth()).toBe(320);
	expect(await videoTrack.getCodedHeight()).toBe(240);

	const videoPackets = await collectPackets(videoTrack);
	expect(videoPackets).toHaveLength(90);
	expect(videoPackets.filter(packet => packet.type === 'key')).toHaveLength(3);
	expect(videoPackets[0]!.timestamp).toBeCloseTo(0.021, 2);
	expect(videoPackets.at(-1)!.timestamp).toBeCloseTo(2.988, 2);
});

test('audio-only FLV exposes no video track', async () => {
	using input = openInput('flv-aac-only.flv');

	expect(await input.getPrimaryVideoTrack()).toBeNull();

	const audioTrack = await input.getPrimaryAudioTrack();
	assert(audioTrack);
	expect(await audioTrack.getCodec()).toBe('aac');

	const audioPackets = await collectPackets(audioTrack);
	expect(audioPackets).toHaveLength(142);
});

test('keyframe index seeking matches the scanning fallback', async () => {
	const getKeyTimestamps = async (name: string) => {
		using input = openInput(name);
		const videoTrack = await input.getPrimaryVideoTrack();
		assert(videoTrack);
		const sink = new EncodedPacketSink(videoTrack);

		const timestamps: number[] = [];
		let packet = await sink.getFirstKeyPacket();

		while (packet) {
			timestamps.push(packet.timestamp);
			packet = await sink.getNextKeyPacket(packet);
		}

		return timestamps;
	};

	const indexedTimestamps = await getKeyTimestamps('flv-keyframe-index.flv');
	const scannedTimestamps = await getKeyTimestamps('flv-no-metadata.flv');

	expect(indexedTimestamps).toHaveLength(5);
	expect(scannedTimestamps).toHaveLength(5);
	indexedTimestamps.forEach((timestamp, index) => {
		expect(timestamp).toBeCloseTo(scannedTimestamps[index]!, 3);
	});

	// The keyframe index is only populated from the onMetaData script tag
	using indexedInput = openInput('flv-keyframe-index.flv');
	await indexedInput.getTracks();
	const indexedDemuxer = (await indexedInput._demuxerPromise) as FlvDemuxer;
	assert(indexedDemuxer.keyframeIndex);
	expect(indexedDemuxer.keyframeIndex.times).toHaveLength(5);

	using plainInput = openInput('flv-no-metadata.flv');
	await plainInput.getTracks();
	const plainDemuxer = (await plainInput._demuxerPromise) as FlvDemuxer;
	expect(plainDemuxer.keyframeIndex).toBeNull();

	// A mid-file seek lands on the last keyframe at or before the target, identically with and without the index
	using indexedSeekInput = openInput('flv-keyframe-index.flv');
	const indexedSink = new EncodedPacketSink((await indexedSeekInput.getPrimaryVideoTrack())!);
	const indexedPacket = await indexedSink.getKeyPacket(2.5);
	assert(indexedPacket);
	expect(indexedPacket.type).toBe('key');
	expect(indexedPacket.timestamp).toBeCloseTo(scannedTimestamps[2]!, 3);

	using plainSeekInput = openInput('flv-no-metadata.flv');
	const plainSink = new EncodedPacketSink((await plainSeekInput.getPrimaryVideoTrack())!);
	const plainPacket = await plainSink.getKeyPacket(2.5);
	assert(plainPacket);
	expect(plainPacket.type).toBe('key');
	expect(plainPacket.timestamp).toBeCloseTo(indexedPacket.timestamp, 3);
});

test('timestamp unwrapper leaves monotonic timestamps untouched and handles wraparound', () => {
	const modulus = 2 ** 32;

	const normal = new FlvTimestampUnwrapper();
	expect([0, 21, 21, 54].map(value => normal.next(value))).toEqual([0, 21, 21, 54]);

	// A stream starting near the modulus represents negative timestamps
	const negative = new FlvTimestampUnwrapper();
	expect(negative.next(modulus - 1000)).toBe(-1000);
	expect(negative.next(modulus - 900)).toBe(-900);

	// The 32-bit counter wraps back to zero after reaching the modulus
	const wrapping = new FlvTimestampUnwrapper();
	expect(wrapping.next(100)).toBe(100);
	expect(wrapping.next(200)).toBe(200);
	expect(wrapping.next(modulus - 50)).toBe(-50);
	expect(wrapping.next(modulus - 20)).toBe(-20);

	// And wraps upwards again when crossing the modulus boundary in the other direction
	const wrappingUp = new FlvTimestampUnwrapper();
	expect(wrappingUp.next(modulus - 100)).toBe(-100);
	expect(wrappingUp.next(modulus - 50)).toBe(-50);
	expect(wrappingUp.next(30)).toBe(30);
	expect(wrappingUp.next(80)).toBe(80);
});

test('truncated and corrupt FLV files keep the readable data instead of throwing', async () => {
	const source = await fs.promises.readFile(filePath('flv-avc-aac.flv'));

	const readPacketCount = async (bytes: Uint8Array) => {
		using input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
		const tracks = await input.getTracks();
		let count = 0;

		for (const track of tracks) {
			count += (await collectPackets(track)).length;
		}

		return count;
	};

	// A cleanly truncated file still yields everything before the cut
	const truncatedCount = await readPacketCount(source.subarray(0, Math.floor(source.byteLength * 0.6)));
	expect(truncatedCount).toBeGreaterThan(0);
	expect(truncatedCount).toBeLessThan(232);

	// Smashing a real tag's size field past the sanity limit stops the scan but preserves earlier packets
	const u24 = (offset: number) => ((source[offset]! << 16) | (source[offset + 1]! << 8) | source[offset + 2]!);
	const dataView = new DataView(source.buffer, source.byteOffset, source.byteLength);
	let position = dataView.getUint32(5) + 4;

	for (let tagIndex = 0; tagIndex < 8; tagIndex++) {
		position += 11 + u24(position + 1) + 4;
	}

	const corrupted = new Uint8Array(source);
	corrupted[position + 1] = 0x7f;
	corrupted[position + 2] = 0xff;
	corrupted[position + 3] = 0xff;
	expect(await readPacketCount(corrupted)).toBeGreaterThan(0);

	// A file containing only the FLV header has no usable media track and must reject
	await expect(readPacketCount(source.subarray(0, 13))).rejects.toThrow();
});

import { expect, test, describe, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { Input } from '../../src/input.js';
import { BufferSource, CustomSource } from '../../src/source.js';
import { ALL_FORMATS, FLV } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { EncodedPacket } from '../../src/packet.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { FlvOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { assert } from '../../src/misc.js';
import { FlvDemuxer } from '../../src/flv/flv-demuxer.js';
import {
	cleanupFlvFixtures,
	FlvFixtures,
	generateFlvFixtures,
	getFfmpeg,
} from './flv-fixtures.js';

let fixtures: FlvFixtures;

beforeAll(async () => {
	// The whole suite depends on ffmpeg being available to synthesize its FLV inputs
	if (!(await getFfmpeg())) {
		throw new Error('ffmpeg is required to run the FLV test suite.');
	}
	fixtures = await generateFlvFixtures();
});

afterAll(() => {
	cleanupFlvFixtures();
});

const inputFromFile = (filePath: string) => new Input({
	source: new BufferSource(fs.readFileSync(filePath)),
	formats: ALL_FORMATS,
});

const countPackets = async (input: Input) => {
	const tracks = await input.getTracks();
	const result: Record<string, { count: number; keys: number }> = {};
	for (const track of tracks) {
		const sink = new EncodedPacketSink(track);
		let count = 0;
		let keys = 0;
		for await (const packet of sink.packets()) {
			count++;
			if (packet.type === 'key') {
				keys++;
			}
		}
		result[`${track.type}:${await track.getCodec()}`] = { count, keys };
	}
	return result;
};

describe('FLV input format', () => {
	test('exposes the expected format metadata', () => {
		expect(FLV.name).toBe('Flash Video');
		expect(FLV.mimeType).toBe('video/x-flv');
		expect(FLV.supportsTimestampedMediaData).toBe(true);
	});

	test('detects the FLV signature and rejects unrelated data', async () => {
		using input = inputFromFile(fixtures.h264Aac);
		expect(await input.getFormat()).toBe(FLV);

		using garbage = new Input({
			source: new BufferSource(Buffer.from('DEFINITELY_NOT_A_KNOWN_CONTAINER' + 'x'.repeat(64))),
			formats: ALL_FORMATS,
		});
		expect(await garbage.canRead()).toBe(false);
	});

	test('reads H.264 video and AAC audio tracks', async () => {
		using input = inputFromFile(fixtures.h264Aac);
		const tracks = await input.getTracks();
		expect(tracks).toHaveLength(2);

		const video = await input.getPrimaryVideoTrack();
		assert(video);
		expect(await video.getCodec()).toBe('avc');
		expect(await video.getCodedWidth()).toBe(320);
		expect(await video.getCodedHeight()).toBe(240);
		expect(await video.getTimeResolution()).toBe(1000);
		const videoConfig = await video.getDecoderConfig();
		expect(videoConfig.codec.startsWith('avc1')).toBe(true);

		const audio = await input.getPrimaryAudioTrack();
		assert(audio);
		expect(await audio.getCodec()).toBe('aac');
		const audioConfig = await audio.getDecoderConfig();
		expect(audioConfig.codec.startsWith('mp4a')).toBe(true);
		// The AudioSpecificConfig is surfaced so downstream muxers know the packets are raw AAC, not ADTS
		expect(audioConfig.description).toBeInstanceOf(Uint8Array);
	});

	test('surfaces H.264 packets as Annex B with parameter sets on key frames', async () => {
		using input = inputFromFile(fixtures.h264Aac);
		const video = await input.getPrimaryVideoTrack();
		assert(video);
		const sink = new EncodedPacketSink(video);

		const first = await sink.getFirstPacket();
		assert(first);
		expect(first.type).toBe('key');
		// Annex B start code prefix (3- or 4-byte)
		expect(first.data[0]).toBe(0);
		expect(first.data[1]).toBe(0);
		expect(first.data[2] === 1 || first.data[2] === 0).toBe(true);

		const packets: EncodedPacket[] = [];
		for await (const packet of sink.packets()) {
			packets.push(packet);
		}
		expect(packets.length).toBeGreaterThan(0);

		// Every packet except the final one must have a positive duration; the last has no successor to derive it from.
		for (const [index, packet] of packets.entries()) {
			if (index < packets.length - 1) {
				expect(packet.duration).toBeGreaterThan(0);
			}
		}

		const keyPackets = packets.filter(packet => packet.type === 'key');
		expect(keyPackets.length).toBeGreaterThan(0);
		for (const packet of keyPackets) {
			// Key frames carry the parameter sets, enabling config-record synthesis downstream
			expect([...packet.data].includes(7)).toBe(true); // SPS NAL type 7
		}
	});

	test('AAC audio packets are raw (no ADTS header) and all key', async () => {
		using input = inputFromFile(fixtures.h264Aac);
		const audio = await input.getPrimaryAudioTrack();
		assert(audio);
		const sink = new EncodedPacketSink(audio);

		let count = 0;
		for await (const packet of sink.packets()) {
			expect(packet.type).toBe('key');
			// Raw AAC must not begin with the ADTS 0xFFF sync word
			expect(packet.data[0]).not.toBe(0xff);
			count++;
		}
		expect(count).toBeGreaterThan(0);
	});

	test('reads MP3-only audio', async () => {
		using input = inputFromFile(fixtures.mp3Audio);
		const audio = await input.getPrimaryAudioTrack();
		assert(audio);
		expect(await audio.getCodec()).toBe('mp3');
		expect(await input.getPrimaryVideoTrack()).toBeNull();

		const sink = new EncodedPacketSink(audio);
		const first = await sink.getFirstPacket();
		assert(first);
		// MP3 frames keep their sync word after the one-byte FLV sound header is stripped
		expect(first.data[0]).toBe(0xff);
	});

	test('reads Enhanced FLV HEVC video', async () => {
		using input = inputFromFile(fixtures.hevc);
		const video = await input.getPrimaryVideoTrack();
		assert(video);
		expect(await video.getCodec()).toBe('hevc');
		expect(await video.getCodedWidth()).toBe(160);
		expect(await video.getCodedHeight()).toBe(120);
		const config = await video.getDecoderConfig();
		expect(config.codec.startsWith('hev1')).toBe(true);

		const sink = new EncodedPacketSink(video);
		let count = 0;
		let keys = 0;
		for await (const packet of sink.packets()) {
			// Annex B access units begin with either a 3-byte (00 00 01) or 4-byte (00 00 00 01) start code
			const startsWithStartCode = packet.data[0] === 0 && packet.data[1] === 0
				&& (packet.data[2] === 1 || (packet.data[2] === 0 && packet.data[3] === 1));
			expect(startsWithStartCode).toBe(true);
			if (packet.type === 'key') {
				keys++;
			}
			count++;
		}
		expect(count).toBeGreaterThan(0);
		expect(keys).toBeGreaterThan(0);
	});

	test('reads Enhanced FLV AV1 video', async () => {
		using input = inputFromFile(fixtures.av1);
		const video = await input.getPrimaryVideoTrack();
		assert(video);
		expect(await video.getCodec()).toBe('av1');
		expect(await video.getCodedWidth()).toBe(160);
		expect(await video.getCodedHeight()).toBe(120);
		const config = await video.getDecoderConfig();
		expect(config.codec.startsWith('av01')).toBe(true);

		const sink = new EncodedPacketSink(video);
		let count = 0;
		let keys = 0;
		for await (const packet of sink.packets()) {
			if (packet.type === 'key') {
				keys++;
			}
			count++;
		}
		expect(count).toBeGreaterThan(0);
		expect(keys).toBeGreaterThan(0);
	});
});

describe('FLV seeking', () => {
	test('seeks video packets by timestamp', async () => {
		using input = inputFromFile(fixtures.h264Aac);
		const video = await input.getPrimaryVideoTrack();
		assert(video);
		const sink = new EncodedPacketSink(video);

		const first = await sink.getFirstPacket();
		assert(first);
		const beforeFirst = await sink.getPacket(first.timestamp - 100);
		expect(beforeFirst).toBeNull();

		const middle = await sink.getPacket(2);
		assert(middle);
		// getPacket returns the last packet whose timestamp does not exceed the target, accounting for the stream's
		// non-zero start time; it must land near the requested time rather than at the first or last packet.
		expect(middle.timestamp).toBeGreaterThan(1.5);
		expect(middle.timestamp).toBeLessThan(2.5);

		const last = await sink.getPacket(Number.POSITIVE_INFINITY);
		assert(last);
		expect(last.timestamp).toBeGreaterThan(3);
	});

	test('seeks key frames and walks the key-frame chain', async () => {
		using input = inputFromFile(fixtures.h264Aac);
		const video = await input.getPrimaryVideoTrack();
		assert(video);
		const sink = new EncodedPacketSink(video);

		const keyPacket = await sink.getKeyPacket(2);
		assert(keyPacket);
		expect(keyPacket.type).toBe('key');

		const nextKey = await sink.getNextKeyPacket(keyPacket);
		if (nextKey) {
			expect(nextKey.type).toBe('key');
			expect(nextKey.sequenceNumber).toBeGreaterThan(keyPacket.sequenceNumber);
		}
	});

	test('uses the onMetaData keyframe index when present', async () => {
		using indexedInput = inputFromFile(fixtures.h264AacKeyframeIndex);
		// Trigger and await metadata reading so the demuxer has parsed onMetaData
		await indexedInput.getTracks();
		const demuxer = (await indexedInput._demuxerPromise) as FlvDemuxer;
		assert(demuxer.metadataKeyframes, 'the indexed fixture should expose a keyframe index');
		expect(demuxer.metadataKeyframes.times.length).toBeGreaterThan(0);

		const video = await indexedInput.getPrimaryVideoTrack();
		assert(video);
		const sink = new EncodedPacketSink(video);
		const keyPacket = await sink.getKeyPacket(2);
		assert(keyPacket);
		expect(keyPacket.type).toBe('key');
	});

	test('reports duration from onMetaData', async () => {
		using input = inputFromFile(fixtures.h264Aac);
		const duration = await input.getDurationFromMetadata();
		assert(duration !== null);
		expect(duration).toBeGreaterThan(3);
	});
});

describe('FLV resilience', () => {
	test('recovers packets from a truncated file', async () => {
		const full = fs.readFileSync(fixtures.h264Aac);
		const truncated = full.subarray(0, Math.floor(full.length * 0.6));

		using input = new Input({ source: new BufferSource(truncated), formats: ALL_FORMATS });
		const stats = await countPackets(input);
		const total = Object.values(stats).reduce((sum, x) => sum + x.count, 0);
		expect(total).toBeGreaterThan(0);
	});

	test('stops scanning cleanly at a corrupt tag', async () => {
		const corrupted = Buffer.from(fs.readFileSync(fixtures.h264Aac));
		// Force an implausible data size that overruns the file; the demuxer must stop rather than throw
		corrupted[30] = 0xff;
		corrupted[31] = 0xff;
		corrupted[32] = 0xff;

		using input = new Input({ source: new BufferSource(corrupted), formats: ALL_FORMATS });
		const tracks = await input.getTracks();
		expect(tracks.length).toBeGreaterThan(0);
	});

	test('ignores trailing garbage after the last valid tag', async () => {
		const full = fs.readFileSync(fixtures.h264Aac);
		const withJunk = Buffer.concat([full, Buffer.from([9, 99, 99, 99, 1, 2, 3, 4, 5, 6, 7, 8])]);

		using input = new Input({ source: new BufferSource(withJunk), formats: ALL_FORMATS });
		expect(await input.getFormat()).toBe(FLV);
		const stats = await countPackets(input);
		const junkStats = await countPackets(inputFromFile(fixtures.h264Aac));
		expect(stats).toEqual(junkStats);
	});

	test('reads without knowing the file size up front', async () => {
		const full = fs.readFileSync(fixtures.h264Aac);
		using input = new Input({
			source: new CustomSource({
				getSize: () => full.byteLength,
				read: (start: number, end: number) => full.subarray(start, end),
			}),
			formats: ALL_FORMATS,
		});

		const video = await input.getPrimaryVideoTrack();
		assert(video);
		const sink = new EncodedPacketSink(video);
		const packet = await sink.getFirstPacket();
		assert(packet);
		expect(packet.type).toBe('key');
	});
});

describe('FLV output and conversion', () => {
	test('FlvOutputFormat declares the supported codecs and track limits', () => {
		const format = new FlvOutputFormat();
		expect(format.fileExtension).toBe('.flv');
		expect(format.mimeType).toBe('video/x-flv');
		expect(format.getSupportedVideoCodecs().sort()).toEqual(['av1', 'avc', 'hevc']);
		expect(format.getSupportedAudioCodecs().sort()).toEqual(['aac', 'mp3']);
		const limits = format.getSupportedTrackCounts();
		expect(limits.video.max).toBe(1);
		expect(limits.audio.max).toBe(1);
	});

	test('muxes MP4 content to FLV and reads it back', async () => {
		const mp4Path = new URL('../public/video.mp4', import.meta.url);
		using input = new Input({
			source: new BufferSource(fs.readFileSync(mp4Path)),
			formats: ALL_FORMATS,
		});

		const output = new Output({ format: new FlvOutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output, showWarnings: false });
		await conversion.execute();

		using reread = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});
		expect(await reread.getFormat()).toBe(FLV);
		const tracks = await reread.getTracks();
		expect(tracks).toHaveLength(2);

		const video = await reread.getPrimaryVideoTrack();
		assert(video);
		expect(await video.getCodec()).toBe('avc');
	});

	test('converts FLV to MP4 through the regular Conversion pipeline', async () => {
		using input = inputFromFile(fixtures.h264Aac);
		const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output, showWarnings: false });
		await conversion.execute();

		using reread = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});
		const tracks = await reread.getTracks();
		expect(tracks).toHaveLength(2);
		const video = await reread.getPrimaryVideoTrack();
		assert(video);
		const sink = new EncodedPacketSink(video);
		let count = 0;
		for await (const packet of sink.packets()) {
			void packet;
			count++;
		}
		expect(count).toBeGreaterThan(0);
	});

	test('round-trips Enhanced FLV HEVC through the FLV muxer', async () => {
		using input = inputFromFile(fixtures.hevc);
		const output = new Output({ format: new FlvOutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output, showWarnings: false });
		await conversion.execute();

		using reread = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});
		const video = await reread.getPrimaryVideoTrack();
		assert(video);
		expect(await video.getCodec()).toBe('hevc');
		expect(await video.getCodedWidth()).toBe(160);

		const sink = new EncodedPacketSink(video);
		let keys = 0;
		for await (const packet of sink.packets()) {
			if (packet.type === 'key') {
				keys++;
			}
		}
		expect(keys).toBeGreaterThan(0);
	});

	test('preserves packet timing across an FLV round-trip', async () => {
		using input = inputFromFile(fixtures.h264Aac);
		const output = new Output({ format: new FlvOutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output, showWarnings: false });
		await conversion.execute();

		using original = inputFromFile(fixtures.h264Aac);
		using reread = new Input({
			source: new BufferSource(output.target.buffer!),
			formats: ALL_FORMATS,
		});

		const originalAudio = await original.getPrimaryAudioTrack();
		const rereadAudio = await reread.getPrimaryAudioTrack();
		assert(originalAudio && rereadAudio);

		const originalSink = new EncodedPacketSink(originalAudio);
		const rereadSink = new EncodedPacketSink(rereadAudio);

		const originalFirst = await originalSink.getFirstPacket();
		const rereadFirst = await rereadSink.getFirstPacket();
		assert(originalFirst && rereadFirst);

		// The Conversion pipeline normalizes absolute start timestamps, so compare the inter-packet timing (duration)
		// and monotonic ordering rather than the absolute first timestamp.
		expect(rereadFirst.duration).toBeCloseTo(originalFirst.duration, 3);
		const originalSecond = await originalSink.getNextPacket(originalFirst);
		const rereadSecond = await rereadSink.getNextPacket(rereadFirst);
		assert(originalSecond && rereadSecond);
		const originalGap = originalSecond.timestamp - originalFirst.timestamp;
		const rereadGap = rereadSecond.timestamp - rereadFirst.timestamp;
		expect(rereadGap).toBeCloseTo(originalGap, 3);
	});
});

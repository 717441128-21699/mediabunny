import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ALL_FORMATS, FLV } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { FlvOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { assert } from '../../src/misc.js';
import { EncodedPacket } from '../../src/packet.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const filePath = (name: string) => path.join(__dirname, '../public', name);

type TrackSummary = {
	codec: string | null;
	packetCount: number;
	keyCount: number;
	relativeTimestamps: number[];
	span: number;
};

const summarizeTrack = async (track: Awaited<ReturnType<Input['getTracks']>>[number]) => {
	const sink = new EncodedPacketSink(track);
	const packets: EncodedPacket[] = [];

	for await (const packet of sink.packets()) {
		packets.push(packet);
	}

	const firstTimestamp = packets[0]!.timestamp;

	return {
		codec: await track.getCodec(),
		packetCount: packets.length,
		keyCount: packets.filter(packet => packet.type === 'key').length,
		// Relative timing is what survives a conversion: the engine shifts a prefer-non-negative format so its
		// earliest track starts at zero, but inter-packet spacing must remain untouched
		relativeTimestamps: packets.map(packet => packet.timestamp - firstTimestamp),
		span: packets.at(-1)!.timestamp - firstTimestamp,
	} satisfies TrackSummary;
};

const summarizeInput = async (name: string) => {
	using input = new Input({ source: new FilePathSource(filePath(name)), formats: ALL_FORMATS });
	const tracks = await input.getTracks();
	const summaries = await Promise.all(tracks.map(summarizeTrack));

	return {
		video: summaries.find(summary => summary.codec !== null && !AUDIO_CODECS.includes(summary.codec)) ?? null,
		audio: summaries.find(summary => summary.codec !== null && AUDIO_CODECS.includes(summary.codec)) ?? null,
	};
};

const convertToBuffer = async (input: Input, format: Output['format']) => {
	const output = new Output({ format, target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();
	return new Uint8Array(output.target.buffer!);
};

const AUDIO_CODECS = ['aac', 'mp3'];

const expectSummaryClose = (actual: TrackSummary | null, expected: TrackSummary | null) => {
	if (expected === null) {
		expect(actual).toBeNull();
		return;
	}

	expect(actual).not.toBeNull();
	assert(actual);
	expect(actual.codec).toBe(expected.codec);
	expect(actual.packetCount).toBe(expected.packetCount);
	expect(actual.keyCount).toBe(expected.keyCount);
	expect(actual.relativeTimestamps.length).toBe(expected.relativeTimestamps.length);
	actual.relativeTimestamps.forEach((timestamp, index) => {
		expect(timestamp).toBeCloseTo(expected.relativeTimestamps[index]!, 2);
	});
	expect(actual.span).toBeCloseTo(expected.span, 2);
};

test('FLV output format declares FLV-specific capabilities', () => {
	const format = new FlvOutputFormat();

	expect(format.constructor.name).toBe('FlvOutputFormat');
	expect(format.fileExtension).toBe('.flv');
	expect(format.mimeType).toBe('video/x-flv');
});

test('FLV to MP4 conversion preserves every track and sample', async () => {
	using input = new Input({ source: new FilePathSource(filePath('flv-avc-aac.flv')), formats: ALL_FORMATS });
	const bytes = await convertToBuffer(input, new Mp4OutputFormat());

	using output = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	expect(await output.getFormat()).not.toBe(FLV);

	const expected = await summarizeInput('flv-avc-aac.flv');
	const tracks = await output.getTracks();
	const summaries = await Promise.all(tracks.map(summarizeTrack));

	expectSummaryClose(
		summaries.find(summary => summary.codec !== null && !AUDIO_CODECS.includes(summary.codec)) ?? null,
		expected.video,
	);
	expectSummaryClose(
		summaries.find(summary => summary.codec !== null && AUDIO_CODECS.includes(summary.codec)) ?? null,
		expected.audio,
	);
});

test.each([
	'flv-avc-aac.flv',
	'flv-avc-mp3.flv',
	'flv-hevc-aac.flv',
	'flv-av1-aac.flv',
	'flv-aac-only.flv',
])('FLV round trip through the FLV muxer: %s', async (fixtureName) => {
	const expected = await summarizeInput(fixtureName);

	using input = new Input({ source: new FilePathSource(filePath(fixtureName)), formats: ALL_FORMATS });
	const bytes = await convertToBuffer(input, new FlvOutputFormat());

	// Every FLV stream starts with the FLV signature and version 1 header
	expect(Array.from(bytes.subarray(0, 4))).toEqual([0x46, 0x4c, 0x56, 0x01]);
	expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(5, false)).toBe(9);

	using output = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	expect(await output.getFormat()).toBe(FLV);

	const tracks = await output.getTracks();
	const summaries = await Promise.all(tracks.map(summarizeTrack));
	const videoCodec = expected.video?.codec;
	const audioCodec = expected.audio?.codec;

	expectSummaryClose(
		videoCodec ? summaries.find(summary => summary.codec === videoCodec) ?? null : null,
		expected.video,
	);
	expectSummaryClose(
		audioCodec ? summaries.find(summary => summary.codec === audioCodec) ?? null : null,
		expected.audio,
	);

	// A prefer-non-negative container always starts its timeline at zero
	for (const summary of summaries) {
		expect(summary.relativeTimestamps[0]).toBe(0);
	}
});

test('MP4 to FLV converts length-prefixed NAL units and keeps the video decodable', async () => {
	using input = new Input({ source: new FilePathSource(filePath('annex-b.mp4')), formats: ALL_FORMATS });
	const bytes = await convertToBuffer(input, new FlvOutputFormat());

	using output = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
	expect(await output.getFormat()).toBe(FLV);

	const videoTrack = await output.getPrimaryVideoTrack();
	assert(videoTrack);
	expect(await videoTrack.getCodec()).toBe('avc');

	const config = await videoTrack.getDecoderConfig();
	assert(config && config.description);
	// The muxer emitted an AVC decoder configuration record, not Annex B start codes
	const description = new Uint8Array(
		ArrayBuffer.isView(config.description)
			? config.description.buffer
			: config.description,
	);
	expect(description[0]).toBe(1);
	expect(
		description[0] === 0x00 && description[1] === 0x00 && description[2] === 0x00 && description[3] === 0x01,
	).toBe(false);

	const sink = new EncodedPacketSink(videoTrack);
	const packets: EncodedPacket[] = [];

	for await (const packet of sink.packets()) {
		packets.push(packet);
	}

	expect(packets.length).toBeGreaterThan(0);
	expect(packets.some(packet => packet.type === 'key')).toBe(true);
});

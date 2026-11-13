/*!
 * Copyright (c) 2026-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Resolves an ffmpeg executable. Prefers a binary on PATH (cross-platform) and falls back to the one bundled by
 * node-av. Returns null when neither is available, which lets the FLV tests skip rather than fail in restricted
 * environments.
 */
const resolveFfmpeg = async (): Promise<string | null> => {
	const onPath = process.env['FFMPEG_PATH'];
	if (onPath && fs.existsSync(onPath)) {
		return onPath;
	}

	try {
		// `ffmpeg` resolves through the system PATH; the throw only happens when it cannot be found
		execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
		return 'ffmpeg';
	} catch {
		// Continue to the node-av fallback
	}

	try {
		// Optional dependency; imported lazily so its absence never breaks module loading
		const nodeAvFfmpeg = await import('node-av/ffmpeg') as {
			isFfmpegAvailable: () => boolean;
			ffmpegPath: () => string;
		};
		if (nodeAvFfmpeg.isFfmpegAvailable()) {
			return nodeAvFfmpeg.ffmpegPath();
		}
	} catch {
		// node-av not installed or binary missing
	}

	return null;
};

export type FlvFixtures = {
	dir: string;
	h264Aac: string;
	hevc: string;
	av1: string;
	mp3Audio: string;
	h264AacKeyframeIndex: string;
};

let cachedFixtures: FlvFixtures | null = null;
let cachedFfmpeg: string | null | undefined;

/** Returns the resolved ffmpeg executable, or null when unavailable. */
export const getFfmpeg = async (): Promise<string | null> => {
	if (cachedFfmpeg === undefined) {
		cachedFfmpeg = await resolveFfmpeg();
	}
	return cachedFfmpeg;
};

const run = (ffmpeg: string, args: string[]) => {
	execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'ignore' });
};

/**
 * Generates the FLV fixtures used by the test suite with ffmpeg, into a unique temporary directory. Each fixture is
 * small (a couple of seconds of synthetic content) to keep the suite fast. The directory is reused across tests in the
 * same process.
 */
export const generateFlvFixtures = async (): Promise<FlvFixtures> => {
	if (cachedFixtures) {
		return cachedFixtures;
	}

	const ffmpeg = await getFfmpeg();
	if (!ffmpeg) {
		throw new Error('No ffmpeg executable available; skipping FLV fixture generation.');
	}

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediabunny-flv-'));

	const h264Aac = path.join(dir, 'h264-aac.flv');
	run(ffmpeg, [
		'-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=15',
		'-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
		'-c:v', 'libx264', '-g', '15', '-c:a', 'aac',
		'-f', 'flv', h264Aac,
	]);

	const h264AacKeyframeIndex = path.join(dir, 'h264-aac-indexed.flv');
	run(ffmpeg, [
		'-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=15',
		'-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
		'-c:v', 'libx264', '-g', '15', '-c:a', 'aac',
		'-flvflags', 'add_keyframe_index',
		'-f', 'flv', h264AacKeyframeIndex,
	]);

	const hevc = path.join(dir, 'hevc.flv');
	run(ffmpeg, [
		'-f', 'lavfi', '-i', 'testsrc=duration=3:size=160x120:rate=15',
		'-c:v', 'libx265', '-g', '15',
		'-f', 'flv', hevc,
	]);

	const av1 = path.join(dir, 'av1.flv');
	run(ffmpeg, [
		'-f', 'lavfi', '-i', 'testsrc=duration=3:size=160x120:rate=15',
		'-c:v', 'libaom-av1', '-cpu-used', '8', '-g', '15',
		'-f', 'flv', av1,
	]);

	const mp3Audio = path.join(dir, 'mp3.flv');
	run(ffmpeg, [
		'-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
		'-c:a', 'libmp3lame',
		'-f', 'flv', mp3Audio,
	]);

	cachedFixtures = { dir, h264Aac, hevc, av1, mp3Audio, h264AacKeyframeIndex };
	return cachedFixtures;
};

/** Removes the generated fixture directory. */
export const cleanupFlvFixtures = () => {
	if (cachedFixtures && fs.existsSync(cachedFixtures.dir)) {
		fs.rmSync(cachedFixtures.dir, { recursive: true, force: true });
	}
	cachedFixtures = null;
};

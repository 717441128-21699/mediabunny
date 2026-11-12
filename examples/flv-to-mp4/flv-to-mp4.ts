import {
	ALL_FORMATS,
	BlobSource,
	BufferTarget,
	Conversion,
	FLV,
	Input,
	Mp4OutputFormat,
	Output,
	UrlSource,
} from 'mediabunny';

const selectFileButton = document.querySelector('#select-file') as HTMLButtonElement;
const loadUrlButton = document.querySelector('#load-url') as HTMLButtonElement;
const fileNameElement = document.querySelector('#file-name') as HTMLParagraphElement;
const horizontalRule = document.querySelector('hr') as HTMLHRElement;
const trackInfoElement = document.querySelector('#track-info') as HTMLDivElement;
const errorElement = document.querySelector('#error-element') as HTMLParagraphElement;
const progressBarContainer = document.querySelector('#progress-bar-container') as HTMLDivElement;
const progressBar = document.querySelector('#progress-bar') as HTMLDivElement;
const speedometer = document.querySelector('#speedometer') as HTMLParagraphElement;
const convertButton = document.querySelector('#convert-button') as HTMLButtonElement;
const cancelButton = document.querySelector('#cancel-button') as HTMLButtonElement;
const videoElement = document.querySelector('video') as HTMLVideoElement;
const downloadLink = document.querySelector('#download-link') as HTMLAnchorElement;
const resultFacts = document.querySelector('#result-facts') as HTMLParagraphElement;

let currentInput: Input | null = null;
let currentConversion: Conversion | null = null;
let currentIntervalId = -1;
let currentFileSize: number | null = null;

const resetResultUi = () => {
	clearInterval(currentIntervalId);
	progressBarContainer.style.display = 'none';
	speedometer.style.display = 'none';
	speedometer.textContent = '';
	progressBar.style.width = '0';
	convertButton.style.display = 'none';
	cancelButton.style.display = 'none';
	videoElement.style.display = 'none';
	videoElement.src = '';
	downloadLink.style.display = 'none';
	downloadLink.href = '';
	resultFacts.style.display = 'none';
	resultFacts.textContent = '';
	errorElement.textContent = '';
};

const makeTrackCard = (title: string, rows: ReadonlyArray<readonly [string, string]>) => {
	const card = document.createElement('div');
	card.className = 'rounded-lg bg-zinc-100 dark:bg-zinc-800 p-4 flex flex-col gap-2';

	const heading = document.createElement('h2');
	heading.className = 'text-lg font-semibold text-teal-500';
	heading.textContent = title;
	card.append(heading);

	for (const [label, value] of rows) {
		const row = document.createElement('div');
		row.className = 'flex justify-between gap-4 text-sm';

		const labelElement = document.createElement('span');
		labelElement.className = 'opacity-60';
		labelElement.textContent = label;

		const valueElement = document.createElement('span');
		valueElement.className = 'font-medium text-right';
		valueElement.textContent = value;

		row.append(labelElement, valueElement);
		card.append(row);
	}

	return card;
};

const inspectFile = async (resource: File | string) => {
	resetResultUi();
	await currentConversion?.cancel();
	currentInput?.dispose();

	fileNameElement.textContent = resource instanceof File ? resource.name : resource;
	horizontalRule.style.display = '';
	trackInfoElement.style.display = 'none';
	trackInfoElement.replaceChildren();

	const source = resource instanceof File
		? new BlobSource(resource)
		: new UrlSource(resource);
	const input = new Input({ source, formats: ALL_FORMATS });
	currentInput = input;
	currentFileSize = await source.getSize();

	try {
		const format = await input.getFormat();
		if (format !== FLV) {
			throw new Error(`This example only handles FLV files, but the detected format was "${format.name}".`);
		}

		const tracks = await input.getTracks();
		const cards = await Promise.all(tracks.map(async (track) => {
			const codec = await track.getCodec();
			const duration = await track.computeDuration();
			const packetStats = await track.computePacketStats();
			const rows: Array<readonly [string, string]> = [
				['Codec', codec ?? 'Unknown'],
				['Duration', `${duration.toFixed(3)} s`],
				['Packet count', String(packetStats.packetCount)],
			];

			if (track.isVideoTrack()) {
				const width = await track.getCodedWidth();
				const height = await track.getCodedHeight();
				rows.push(['Resolution', `${width} × ${height}`]);
			} else if (track.isAudioTrack()) {
				const channels = await track.getNumberOfChannels();
				const sampleRate = await track.getSampleRate();
				rows.push(['Channels', String(channels)]);
				rows.push(['Sample rate', `${sampleRate} Hz`]);
			}

			return makeTrackCard(
				track.isVideoTrack() ? 'Video track' : track.isAudioTrack() ? 'Audio track' : 'Track',
				rows,
			);
		}));

		trackInfoElement.append(...cards);
		trackInfoElement.style.display = '';
		convertButton.style.display = '';
	} catch (error) {
		console.error(error);
		errorElement.textContent = String(error);
		input.dispose();
		currentInput = null;
	}
};

const convertToMp4 = async () => {
	if (!currentInput) {
		return;
	}

	resetResultUi();
	const input = currentInput;

	const output = new Output({
		target: new BufferTarget(),
		format: new Mp4OutputFormat(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: true });
	if (!conversion.isValid) {
		console.info(conversion.discardedTracks);
		throw new Error('Conversion is invalid and cannot be executed; see the console for more.');
	}

	currentConversion = conversion;
	cancelButton.style.display = '';
	convertButton.disabled = true;
	progressBarContainer.style.display = '';
	speedometer.style.display = '';
	speedometer.textContent = 'Speed: -';

	let progress = 0;
	let processedTime = 0;
	let startTime: number | null = null;

	conversion.onProgress = (newProgress, newProcessedTime) => {
		progress = newProgress;
		processedTime = newProcessedTime;
		startTime ??= performance.now();
	};

	const updateProgress = () => {
		progressBar.style.width = `${progress * 100}%`;

		if (startTime !== null) {
			const elapsedSeconds = (performance.now() - startTime) / 1000;
			const factor = elapsedSeconds === 0 ? 0 : processedTime / elapsedSeconds;
			speedometer.textContent = `Speed: ~${factor.toPrecision(3)}x real time`;
		}
	};

	currentIntervalId = window.setInterval(updateProgress, 1000 / 60);

	try {
		await conversion.execute();
		clearInterval(currentIntervalId);
		updateProgress();

		const buffer = output.target.buffer!;
		const blob = new Blob([buffer], { type: output.format.mimeType });
		const objectUrl = URL.createObjectURL(blob);

		videoElement.style.display = '';
		videoElement.src = objectUrl;

		downloadLink.style.display = '';
		downloadLink.href = objectUrl;
		downloadLink.download = 'converted.mp4';

		resultFacts.style.display = '';
		const originalSize = currentFileSize ?? 0;
		const ratio = originalSize === 0 ? 0 : 100 * buffer.byteLength / originalSize;
		resultFacts.textContent = `Output: ${buffer.byteLength} bytes (${ratio.toPrecision(3)}% of input size)`;
	} catch (error) {
		console.error(error);
		errorElement.textContent = String(error);
		clearInterval(currentIntervalId);
		progressBarContainer.style.display = 'none';
		speedometer.style.display = 'none';
	} finally {
		cancelButton.style.display = 'none';
		convertButton.disabled = false;
		currentConversion = null;
	}
};

selectFileButton.addEventListener('click', () => {
	const fileInput = document.createElement('input');
	fileInput.type = 'file';
	fileInput.accept = 'video/x-flv,.flv';
	fileInput.addEventListener('change', () => {
		const file = fileInput.files?.[0];
		if (!file) {
			return;
		}

		void inspectFile(file);
	});

	fileInput.click();
});

loadUrlButton.addEventListener('click', () => {
	const url = prompt(
		'Please enter the URL of an FLV media file. It must be HTTPS and send cross-origin (CORS) headers.',
	);
	if (!url) {
		return;
	}

	void inspectFile(url);
});

convertButton.addEventListener('click', () => {
	void convertToMp4();
});

cancelButton.addEventListener('click', () => {
	void currentConversion?.cancel();
});

document.addEventListener('dragover', (event) => {
	event.preventDefault();
	event.dataTransfer!.dropEffect = 'copy';
});

document.addEventListener('drop', (event) => {
	event.preventDefault();
	const file = event.dataTransfer?.files?.[0];
	if (file) {
		void inspectFile(file);
	}
});

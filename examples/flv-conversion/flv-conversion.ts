import {
	ALL_FORMATS,
	BlobSource,
	BufferTarget,
	Conversion,
	FLV,
	Input,
	InputTrack,
	Mp4OutputFormat,
	Output,
} from 'mediabunny';

const selectFileButton = document.querySelector('#select-file') as HTMLButtonElement;
const fileNameElement = document.querySelector('#file-name') as HTMLParagraphElement;
const horizontalRule = document.querySelector('hr') as HTMLHRElement;
const statusElement = document.querySelector('#status') as HTMLParagraphElement;
const trackContainer = document.querySelector('#track-container') as HTMLDivElement;
const convertControls = document.querySelector('#convert-controls') as HTMLDivElement;
const convertButton = document.querySelector('#convert-to-mp4') as HTMLButtonElement;
const downloadLink = document.querySelector('#download-link') as HTMLAnchorElement;

let currentInput: Input | null = null;

const setStatus = (message: string) => {
	statusElement.textContent = message;
};

const renderTrack = async (track: InputTrack) => {
	const list = document.createElement('ul');

	const addRow = (label: string, value: string | number | Promise<unknown>) => {
		const item = document.createElement('li');
		const key = document.createElement('b');
		key.textContent = `${label}: `;
		item.appendChild(key);

		if (value instanceof Promise) {
			const span = document.createElement('span');
			span.textContent = 'Loading...';
			item.appendChild(span);
			value.then((resolved) => {
				span.textContent = String(resolved);
			}).catch((error: unknown) => {
				span.textContent = `Error: ${String(error)}`;
			});
		} else {
			const span = document.createElement('span');
			span.textContent = String(value);
			item.appendChild(span);
		}

		list.appendChild(item);
	};

	addRow('Type', track.type);
	addRow('Codec', track.getCodec());
	addRow('Codec string', track.getCodecParameterString());
	addRow('Starts at (s)', track.getFirstTimestamp().then((t: number) => t.toFixed(3)));
	addRow('Duration (s)', track.computeDuration().then((t: number) => t.toFixed(3)));

	if (track.isVideoTrack()) {
		addRow('Coded width', track.getCodedWidth());
		addRow('Coded height', track.getCodedHeight());
		addRow('Display width', track.getDisplayWidth());
		addRow('Display height', track.getDisplayHeight());
	} else if (track.isAudioTrack()) {
		addRow('Channels', track.getNumberOfChannels());
		addRow('Sample rate (Hz)', track.getSampleRate());
	}

	addRow(
		'Packet count',
		track.computePacketStats().then((stats: { packetCount: number }) => String(stats.packetCount)),
	);

	return list;
};

const inspectFile = async (file: File) => {
	downloadLink.style.display = 'none';
	convertControls.style.display = 'none';
	trackContainer.innerHTML = '';
	fileNameElement.textContent = file.name;
	horizontalRule.style.display = '';

	currentInput?.[Symbol.dispose]();
	const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
	currentInput = input;

	try {
		const format = await input.getFormat();
		if (format !== FLV) {
			setStatus(
				`This file was detected as "${format.name}", not FLV. The example still works, but pick an FLV`
				+ ' for the full experience.',
			);
		} else {
			setStatus('Detected FLV. Reading track information...');
		}

		const tracks = await input.getTracks();
		setStatus(`FLV parsed — ${tracks.length} track(s).`);

		for (const track of tracks) {
			const heading = document.createElement('h2');
			heading.className = 'text-lg font-semibold mt-4 mb-2';
			heading.textContent = track.isVideoTrack() ? 'Video track' : 'Audio track';
			trackContainer.appendChild(heading);
			trackContainer.appendChild(await renderTrack(track));
		}

		convertControls.style.display = '';
	} catch (error) {
		setStatus(`Failed to read the file: ${String(error)}`);
	}
};

const convertToMp4 = async () => {
	if (!currentInput) {
		return;
	}

	convertButton.disabled = true;
	setStatus('Converting FLV to MP4...');

	try {
		const output = new Output({
			format: new Mp4OutputFormat(),
			target: new BufferTarget(),
		});

		const conversion = await Conversion.init({
			input: currentInput,
			output,
			showWarnings: false,
		});
		await conversion.execute();

		const blob = new Blob([output.target.buffer!], { type: 'video/mp4' });
		const url = URL.createObjectURL(blob);
		downloadLink.href = url;
		downloadLink.style.display = '';
		setStatus('Conversion complete. Use the link below to download the MP4.');
	} catch (error) {
		setStatus(`Conversion failed: ${String(error)}`);
	} finally {
		convertButton.disabled = false;
	}
};

selectFileButton.addEventListener('click', () => {
	const fileInput = document.createElement('input');
	fileInput.type = 'file';
	fileInput.accept = 'video/x-flv,.flv';
	fileInput.addEventListener('change', () => {
		const file = fileInput.files?.[0];
		if (file) {
			void inspectFile(file);
		}
	});
	fileInput.click();
});

convertButton.addEventListener('click', () => {
	void convertToMp4();
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

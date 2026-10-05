import { openProjectDatabase } from './js/database.js';
import { getSafeExportName, getSupportedMimeType, getVideoBitrate, loadImage } from './js/media.js';

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const clearButton = document.getElementById('clear-button');
const undoClearButton = document.getElementById('undo-clear-button');
const previewGallery = document.getElementById('preview-gallery');
const galleryEmpty = document.getElementById('gallery-empty');
const galleryCount = document.getElementById('gallery-count');
const selectedEditor = document.getElementById('selected-editor');
const selectedImage = document.getElementById('selected-image');
const alignmentControlsContainer = document.getElementById('alignment-controls');
const editorEmpty = document.getElementById('editor-empty');
const uploadProgress = document.getElementById('upload-progress');
const autoAlignStatus = document.getElementById('auto-align-status');
const autoAlignProgress = document.getElementById('auto-align-progress');
const cancelAutoAlignButton = document.getElementById('cancel-auto-align');
const autoAlignAllButton = document.getElementById('auto-align-all-button');
const generateButton = document.getElementById('generate-button');
const exportButton = document.getElementById('export-button');
const generationStatus = document.getElementById('generation-status');
const previewEmpty = document.getElementById('preview-empty');
const exportProgress = document.getElementById('export-progress');
const timelapseCanvas = document.getElementById('timelapse-canvas');
const secondsPerFrameInput = document.getElementById('seconds-per-frame');
const totalDuration = document.getElementById('total-duration');
const cropToFillInput = document.getElementById('crop-to-fill');
const normalizeLightingInput = document.getElementById('normalize-lighting');
const smoothLightingInput = document.getElementById('smooth-lighting');
const aspectPreset = document.getElementById('aspect-preset');
const videoWidthInput = document.getElementById('video-width');
const videoHeightInput = document.getElementById('video-height');
const projectNameInput = document.getElementById('project-name');
const notification = document.getElementById('notification');
const canvasContext = timelapseCanvas.getContext('2d');
const photos = [];
const previewUrls = [];
const maxFileSize = 20 * 1024 * 1024;
let animationTimer;
let selectedPhoto = null;
let selectedImageUrl;
let previewImages = [];
let previewFrameIndex = 0;
let previewPlaying = false;
let faceDetectorPromise;
let lastClearedPhotos = null;
let cropToFill = false;
let outputDimensionsCustomized = false;
let autoAlignCancelled = false;
let normalizeLighting = false;
let smoothLighting = false;
let projectName = 'Untitled Timelapse';
const databaseReady = openProjectDatabase();

databaseReady.then(loadProject).catch(() => {
	generationStatus.textContent = 'Local project storage is unavailable.';
});

dropZone.addEventListener('click', () => {
	fileInput.click();
});

fileInput.addEventListener('change', () => {
	startUploadProgress();
	handleFiles(fileInput.files);
	fileInput.value = '';
});

dropZone.addEventListener('dragover', (event) => {
	event.preventDefault();
	dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
	dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', async (event) => {
	event.preventDefault();
	dropZone.classList.remove('dragover');
	startUploadProgress(true);
	const files = await getDroppedFiles(event.dataTransfer);
	handleFiles(files);
});

function startUploadProgress(indeterminate = false) {
	uploadProgress.hidden = false;
	if (indeterminate) {
		uploadProgress.removeAttribute('value');
	} else {
		uploadProgress.value = 0;
	}
}

async function getDroppedFiles(dataTransfer) {
	const entries = Array.from(dataTransfer.items || [])
		.map((item) => item.webkitGetAsEntry?.())
		.filter(Boolean);
	if (entries.length === 0) {
		return Array.from(dataTransfer.files || []);
	}

	const files = [];
	await Promise.all(entries.map((entry) => collectEntryFiles(entry, files)));
	return files;
}

function collectEntryFiles(entry, files) {
	if (entry.isFile) {
		return new Promise((resolve) => {
			entry.file((file) => {
				files.push(file);
				resolve();
			}, resolve);
		});
	}

	if (!entry.isDirectory) {
		return Promise.resolve();
	}

	return new Promise((resolve) => {
		const reader = entry.createReader();
		const readEntries = () => {
			reader.readEntries(async (entries) => {
				if (entries.length === 0) {
					resolve();
					return;
				}
				await Promise.all(entries.map((childEntry) => collectEntryFiles(childEntry, files)));
				readEntries();
			}, resolve);
		};
		readEntries();
	});
}

async function handleFiles(files) {
	const selectedFiles = Array.from(files);
	if (selectedFiles.length === 0) {
		uploadProgress.hidden = true;
		return;
	}
	const candidateFiles = selectedFiles.filter((file) => (
		isSupportedImageFile(file) && file.size <= maxFileSize
	));
	const conversionResults = [];
	for (let index = 0; index < candidateFiles.length; index += 1) {
		try {
			conversionResults.push({ status: 'fulfilled', value: await convertToBrowserImage(candidateFiles[index]) });
		} catch (error) {
			conversionResults.push({ status: 'rejected', reason: error });
		}
		uploadProgress.value = ((index + 1) / Math.max(candidateFiles.length, 1)) * 100;
	}
	const validFiles = conversionResults
		.filter((result) => result.status === 'fulfilled')
		.map((result) => result.value);
	const rejectedFileCount = selectedFiles.length - validFiles.length;

	if (rejectedFileCount > 0) {
		generationStatus.textContent = `${rejectedFileCount} file(s) skipped. Use PNG/JPEG/HEIC images under 20 MB.`;
	}

	photos.push(...validFiles.map((file) => ({
		file,
		x: 50,
		y: 50,
		zoom: 1
	})));
	updateActionState();
	renderPreviews();
	if (selectedPhoto) {
		renderSelectedEditor();
	}
	saveProject();
	adaptOutputDimensions();
	uploadProgress.value = 100;
}

function isSupportedImageFile(file) {
	const extension = file.name.toLowerCase().split('.').pop();
	return file.type === 'image/jpeg' || file.type === 'image/png' ||
		file.type === 'image/heic' || file.type === 'image/heif' ||
		extension === 'heic' || extension === 'heif';
}

async function convertToBrowserImage(file) {
	const extension = file.name.toLowerCase().split('.').pop();
	const isHeic = file.type === 'image/heic' || file.type === 'image/heif' ||
		extension === 'heic' || extension === 'heif';
	if (!isHeic) {
		return file;
	}
	if (typeof heic2any !== 'function') {
		throw new Error('HEIC conversion is unavailable.');
	}

	const converted = await heic2any({
		blob: file,
		toType: 'image/jpeg',
		quality: 0.92
	});
	const convertedBlob = Array.isArray(converted) ? converted[0] : converted;
	const jpegName = file.name.replace(/\.(heic|heif)$/i, '.jpg');
	return new File([convertedBlob], jpegName, {
		type: 'image/jpeg',
		lastModified: file.lastModified
	});
}

generateButton.addEventListener('click', generateTimelapse);
exportButton.addEventListener('click', exportTimelapse);
clearButton.addEventListener('click', clearAllPhotos);
undoClearButton.addEventListener('click', undoClear);
timelapseCanvas.addEventListener('click', togglePreviewPlayback);
secondsPerFrameInput.addEventListener('change', updatePreviewTiming);
secondsPerFrameInput.addEventListener('change', () => {
	updateDurationDisplay();
	updateExportEstimate();
});
cropToFillInput.addEventListener('change', () => {
	cropToFill = cropToFillInput.checked;
	saveProject();
	if (selectedPhoto) {
		renderSelectedEditor();
	}
	if (previewImages.length > 0) {
		drawPreviewFrame();
	}
});
normalizeLightingInput.addEventListener('change', async () => {
	normalizeLighting = normalizeLightingInput.checked;
	saveProject();
	if (!normalizeLighting || photos.length === 0) {
		return;
	}
	try {
		generationStatus.textContent = 'Analyzing face lighting...';
		const images = previewImages.length > 0
			? previewImages
			: await Promise.all(photos.map((photo) => loadImage(photo.file)));
		await prepareLightingNormalization(images);
		if (previewImages.length > 0) {
			drawPreviewFrame();
		}
		generationStatus.textContent = 'Face lighting normalized.';
	} catch (error) {
		normalizeLighting = false;
		normalizeLightingInput.checked = false;
		showNotification(`Lighting normalization failed: ${error.message}`);
	}
});
smoothLightingInput.addEventListener('change', async () => {
	smoothLighting = smoothLightingInput.checked;
	saveProject();
	if (!normalizeLighting || photos.length === 0) {
		showNotification('Enable Normalize face lighting first.');
		return;
	}
	try {
		generationStatus.textContent = 'Smoothing lighting transitions...';
		const images = previewImages.length > 0
			? previewImages
			: await Promise.all(photos.map((photo) => loadImage(photo.file)));
		await prepareLightingNormalization(images);
		if (previewImages.length > 0) {
			drawPreviewFrame();
		}
		generationStatus.textContent = 'Lighting transitions smoothed.';
	} catch (error) {
		smoothLighting = false;
		smoothLightingInput.checked = false;
		showNotification(`Lighting smoothing failed: ${error.message}`);
	}
});
aspectPreset.addEventListener('change', applyAspectPreset);
videoWidthInput.addEventListener('change', () => {
	outputDimensionsCustomized = true;
	aspectPreset.value = 'custom';
	applyVideoDimensions();
	updateExportEstimate();
});
videoHeightInput.addEventListener('change', () => {
	outputDimensionsCustomized = true;
	aspectPreset.value = 'custom';
	applyVideoDimensions();
	updateExportEstimate();
});
projectNameInput.addEventListener('change', () => {
	projectName = projectNameInput.value.trim() || 'Untitled Timelapse';
	projectNameInput.value = projectName;
	saveProject();
});
cancelAutoAlignButton.addEventListener('click', () => {
	autoAlignCancelled = true;
	cancelAutoAlignButton.disabled = true;
});
autoAlignAllButton.addEventListener('click', () => runAutoAlignAll(autoAlignAllButton));

function renderPreviews() {
	previewUrls.forEach((url) => URL.revokeObjectURL(url));
	previewUrls.length = 0;
	previewGallery.replaceChildren();
	galleryEmpty.hidden = photos.length > 0;
	galleryCount.textContent = `${photos.length} ${photos.length === 1 ? 'photo' : 'photos'}`;

	photos.forEach((photo, index) => {
		const galleryItem = document.createElement('div');
		galleryItem.className = 'gallery-item';
		if (photo === selectedPhoto) {
			galleryItem.classList.add('selected');
		}
		galleryItem.draggable = true;
		galleryItem.dataset.index = index;
		galleryItem.tabIndex = 0;
		galleryItem.setAttribute('role', 'button');
		galleryItem.setAttribute('aria-label', `Adjust ${photo.file.name}`);
		galleryItem.addEventListener('click', () => selectPhoto(photo));
		galleryItem.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				selectPhoto(photo);
			}
		});

		galleryItem.addEventListener('dragstart', (event) => {
			event.dataTransfer.setData('text/plain', index);
			galleryItem.classList.add('dragging');
		});

		galleryItem.addEventListener('dragend', () => {
			galleryItem.classList.remove('dragging');
		});

		galleryItem.addEventListener('dragover', (event) => {
			event.preventDefault();
			galleryItem.classList.add('drag-target');
		});

		galleryItem.addEventListener('dragleave', () => {
			galleryItem.classList.remove('drag-target');
		});

		galleryItem.addEventListener('drop', (event) => {
			event.preventDefault();
			galleryItem.classList.remove('drag-target');

			const sourceIndex = Number(event.dataTransfer.getData('text/plain'));
			const targetIndex = Number(galleryItem.dataset.index);

			if (sourceIndex === targetIndex) {
				return;
			}

			const [movedPhoto] = photos.splice(sourceIndex, 1);
			photos.splice(targetIndex, 0, movedPhoto);
			renderPreviews();
			saveProject();
		});

		const image = document.createElement('img');
		image.src = URL.createObjectURL(photo.file);
		image.alt = photo.file.name;
		image.loading = 'lazy';
		image.decoding = 'async';
		image.style.objectPosition = `${photo.x}% ${photo.y}%`;
		previewUrls.push(image.src);

		const removeButton = document.createElement('button');
		removeButton.type = 'button';
		removeButton.className = 'remove-photo';
		removeButton.textContent = '×';
		removeButton.setAttribute('aria-label', `Remove ${photo.file.name}`);
		removeButton.addEventListener('click', (event) => {
			event.stopPropagation();
			removePhoto(photo);
		});

		galleryItem.append(image, removeButton);
		previewGallery.appendChild(galleryItem);
	});
}

function removePhoto(photo) {
	const photoIndex = photos.indexOf(photo);
	if (photoIndex === -1) {
		return;
	}
	photos.splice(photoIndex, 1);
	if (selectedPhoto === photo) {
		selectedPhoto = photos[Math.min(photoIndex, photos.length - 1)] || null;
	}
	updateActionState();
	renderPreviews();
	renderSelectedEditor();
	saveProject();
}

function selectPhoto(photo) {
	selectedPhoto = photo;
	renderPreviews();
	renderSelectedEditor();
}

function renderSelectedEditor() {
	if (!selectedPhoto) {
		selectedEditor.hidden = true;
		editorEmpty.hidden = false;
		return;
	}

	selectedEditor.hidden = false;
	editorEmpty.hidden = true;
	selectedPhoto.zoom ??= 1;
	if (selectedImageUrl) {
		URL.revokeObjectURL(selectedImageUrl);
	}
	selectedImageUrl = URL.createObjectURL(selectedPhoto.file);
	selectedImage.src = selectedImageUrl;
	selectedImage.alt = selectedPhoto.file.name;
	selectedImage.style.objectPosition = getImagePosition(selectedPhoto);
	selectedImage.style.transform = `scale(${getEditorZoom(selectedPhoto)})`;
	alignmentControlsContainer.replaceChildren();

	const horizontalControl = createAlignmentControl('Horizontal', selectedPhoto.x, (value) => {
		selectedPhoto.x = value;
		selectedImage.style.objectPosition = getImagePosition(selectedPhoto);
		saveProject();
	});
	const verticalControl = createAlignmentControl('Vertical', selectedPhoto.y, (value) => {
		selectedPhoto.y = value;
		selectedImage.style.objectPosition = getImagePosition(selectedPhoto);
		saveProject();
	});

	const zoomControls = document.createElement('div');
	zoomControls.className = 'zoom-controls';
	const zoomOutButton = document.createElement('button');
	zoomOutButton.type = 'button';
	zoomOutButton.textContent = '-';
	const zoomValue = document.createElement('span');
	const zoomInButton = document.createElement('button');
	zoomInButton.type = 'button';
	zoomInButton.textContent = '+';
	const updateZoom = (change) => {
		selectedPhoto.zoom = clampZoom((selectedPhoto.zoom ?? 1) + change);
		selectedImage.style.transform = `scale(${getEditorZoom(selectedPhoto)})`;
		zoomValue.textContent = `${Math.round(selectedPhoto.zoom * 100)}%`;
		saveProject();
	};
	zoomValue.textContent = `${Math.round((selectedPhoto.zoom ?? 1) * 100)}%`;
	zoomOutButton.setAttribute('aria-label', 'Zoom out');
	zoomInButton.setAttribute('aria-label', 'Zoom in');
	zoomOutButton.addEventListener('click', () => updateZoom(-0.1));
	zoomInButton.addEventListener('click', () => updateZoom(0.1));
	zoomControls.append(zoomOutButton, zoomValue, zoomInButton);

	alignmentControlsContainer.append(horizontalControl, verticalControl, zoomControls);
}

function getFaceDetector() {
	if (!faceDetectorPromise) {
		faceDetectorPromise = import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/vision_bundle.mjs')
			.then(async ({ FaceDetector, FilesetResolver }) => {
				const visionFileset = await FilesetResolver.forVisionTasks(
					'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
				);
				const detectorOptions = {
					baseOptions: {
						modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
						delegate: 'GPU'
					},
					runningMode: 'IMAGE',
					minDetectionConfidence: 0.5
				};
				try {
					return await FaceDetector.createFromOptions(visionFileset, detectorOptions);
				} catch (gpuError) {
					detectorOptions.baseOptions.delegate = 'CPU';
					return FaceDetector.createFromOptions(visionFileset, detectorOptions);
				}
			});
	}
	return faceDetectorPromise;
}

async function runAutoAlignAll(button) {
	autoAlignCancelled = false;
	autoAlignStatus.hidden = false;
	autoAlignProgress.value = 0;
	cancelAutoAlignButton.disabled = false;
	button.disabled = true;
	button.textContent = 'Analyzing all photos...';
	try {
		const detector = await Promise.race([
			getFaceDetector(),
			new Promise((resolve, reject) => {
				window.setTimeout(() => reject(new Error('Face model timed out')), 15000);
			})
		]);
		const images = await Promise.all(photos.map((photo) => loadImage(photo.file)));
		const detections = [];
		for (let index = 0; index < images.length; index += 1) {
			if (autoAlignCancelled) {
				showNotification('Auto-align canceled.');
				return;
			}
			generationStatus.textContent = `Analyzing photo ${index + 1} of ${images.length}...`;
			detections.push(detector.detect(images[index]).detections[0] || null);
			autoAlignProgress.value = ((index + 1) / images.length) * 100;
		}
		const detectedFaces = detections
			.map((detection, index) => detection ? getFaceAnchor(detection, images[index]) : null)
			.filter(Boolean);

		if (detectedFaces.length === 0) {
			throw new Error('No faces were detected in the uploaded photos.');
		}

		const targetFeatureSize = median(detectedFaces.map((face) => {
			const featureSize = face.eyeDistance || face.height;
			return featureSize * getBaseScale(face.image);
		}));
		detections.forEach((detection, index) => {
			if (!detection) {
				return;
			}
			const face = getFaceAnchor(detection, images[index]);
			const baseScale = getBaseScale(images[index]);
			const photo = photos[index];
			const featureSize = face.eyeDistance || face.height;
			photo.zoom = clampZoom(targetFeatureSize / (featureSize * baseScale));
			photo.x = calculateAlignment(face.x, images[index], photo.zoom, timelapseCanvas.width, 'x');
			photo.y = calculateAlignment(face.y, images[index], photo.zoom, timelapseCanvas.height, 'y');
		});

		saveProject();
		renderSelectedEditor();
		showNotification(`Aligned ${detectedFaces.length} of ${photos.length} photos.`);
	} catch (error) {
		faceDetectorPromise = undefined;
		console.error('MediaPipe face alignment failed', error);
		showNotification(`Auto-align failed: ${error.message || 'Try the sliders instead.'}`);
	} finally {
		autoAlignStatus.hidden = true;
	cancelAutoAlignButton.disabled = false;
		button.disabled = false;
		button.textContent = 'Auto-align all faces';
	}
}

function getFaceAnchor(detection, image) {
	const bounds = detection.boundingBox;
	const normalizedBounds = bounds.width <= 1 && bounds.height <= 1;
	const width = normalizedBounds ? bounds.width * image.naturalWidth : bounds.width;
	const height = normalizedBounds ? bounds.height * image.naturalHeight : bounds.height;
	const originX = bounds.originX ?? bounds.x;
	const originY = bounds.originY ?? bounds.y;
	const boundsX = normalizedBounds ? originX * image.naturalWidth : originX;
	const boundsY = normalizedBounds ? originY * image.naturalHeight : originY;
	const eyes = (detection.keypoints || []).filter((keypoint) => (
		keypoint.label === 'left_eye' || keypoint.label === 'right_eye'
	));
	const nose = (detection.keypoints || []).find((keypoint) => keypoint.label === 'nose_tip');

	if (eyes.length >= 2) {
		const leftEye = getKeypointPosition(eyes[0], image);
		const rightEye = getKeypointPosition(eyes[1], image);
		const eyeCenterX = (leftEye.x + rightEye.x) / 2;
		const eyeCenterY = (leftEye.y + rightEye.y) / 2;
		const nosePosition = nose ? getKeypointPosition(nose, image) : null;
		return {
			x: nosePosition ? eyeCenterX * 0.85 + nosePosition.x * 0.15 : eyeCenterX,
			y: nosePosition ? eyeCenterY * 0.85 + nosePosition.y * 0.15 : eyeCenterY,
			height,
			eyeDistance: Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y),
			boundsX,
			boundsY,
			width,
			image
		};
	}

	return {
		x: boundsX + width / 2,
		y: boundsY + height * 0.4,
		height,
		boundsX,
		boundsY,
		width,
		image
	};
}

function getKeypointPosition(keypoint, image) {
	return {
		x: keypoint.x <= 1 ? keypoint.x * image.naturalWidth : keypoint.x,
		y: keypoint.y <= 1 ? keypoint.y * image.naturalHeight : keypoint.y
	};
}

async function prepareLightingNormalization(images) {
	const detector = await Promise.race([
		getFaceDetector(),
		new Promise((resolve, reject) => {
			window.setTimeout(() => reject(new Error('Face model timed out')), 15000);
		})
	]);
	const faces = images.map((image) => {
		const detection = detector.detect(image).detections[0];
		return detection ? getFaceAnchor(detection, image) : null;
	});
	const luminances = faces
		.filter(Boolean)
		.map((face) => sampleFaceLuminance(face));
	if (luminances.length === 0) {
		throw new Error('No faces were detected for lighting normalization.');
	}

	const targetLuminance = median(luminances);
	const rawGains = faces.map((face) => face
		? clampLuminanceGain(targetLuminance / Math.max(sampleFaceLuminance(face), 1))
		: 1);
	const gains = smoothLighting ? smoothTemporalValues(rawGains) : rawGains;
	faces.forEach((face, index) => {
		photos[index].luminanceGain = face ? gains[index] : 1;
	});
	saveProject();
}

function smoothTemporalValues(values) {
	const radius = 2;
	const sigma = 1.25;
	return values.map((value, index) => {
		let weightedTotal = 0;
		let weightTotal = 0;
		for (let offset = -radius; offset <= radius; offset += 1) {
			const neighborIndex = Math.min(values.length - 1, Math.max(0, index + offset));
			const weight = Math.exp(-(offset * offset) / (2 * sigma * sigma));
			weightedTotal += values[neighborIndex] * weight;
			weightTotal += weight;
		}
		return clampLuminanceGain(weightedTotal / weightTotal);
	});
}

function sampleFaceLuminance(face) {
	const analysisCanvas = document.createElement('canvas');
	const analysisSize = 64;
	analysisCanvas.width = analysisSize;
	analysisCanvas.height = analysisSize;
	const context = analysisCanvas.getContext('2d', { willReadFrequently: true });
	const x = Math.max(0, face.boundsX);
	const y = Math.max(0, face.boundsY);
	const width = Math.min(face.width, face.image.naturalWidth - x);
	const height = Math.min(face.height, face.image.naturalHeight - y);
	context.drawImage(face.image, x, y, width, height, 0, 0, analysisSize, analysisSize);
	const pixels = context.getImageData(0, 0, analysisSize, analysisSize).data;
	let luminanceTotal = 0;
	for (let index = 0; index < pixels.length; index += 4) {
		luminanceTotal += 0.299 * pixels[index] + 0.587 * pixels[index + 1] + 0.114 * pixels[index + 2];
	}
	return luminanceTotal / (pixels.length / 4);
}

function getBaseScale(image) {
	return Math.max(timelapseCanvas.width / image.naturalWidth, timelapseCanvas.height / image.naturalHeight);
}

function calculateAlignment(anchor, image, zoom, canvasDimension, axis) {
	const imageDimension = axis === 'x' ? image.naturalWidth : image.naturalHeight;
	const scaledDimension = imageDimension * getBaseScale(image) * zoom;
	const overflow = scaledDimension - canvasDimension;
	if (overflow <= 0) {
		return 50;
	}
	const destination = canvasDimension / 2 - anchor * getBaseScale(image) * zoom;
	return clampAlignment(-destination / overflow * 100);
}

function median(values) {
	const sortedValues = [...values].sort((first, second) => first - second);
	const middle = Math.floor(sortedValues.length / 2);
	return sortedValues.length % 2 === 0
		? (sortedValues[middle - 1] + sortedValues[middle]) / 2
		: sortedValues[middle];
}

function createAlignmentControl(labelText, initialValue, onInput) {
	const label = document.createElement('label');
	label.textContent = labelText;

	const slider = document.createElement('input');
	slider.type = 'range';
	slider.min = '-50';
	slider.max = '150';
	slider.value = initialValue;
	slider.setAttribute('aria-label', `${labelText} alignment`);
	slider.addEventListener('input', () => {
		onInput(Number(slider.value));
	});

	label.appendChild(slider);
	return label;
}

function clamp(value) {
	return Math.max(0, Math.min(100, value));
}

function clampAlignment(value) {
	return Math.max(-50, Math.min(150, value));
}

function clampZoom(value) {
	return Math.max(0.5, Math.min(3, value));
}

function clampLuminanceGain(value) {
	return Math.max(0.5, Math.min(2, value));
}

function getImagePosition(photo) {
	const horizontal = cropToFill ? clamp(photo.x) : photo.x;
	const vertical = cropToFill ? clamp(photo.y) : photo.y;
	return `${horizontal}% ${vertical}%`;
}

function getEditorZoom(photo) {
	return cropToFill ? Math.max(1, photo.zoom ?? 1) : (photo.zoom ?? 1);
}

function saveProject() {
	databaseReady.then((database) => {
		const transaction = database.transaction('projects', 'readwrite');
		transaction.objectStore('projects').put({
			id: 'default',
			photos: [...photos],
			settings: { cropToFill, normalizeLighting, smoothLighting, projectName }
		});
	}).catch(() => {
		generationStatus.textContent = 'Could not save the local project.';
	});
}

function loadProject(database) {
	return new Promise((resolve, reject) => {
		const request = database.transaction('projects').objectStore('projects').get('default');
		request.onsuccess = () => {
			if (request.result?.photos) {
				request.result.photos.forEach((photo) => {
					photo.zoom ??= 1;
				});
				photos.push(...request.result.photos);
				cropToFill = request.result.settings?.cropToFill ?? false;
				cropToFillInput.checked = cropToFill;
				normalizeLighting = request.result.settings?.normalizeLighting ?? false;
				normalizeLightingInput.checked = normalizeLighting;
				smoothLighting = request.result.settings?.smoothLighting ?? false;
				smoothLightingInput.checked = smoothLighting;
				projectName = request.result.settings?.projectName || 'Untitled Timelapse';
				projectNameInput.value = projectName;
				updateActionState();
				renderPreviews();
				generationStatus.textContent = 'Your saved project was restored.';
				adaptOutputDimensions();
			}
			resolve();
		};
		request.onerror = () => reject(request.error);
	});
}

async function generateTimelapse() {
	clearInterval(animationTimer);
	generateButton.disabled = true;
	generationStatus.textContent = 'Preparing your timelapse...';

	previewImages = await Promise.all(photos.map((photo) => loadImage(photo.file)));
	if (normalizeLighting) {
		generationStatus.textContent = 'Analyzing face lighting...';
		await prepareLightingNormalization(previewImages);
	}
	previewFrameIndex = 0;
	applyVideoDimensions();

	timelapseCanvas.hidden = false;
	previewEmpty.hidden = true;
	startPreviewPlayback();
	generationStatus.textContent = 'Preview is playing. Click the canvas to pause.';
	generateButton.disabled = false;
}

async function exportTimelapse() {
	if (!window.MediaRecorder || !timelapseCanvas.captureStream) {
		generationStatus.textContent = 'Video export is not supported in this browser.';
		return;
	}

	exportButton.disabled = true;
	exportProgress.hidden = false;
	exportProgress.value = 0;
	generationStatus.textContent = 'Recording your timelapse...';
	let images;
	try {
		images = await Promise.all(photos.map((photo) => loadImage(photo.file)));
		if (normalizeLighting) {
			generationStatus.textContent = 'Analyzing face lighting...';
			await prepareLightingNormalization(images);
		}
	} catch (error) {
		exportButton.disabled = false;
		exportProgress.hidden = true;
		generationStatus.textContent = 'Could not load the photos for export.';
		return;
	}
	applyVideoDimensions();
	const mimeType = getSupportedMimeType();
	if (!mimeType) {
		exportButton.disabled = false;
		exportProgress.hidden = true;
		generationStatus.textContent = 'This browser cannot export MP4 or WebM video.';
		return;
	}
	const isMp4 = mimeType.startsWith('video/mp4');
	const captureFrameRate = Math.min(60, 1 / getSecondsPerFrame());
	const videoBitsPerSecond = getVideoBitrate(timelapseCanvas, captureFrameRate);
	const recorder = new MediaRecorder(timelapseCanvas.captureStream(captureFrameRate), {
		mimeType,
		videoBitsPerSecond
	});
	const chunks = [];
	let frameIndex = 0;
	let recordedFrameCount = 0;
	let frameTimer;

	recorder.addEventListener('dataavailable', (event) => {
		if (event.data.size > 0) {
			chunks.push(event.data);
		}
	});

	recorder.addEventListener('stop', () => {
		const videoBlob = new Blob(chunks, { type: mimeType });
		const videoUrl = URL.createObjectURL(videoBlob);
		const downloadLink = document.createElement('a');
		downloadLink.href = videoUrl;
		downloadLink.download = `${getSafeExportName()}.${isMp4 ? 'mp4' : 'webm'}`;
		downloadLink.click();
		window.setTimeout(() => URL.revokeObjectURL(videoUrl), 1000);
		exportProgress.value = 100;
		exportButton.disabled = false;
		generationStatus.textContent = `Your ${isMp4 ? 'MP4' : 'WebM fallback'} export is ready.`;
		showNotification(`Export complete. ${isMp4 ? 'MP4' : 'WebM fallback'} download started.`);
	});

	const drawExportFrame = () => {
		drawAlignedPhoto(images[frameIndex], photos[frameIndex]);
		recordedFrameCount += 1;
		frameIndex = (frameIndex + 1) % photos.length;
		exportProgress.value = Math.min(100, (recordedFrameCount / (photos.length * 2)) * 100);
	};

	drawExportFrame();
	recorder.start();
	frameTimer = setInterval(drawExportFrame, getSecondsPerFrame() * 1000);
	setTimeout(() => {
		clearInterval(frameTimer);
		recorder.stop();
	}, photos.length * 2 * getSecondsPerFrame() * 1000);
}

function clearAllPhotos() {
	if (!window.confirm('Clear all uploaded photos? You can undo this action once.')) {
		return;
	}
	lastClearedPhotos = photos.map((photo) => ({ ...photo }));
	clearInterval(animationTimer);
	photos.splice(0, photos.length);
	selectedPhoto = null;
	updateActionState();
	if (selectedImageUrl) {
		URL.revokeObjectURL(selectedImageUrl);
		selectedImageUrl = undefined;
	}
	selectedImage.removeAttribute('src');
	selectedEditor.hidden = true;
	editorEmpty.hidden = false;
	timelapseCanvas.hidden = true;
	previewEmpty.hidden = false;
	previewImages = [];
	previewPlaying = false;
	exportProgress.hidden = true;
	generationStatus.textContent = 'Add photos to enable the preview.';
	renderPreviews();
	saveProject();
	showNotification('All photos cleared.');
	undoClearButton.disabled = false;
}

function undoClear() {
	if (!lastClearedPhotos) {
		return;
	}
	photos.push(...lastClearedPhotos);
	lastClearedPhotos = null;
	selectedPhoto = photos[0] || null;
	updateActionState();
	renderPreviews();
	renderSelectedEditor();
	saveProject();
	undoClearButton.disabled = true;
	showNotification('Cleared photos restored.');
}

function updateActionState() {
	const hasPhotos = photos.length > 0;
	generateButton.disabled = !hasPhotos;
	exportButton.disabled = !hasPhotos;
	clearButton.disabled = !hasPhotos;
	autoAlignAllButton.disabled = !hasPhotos;
	galleryCount.textContent = `${photos.length} ${photos.length === 1 ? 'photo' : 'photos'}`;
	updateDurationDisplay();
	updateExportEstimate();
}

function updateDurationDisplay() {
	const duration = photos.length * getSecondsPerFrame();
	totalDuration.textContent = `${duration.toFixed(1).replace('.0', '')} seconds total`;
}

function updateExportEstimate() {
	if (photos.length === 0) {
		exportButton.textContent = 'Export video';
		return;
	}
	const frameRate = Math.min(60, 1 / getSecondsPerFrame());
	const exportDuration = photos.length * 2 * getSecondsPerFrame();
	const estimatedMegabytes = getVideoBitrate(timelapseCanvas, frameRate) * exportDuration / 8 / 1_000_000;
	const displaySize = estimatedMegabytes >= 100 ? Math.round(estimatedMegabytes) : estimatedMegabytes.toFixed(1);
	exportButton.textContent = `Export video (~${displaySize} MB)`;
}

function startPreviewPlayback() {
	clearInterval(animationTimer);
	previewPlaying = true;
	drawPreviewFrame();
	animationTimer = setInterval(drawPreviewFrame, getSecondsPerFrame() * 1000);
}

function drawPreviewFrame() {
	if (previewImages.length === 0) {
		return;
	}
	drawAlignedPhoto(previewImages[previewFrameIndex], photos[previewFrameIndex]);
	previewFrameIndex = (previewFrameIndex + 1) % photos.length;
}

function togglePreviewPlayback() {
	if (previewImages.length === 0) {
		return;
	}
	if (previewPlaying) {
		clearInterval(animationTimer);
		previewPlaying = false;
		generationStatus.textContent = 'Preview paused. Click the canvas to resume.';
		return;
	}
	startPreviewPlayback();
	generationStatus.textContent = 'Preview is playing. Click the canvas to pause.';
}

function updatePreviewTiming() {
	if (previewPlaying) {
		startPreviewPlayback();
	}
}

function getSecondsPerFrame() {
	return Math.max(0.01, Math.min(10, Number(secondsPerFrameInput.value) || 0.5));
}

function applyVideoDimensions() {
	const width = clampDimension(videoWidthInput.value);
	const height = clampDimension(videoHeightInput.value);
	videoWidthInput.value = width;
	videoHeightInput.value = height;
	timelapseCanvas.width = width;
	timelapseCanvas.height = height;
}

function clampDimension(value) {
	return Math.max(160, Math.min(3840, Number(value) || 480));
}

function applyAspectPreset() {
	if (aspectPreset.value === 'custom') {
		outputDimensionsCustomized = true;
		return;
	}
	outputDimensionsCustomized = true;
	const [width, height] = aspectPreset.value.split('x').map(Number);
	videoWidthInput.value = width;
	videoHeightInput.value = height;
	applyVideoDimensions();
	updateExportEstimate();
}

async function adaptOutputDimensions() {
	if (outputDimensionsCustomized || photos.length === 0) {
		return;
	}

	const images = await Promise.all(photos.map((photo) => loadImage(photo.file)));
	const largestSourceDimension = Math.max(...images.map((image) => (
		Math.max(image.naturalWidth, image.naturalHeight)
	)));
	const [presetWidth, presetHeight] = aspectPreset.value.split('x').map(Number);
	const aspectRatio = presetWidth / presetHeight;
	const longEdge = Math.min(1920, Math.max(1280, largestSourceDimension));
	const width = aspectRatio >= 1 ? longEdge : Math.round(longEdge * aspectRatio);
	const height = aspectRatio >= 1 ? Math.round(longEdge / aspectRatio) : longEdge;
	videoWidthInput.value = width;
	videoHeightInput.value = height;
	applyVideoDimensions();
}

function showNotification(message) {
	notification.textContent = message;
	notification.hidden = false;
	window.setTimeout(() => {
		notification.hidden = true;
	}, 4000);
}

function drawAlignedPhoto(image, photo) {
	const imageWidth = image.naturalWidth;
	const imageHeight = image.naturalHeight;
	const scale = getBaseScale(image) * (cropToFill ? Math.max(1, photo.zoom ?? 1) : (photo.zoom ?? 1));
	const scaledWidth = imageWidth * scale;
	const scaledHeight = imageHeight * scale;
	const overflowX = scaledWidth - timelapseCanvas.width;
	const overflowY = scaledHeight - timelapseCanvas.height;
	let destinationX = -overflowX * (cropToFill ? clamp(photo.x) : photo.x) / 100;
	let destinationY = -overflowY * (cropToFill ? clamp(photo.y) : photo.y) / 100;
	if (cropToFill) {
		destinationX = Math.min(0, Math.max(timelapseCanvas.width - scaledWidth, destinationX));
		destinationY = Math.min(0, Math.max(timelapseCanvas.height - scaledHeight, destinationY));
	}

	canvasContext.fillStyle = '#000';
	canvasContext.fillRect(0, 0, timelapseCanvas.width, timelapseCanvas.height);
	canvasContext.filter = normalizeLighting ? `brightness(${photo.luminanceGain ?? 1})` : 'none';
	canvasContext.drawImage(
		image,
		destinationX,
		destinationY,
		scaledWidth,
		scaledHeight
	);
	canvasContext.filter = 'none';
}

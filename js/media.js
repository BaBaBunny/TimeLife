export function loadImage(file) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        const imageUrl = URL.createObjectURL(file);
        image.onload = () => {
            URL.revokeObjectURL(imageUrl);
            resolve(image);
        };
        image.onerror = reject;
        image.src = imageUrl;
    });
}

export function getSupportedMimeType() {
    const mimeTypes = [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4',
        'video/webm;codecs=vp9',
        'video/webm'
    ];
    return mimeTypes.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

export function getVideoBitrate(canvas, frameRate) {
    const pixelCount = canvas.width * canvas.height;
    let baseBitrate;
    if (pixelCount >= 3840 * 2160) {
        baseBitrate = 60_000_000;
    } else if (pixelCount >= 1920 * 1080) {
        baseBitrate = 24_000_000;
    } else if (pixelCount >= 1280 * 720) {
        baseBitrate = 16_000_000;
    } else {
        baseBitrate = 10_000_000;
    }
    return Math.round(baseBitrate * Math.max(0.5, Math.min(2, frameRate / 30)));
}

export function getSafeExportName(projectName) {
    const safeName = (projectName || 'Untitled Timelapse')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .trim()
        .replace(/[. ]+$/, '');
    return safeName || 'Untitled Timelapse';
}

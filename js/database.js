export function openProjectDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('timelife', 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore('projects', { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

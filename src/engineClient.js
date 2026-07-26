class EngineWorkerClient {
  constructor() {
    this.worker = typeof Worker !== "undefined"
      ? new Worker(new URL("./engine.worker.js", import.meta.url), { type: "module" })
      : null;
    this.sequence = 0;
    this.revisions = new Map();
    this.pending = new Map();
    this.worker?.addEventListener("message", (event) => this.handleMessage(event.data));
    this.worker?.addEventListener("error", (event) => {
      this.pending.forEach(({ reject }) => reject(event.error || new Error(event.message)));
      this.pending.clear();
    });
  }

  handleMessage(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    const currentRevision = this.revisions.get(message.photoId);
    if (message.progress) {
      if (currentRevision === message.revision) pending.onProgress?.(message.progress);
      return;
    }
    this.pending.delete(message.id);
    if (message.cancelled || currentRevision !== message.revision) {
      pending.reject(new DOMException("任务已由新修订替代", "AbortError"));
    } else if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.result);
    }
  }

  run(type, payload, { photoId = "global", transfer = [], onProgress } = {}) {
    if (!this.worker) return Promise.reject(new Error("Worker 不可用"));
    const revision = (this.revisions.get(photoId) || 0) + 1;
    this.revisions.set(photoId, revision);
    this.worker.postMessage({ type: "cancel", photoId, revision });
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, photoId, revision, onProgress });
      this.worker.postMessage({ id, photoId, revision, type, payload }, transfer);
    });
  }

  cancel(photoId) {
    const revision = (this.revisions.get(photoId) || 0) + 1;
    this.revisions.set(photoId, revision);
    this.worker?.postMessage({ type: "cancel", photoId, revision });
    this.pending.forEach((pending, id) => {
      if (pending.photoId === photoId) {
        pending.reject(new DOMException("任务已取消", "AbortError"));
        this.pending.delete(id);
      }
    });
  }
}

export const engineWorker = new EngineWorkerClient();

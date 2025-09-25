function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function createElement(tag, className, parent) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (parent) parent.appendChild(el);
  return el;
}

const DEFAULT_OUTPUT_SIZE = 512;

export class AvatarModal {
  static async open(options = {}) {
    return new Promise((resolve) => {
      const state = {
        image: null,
        ready: false,
        scale: 1,
        baseScale: 1,
        offsetX: 0,
        offsetY: 0,
        dragging: false,
        dragStartX: 0,
        dragStartY: 0
      };

      const overlay = createElement('div', 'avatar-modal-overlay', document.body);
      const dialog = createElement('div', 'avatar-modal', overlay);
      const header = createElement('div', 'avatar-modal-header', dialog);
      header.textContent = options.title || 'Update Avatar';

      const cropContainer = createElement('div', 'avatar-crop-container', dialog);
      const canvas = createElement('canvas', 'avatar-crop-canvas', cropContainer);
      const ctx = canvas.getContext('2d');
      const canvasSize = options.size || 320;
      canvas.width = canvasSize;
      canvas.height = canvasSize;

      const controls = createElement('div', 'avatar-controls', dialog);
      const fileLabel = createElement('label', 'avatar-file-label', controls);
      fileLabel.textContent = 'Choose Image';
      const fileInput = createElement('input', 'avatar-file-input', fileLabel);
      fileInput.type = 'file';
      fileInput.accept = 'image/*';

      const zoomWrapper = createElement('div', 'avatar-zoom', controls);
      const zoomLabel = createElement('span', 'avatar-zoom-label', zoomWrapper);
      zoomLabel.textContent = 'Zoom';
      const zoomInput = createElement('input', 'avatar-zoom-input', zoomWrapper);
      zoomInput.type = 'range';
      zoomInput.min = '1';
      zoomInput.max = '3';
      zoomInput.step = '0.01';
      zoomInput.value = '1';

      const actions = createElement('div', 'avatar-actions', dialog);
      const cancelBtn = createElement('button', 'btn btn-secondary', actions);
      cancelBtn.type = 'button';
      cancelBtn.textContent = 'Cancel';
      const confirmBtn = createElement('button', 'btn btn-primary', actions);
      confirmBtn.type = 'button';
      confirmBtn.textContent = 'Save Avatar';
      confirmBtn.disabled = true;

      const reader = new FileReader();

      function resetState() {
        state.image = null;
        state.ready = false;
        state.scale = 1;
        state.offsetX = 0;
        state.offsetY = 0;
        zoomInput.value = '1';
        confirmBtn.disabled = true;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }

      function clampOffsets() {
        if (!state.image) return;
        const drawScale = state.baseScale * state.scale;
        const drawWidth = state.image.width * drawScale;
        const drawHeight = state.image.height * drawScale;
        const maxOffsetX = Math.max(0, (drawWidth - canvasSize) / 2);
        const maxOffsetY = Math.max(0, (drawHeight - canvasSize) / 2);
        state.offsetX = Math.max(-maxOffsetX, Math.min(maxOffsetX, state.offsetX));
        state.offsetY = Math.max(-maxOffsetY, Math.min(maxOffsetY, state.offsetY));
      }

      function render() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.beginPath();
        ctx.arc(canvasSize / 2, canvasSize / 2, canvasSize / 2 - 1, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();

        if (state.image) {
          const drawScale = state.baseScale * state.scale;
          const drawWidth = state.image.width * drawScale;
          const drawHeight = state.image.height * drawScale;
          const drawX = canvasSize / 2 + state.offsetX - drawWidth / 2;
          const drawY = canvasSize / 2 + state.offsetY - drawHeight / 2;
          ctx.drawImage(state.image, drawX, drawY, drawWidth, drawHeight);
        }

        ctx.restore();
        ctx.beginPath();
        ctx.arc(canvasSize / 2, canvasSize / 2, canvasSize / 2 - 1, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      function handleImageLoad(src) {
        const img = new Image();
        img.onload = () => {
          state.image = img;
          const scaleX = canvasSize / img.width;
          const scaleY = canvasSize / img.height;
          state.baseScale = Math.max(scaleX, scaleY);
          state.scale = 1;
          state.offsetX = 0;
          state.offsetY = 0;
          clampOffsets();
          state.ready = true;
          confirmBtn.disabled = false;
          render();
        };
        img.onerror = () => {
          resetState();
        };
        img.src = src;
      }

      reader.onload = (event) => {
        const { result } = event.target;
        if (typeof result === 'string') {
          handleImageLoad(result);
        }
      };

      fileInput.addEventListener('change', () => {
        if (!fileInput.files || !fileInput.files.length) return;
        const file = fileInput.files[0];
        if (!file.type.startsWith('image/')) {
          resetState();
          return;
        }
        reader.readAsDataURL(file);
      });

      zoomInput.addEventListener('input', () => {
        if (!state.image) return;
        state.scale = Number(zoomInput.value);
        clampOffsets();
        render();
      });

      canvas.addEventListener('pointerdown', (event) => {
        if (!state.image) return;
        state.dragging = true;
        state.dragStartX = event.clientX;
        state.dragStartY = event.clientY;
        canvas.setPointerCapture(event.pointerId);
      });

      canvas.addEventListener('pointermove', (event) => {
        if (!state.dragging || !state.image) return;
        const deltaX = event.clientX - state.dragStartX;
        const deltaY = event.clientY - state.dragStartY;
        state.dragStartX = event.clientX;
        state.dragStartY = event.clientY;
        state.offsetX += deltaX;
        state.offsetY += deltaY;
        clampOffsets();
        render();
      });

      const endPointer = (event) => {
        if (!state.dragging) return;
        state.dragging = false;
        try {
          canvas.releasePointerCapture(event.pointerId);
        } catch (_) {}
      };

      canvas.addEventListener('pointerup', endPointer);
      canvas.addEventListener('pointercancel', endPointer);
      canvas.addEventListener('pointerleave', endPointer);

      cancelBtn.addEventListener('click', () => {
        cleanup();
        resolve(null);
      });

      async function finalizeAvatar() {
        if (!state.image) return;
        const outputSize = options.outputSize || DEFAULT_OUTPUT_SIZE;
        const outputCanvas = document.createElement('canvas');
        outputCanvas.width = outputSize;
        outputCanvas.height = outputSize;
        const outputCtx = outputCanvas.getContext('2d');
        outputCtx.clearRect(0, 0, outputSize, outputSize);
        outputCtx.save();
        outputCtx.beginPath();
        outputCtx.arc(outputSize / 2, outputSize / 2, outputSize / 2, 0, Math.PI * 2);
        outputCtx.closePath();
        outputCtx.clip();

        const drawScale = state.baseScale * state.scale * (outputSize / canvasSize);
        const drawWidth = state.image.width * drawScale;
        const drawHeight = state.image.height * drawScale;
        const drawX = outputSize / 2 + (state.offsetX * (outputSize / canvasSize)) - drawWidth / 2;
        const drawY = outputSize / 2 + (state.offsetY * (outputSize / canvasSize)) - drawHeight / 2;

        outputCtx.drawImage(state.image, drawX, drawY, drawWidth, drawHeight);
        outputCtx.restore();

        const dataUrl = outputCanvas.toDataURL('image/png');
        const base64 = dataUrl.split(',')[1];
        const buffer = base64ToUint8Array(base64);
        const preview = dataUrl;
        cleanup();
        resolve({ buffer, mimeType: 'image/png', extension: '.png', preview, base64 });
      }

      confirmBtn.addEventListener('click', () => finalizeAvatar());

      function cleanup() {
        overlay.remove();
      }

      // Auto-trigger file selection if desired
      setTimeout(() => {
        if (options.autoOpen !== false) {
          fileInput.click();
        }
      }, 50);
    });
  }
}

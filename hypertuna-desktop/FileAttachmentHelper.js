import { NostrUtils } from './NostrUtils.js';
import { HypertunaUtils } from './HypertunaUtils.js';

const electronAPI = window.electronAPI || null;
const isElectron = !!electronAPI;

function mimeFromExtension(ext) {
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain'
  };
  return map[ext.toLowerCase()] || 'application/octet-stream';
}

function getFilename(path) {
  const parts = path.split(/[\\/]/);
  return parts.pop() || path;
}

function getExtension(path) {
  const filename = getFilename(path);
  const index = filename.lastIndexOf('.');
  return index === -1 ? '' : filename.slice(index);
}

export async function prepareFileAttachment(filePath, identifier) {
  if (!isElectron || !electronAPI?.readFileBuffer) {
    throw new Error('File attachments require Electron file access');
  }

  const result = await electronAPI.readFileBuffer(filePath);
  if (!result?.success || !result.data) {
    throw new Error(result?.error || 'Unable to read attachment data');
  }

  const buffer = new Uint8Array(result.data);
  const fileHash = await NostrUtils.computeSha256(buffer);
  const ext = getExtension(filePath);
  const fileId = `${fileHash}${ext}`;
  const gatewaySettings = await HypertunaUtils.getGatewaySettings();
  const sanitizedGatewayUrl = gatewaySettings.gatewayUrl || HypertunaUtils.getCachedGatewayUrl();
  const fallbackBase = HypertunaUtils.sanitizeBaseUrl(
    sanitizedGatewayUrl || HypertunaUtils.getLocalGatewayBase()
  );
  const driveUrlInfo = HypertunaUtils.buildDriveUrl({ identifier, fileId, preferPublic: true });
  const fileUrl = driveUrlInfo.url || `${fallbackBase}/drive/${identifier}/${fileId}`;
  const metadata = {
    mimeType: mimeFromExtension(ext),
    filename: getFilename(filePath)
  };

  const tags = [
    ['r', fileUrl, 'hypertuna:drive'],
    ['i', 'hypertuna:drive']
  ];

  return { buffer, fileHash, fileId, fileUrl, metadata, tags };
}

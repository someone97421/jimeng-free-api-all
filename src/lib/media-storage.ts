import path from 'path';
import { createWriteStream } from 'fs';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

import axios from 'axios';
import fs from 'fs-extra';
import mime from 'mime';

import db from './database.ts';
import logger from './logger.ts';

const DEFAULT_RETENTION_COUNT = 50;
const DEFAULT_MAX_FILE_SIZE = 512 * 1024 * 1024;
const mediaRoot = path.resolve(
  process.env.MEDIA_DIR || path.join(path.dirname(process.env.DB_PATH || './data/jimeng.db'), 'media')
);
const retentionCount = parsePositiveInteger(process.env.MEDIA_RETENTION_COUNT, DEFAULT_RETENTION_COUNT);
const maxFileSize = parsePositiveInteger(process.env.MEDIA_MAX_FILE_SIZE, DEFAULT_MAX_FILE_SIZE);

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeContentType(value: unknown): string {
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
}

function isAllowedExtension(type: 'image' | 'video', extension: string): boolean {
  const allowed = type === 'image'
    ? ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp']
    : ['mp4', 'webm', 'mov', 'mkv', 'avi'];
  return allowed.includes(extension);
}

function getExtension(type: 'image' | 'video', contentType: string, sourceUrl: string): string {
  const contentExtension = mime.getExtension(contentType) || '';
  if (isAllowedExtension(type, contentExtension)) return contentExtension;

  try {
    const urlExtension = path.extname(new URL(sourceUrl).pathname).slice(1).toLowerCase();
    if (isAllowedExtension(type, urlExtension)) return urlExtension;
  } catch {
    // URL 格式异常时使用类型默认扩展名
  }

  return type === 'image' ? 'jpg' : 'mp4';
}

function resolveStoredPath(localPath: string): string | null {
  const resolved = path.resolve(mediaRoot, localPath);
  if (resolved === mediaRoot || !resolved.startsWith(`${mediaRoot}${path.sep}`)) return null;
  return resolved;
}

function getContentType(type: 'image' | 'video', extension: string, contentType: string): string {
  const expectedPrefix = type === 'image' ? 'image/' : 'video/';
  return contentType.startsWith(expectedPrefix)
    ? contentType
    : mime.getType(extension) || (type === 'image' ? 'image/jpeg' : 'video/mp4');
}

async function downloadArtifact(
  id: number,
  type: 'image' | 'video',
  sourceUrl: string
): Promise<void> {
  const response = await axios.get(sourceUrl, {
    responseType: 'stream',
    timeout: 30000,
    maxRedirects: 5,
    maxContentLength: maxFileSize,
    maxBodyLength: maxFileSize,
    headers: {
      Accept: type === 'video' ? 'video/*,*/*' : 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      Referer: 'https://jimeng.jianying.com/',
      Origin: 'https://jimeng.jianying.com',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    },
    validateStatus: status => status >= 200 && status < 300,
  });

  const responseContentType = normalizeContentType(response.headers['content-type']);
  const extension = getExtension(type, responseContentType, sourceUrl);
  const contentType = getContentType(type, extension, responseContentType);
  const localPath = path.join(type, `${id}.${extension}`);
  const destination = resolveStoredPath(localPath);
  if (!destination) throw new Error('媒体存储路径无效');

  const temporaryPath = `${destination}.part`;
  let bytesWritten = 0;
  const sizeGuard = new Transform({
    transform(chunk, encoding, callback) {
      bytesWritten += chunk.length;
      if (bytesWritten > maxFileSize) {
        callback(new Error(`媒体文件超过大小限制（${maxFileSize} 字节）`));
        return;
      }
      callback(null, chunk);
    },
  });

  await fs.ensureDir(path.dirname(destination));
  try {
    await pipeline(response.data, sizeGuard, createWriteStream(temporaryPath));
    const stat = await fs.stat(temporaryPath);
    if (stat.size <= 0) throw new Error('媒体文件为空');
    await fs.move(temporaryPath, destination, { overwrite: true });
    db.updateMediaStorage(id, localPath, stat.size, contentType);
  } finally {
    await fs.remove(temporaryPath).catch(() => undefined);
  }
}

async function removeStoredFile(localPath: string): Promise<void> {
  const filePath = resolveStoredPath(localPath);
  if (filePath) await fs.remove(filePath);
}

async function cleanupOrphanFiles(expectedPaths: Set<string>): Promise<void> {
  for (const type of ['image', 'video']) {
    const directory = path.join(mediaRoot, type);
    if (!(await fs.pathExists(directory))) continue;

    const entries = await fs.readdir(directory, { withFileTypes: true });
    await Promise.all(entries
      .filter(entry => entry.isFile() && !entry.name.endsWith('.part'))
      .map(entry => {
        const filePath = path.join(directory, entry.name);
        return expectedPaths.has(filePath) ? undefined : fs.remove(filePath);
      }));
  }
}

export async function cleanupMediaStorage(): Promise<void> {
  await fs.ensureDir(mediaRoot);
  const records = db.getMediaStorageRecords();
  const retained = records.slice(0, retentionCount);
  const expectedPaths = new Set(
    retained
      .map(record => record.local_path && resolveStoredPath(record.local_path))
      .filter((filePath): filePath is string => !!filePath)
  );

  await Promise.all(records.slice(retentionCount).map(async record => {
    if (!record.local_path) return;
    await removeStoredFile(record.local_path);
    db.clearMediaStorage(record.id);
  }));
  await cleanupOrphanFiles(expectedPaths);
}

export async function initializeMediaStorage(): Promise<void> {
  try {
    await cleanupMediaStorage();
    logger.info(`本地媒体存储已初始化：${mediaRoot}，保留最近 ${retentionCount} 条产物`);
  } catch (error) {
    logger.warn(`本地媒体存储初始化失败：${error.message}`);
  }
}

export async function persistMediaArtifact(
  type: 'image' | 'video',
  sourceUrl: string,
  model: string,
  prompt: string,
  key: string
): Promise<number | null> {
  if (!sourceUrl) return null;

  const id = db.saveMedia(type, sourceUrl, model, prompt, key);
  try {
    await downloadArtifact(id, type, sourceUrl);
    logger.info(`媒体产物已落盘：${type} #${id}`);
  } catch (error) {
    logger.warn(`媒体产物落盘失败：${type} #${id}，将保留远程地址：${error.message}`);
  }

  try {
    await cleanupMediaStorage();
  } catch (error) {
    logger.warn(`媒体产物清理失败：${error.message}`);
  }
  return id;
}

export function getStoredMediaPath(localPath: string | null | undefined): string | null {
  return localPath ? resolveStoredPath(localPath) : null;
}

export { mediaRoot, retentionCount };

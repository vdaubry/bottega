import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import type { ConversationImage, VideoConfig } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Handles moving the recorded video file after a review agent conversation completes.
 * Picks the largest .webm file from the temp directory and moves it to the task's
 * .bottega directory.
 */
export async function handleVideoRecording(
  videoConfig: VideoConfig | null | undefined,
): Promise<void> {
  if (!videoConfig?.tempDir) return;

  try {
    try {
      await fs.access(videoConfig.tempDir);
    } catch {
      console.log('[ConversationAdapter] Video temp dir does not exist (Playwright may not have been used)');
      return;
    }

    async function findVideoFiles(dir: string): Promise<string[]> {
      const results: string[] = [];
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...(await findVideoFiles(fullPath)));
        } else if (entry.name.endsWith('.webm')) {
          results.push(fullPath);
        }
      }
      return results;
    }

    const videoFiles = await findVideoFiles(videoConfig.tempDir);
    let orphanWorktreeVideo: string | null = null;

    if (videoFiles.length === 0 && videoConfig.worktreePath) {
      // Recovery: Playwright MCP's browser_start_video resolves a `filename` arg
      // against cwd (the worktree), not --output-dir. If the agent passed a filename,
      // the .webm lands in the worktree root instead of tempDir.
      const orphan = path.join(videoConfig.worktreePath, 'review-recording.webm');
      try {
        await fs.access(orphan);
        videoFiles.push(orphan);
        orphanWorktreeVideo = orphan;
        console.log(`[ConversationAdapter] Recovered orphan recording from worktree: ${orphan}`);
      } catch {
        /* no orphan, fall through to empty-case handling */
      }
    }

    if (videoFiles.length === 0) {
      const allFiles = await fs.readdir(videoConfig.tempDir, { recursive: true });
      console.log(
        `[ConversationAdapter] No .webm files found in video temp dir. Files present: ${JSON.stringify(allFiles)}`,
      );
      await fs.rm(videoConfig.tempDir, { recursive: true, force: true }).catch(() => {});
      return;
    }

    let largestFile = videoFiles[0]!;
    let largestSize = 0;

    for (const filePath of videoFiles) {
      const stat = await fs.stat(filePath);
      if (stat.size > largestSize) {
        largestSize = stat.size;
        largestFile = filePath;
      }
    }

    const destPath = videoConfig.recordingDestPath;
    if (!destPath) {
      console.warn('[ConversationAdapter] handleVideoRecording: missing recordingDestPath');
      await fs.rm(videoConfig.tempDir, { recursive: true, force: true }).catch(() => {});
      return;
    }
    await fs.mkdir(path.dirname(destPath), { recursive: true });

    // Remux with ffmpeg to fix duration metadata — Playwright's WebM lacks duration
    // in the header, which breaks the seek slider in the player.
    const tempDest = destPath + '.tmp';
    await fs.copyFile(largestFile, tempDest);

    try {
      await execFileAsync('ffmpeg', ['-y', '-i', tempDest, '-c', 'copy', destPath], { timeout: 60000 });
      await fs.unlink(tempDest).catch(() => {});
      console.log(
        `[ConversationAdapter] Saved review recording to ${destPath} (${(largestSize / 1024 / 1024).toFixed(1)}MB, remuxed)`,
      );
    } catch (ffmpegError) {
      const message = ffmpegError instanceof Error ? ffmpegError.message : String(ffmpegError);
      console.warn(`[ConversationAdapter] ffmpeg remux failed, using original: ${message}`);
      await fs.rename(tempDest, destPath);
    }

    await fs.rm(videoConfig.tempDir, { recursive: true, force: true }).catch(() => {});

    if (orphanWorktreeVideo) {
      await fs.unlink(orphanWorktreeVideo).catch(() => {});
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[ConversationAdapter] Error handling video recording:', message);
    await fs.rm(videoConfig.tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface HandleImagesResult {
  modifiedCommand: string | null;
  tempImagePaths: string[];
  tempDir: string | null;
}

/**
 * Handles image processing for SDK queries.
 * Extracts base64 data-URI images to temp files and appends a path list to the message.
 */
export async function handleImages(
  command: string | null,
  images: ConversationImage[] | null | undefined,
  cwd: string | null | undefined,
): Promise<HandleImagesResult> {
  const tempImagePaths: string[] = [];
  let tempDir: string | null = null;

  if (!images || images.length === 0) {
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }

  try {
    const workingDir = cwd || process.cwd();
    tempDir = path.join(workingDir, '.tmp', 'images', Date.now().toString());
    await fs.mkdir(tempDir, { recursive: true });

    for (const [index, image] of images.entries()) {
      const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) continue;

      const [, mimeType, base64Data] = matches;
      if (!mimeType || !base64Data) continue;
      const extension = mimeType.split('/')[1] ?? 'png';
      const filename = `image_${index}.${extension}`;
      const filepath = path.join(tempDir, filename);

      await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
      tempImagePaths.push(filepath);
    }

    let modifiedCommand: string | null = command;
    if (tempImagePaths.length > 0 && command?.trim()) {
      const imageNote = `\n\n[Images provided at the following paths:]\n${tempImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
      modifiedCommand = command + imageNote;
    }

    return { modifiedCommand, tempImagePaths, tempDir };
  } catch (error) {
    console.error('[ConversationAdapter] Error processing images:', error);
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }
}

/**
 * Cleans up temporary image files
 */
export async function cleanupTempFiles(
  tempImagePaths: string[] | null | undefined,
  tempDir: string | null | undefined,
): Promise<void> {
  if (!tempImagePaths || tempImagePaths.length === 0) return;

  try {
    for (const imagePath of tempImagePaths) {
      await fs.unlink(imagePath).catch(() => {});
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (error) {
    console.error('[ConversationAdapter] Error during cleanup:', error);
  }
}

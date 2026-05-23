import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  readTaskDoc,
  writeTaskDoc,
  deleteTaskDoc,
  deleteTaskArchive,
  getTaskDocPath,
  getTaskInputFilesPath,
  getRecordingPath,
  buildContextPrompt,
  getDevServerPort,
  ensureTmpFolder,
  saveConversationUpload,
  _internal
} from './documentation.js';

describe('Documentation Service - Phase 2', () => {
  let testRepoPath: string;
  let archiveRoot: string;
  const testProjectId = 99;

  beforeEach(() => {
    testRepoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-test-'));
    archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bottega-archive-'));
    process.env.BOTTEGA_ARCHIVE_ROOT = archiveRoot;
  });

  afterEach(() => {
    if (testRepoPath && fs.existsSync(testRepoPath)) {
      fs.rmSync(testRepoPath, { recursive: true, force: true });
    }
    if (archiveRoot && fs.existsSync(archiveRoot)) {
      fs.rmSync(archiveRoot, { recursive: true, force: true });
    }
    delete process.env.BOTTEGA_ARCHIVE_ROOT;
  });

  function archiveTaskPath(taskId: number) {
    return path.join(archiveRoot, 'projects', String(testProjectId), 'tasks', `task-${taskId}.md`);
  }

  describe('_internal path helpers', () => {
    it('should return correct task doc path in the central archive', () => {
      const result = getTaskDocPath(17, 42);
      expect(result).toBe(path.join(archiveRoot, 'projects', '17', 'tasks', 'task-42.md'));
    });

    it('should return correct task input_files path in the central archive', () => {
      const result = getTaskInputFilesPath(17, 42);
      expect(result).toBe(path.join(archiveRoot, 'projects', '17', 'tasks', 'task-42', 'input_files'));
    });

    it('should return correct recording path in the central archive', () => {
      const result = getRecordingPath(17, 42);
      expect(result).toBe(path.join(archiveRoot, 'projects', '17', 'recordings', 'task-42.webm'));
    });

  });

  describe('readTaskDoc', () => {
    it('should return empty string if task file does not exist', () => {
      const result = readTaskDoc(testProjectId, 1);

      expect(result).toBe('');
    });

    it('should return content of task file if it exists', () => {
      const content = '# Task 1\n\nImplement feature X.';
      writeTaskDoc(testProjectId, 1, content);

      const result = readTaskDoc(testProjectId, 1);

      expect(result).toBe(content);
    });

    it('should read correct task file based on ID', () => {
      writeTaskDoc(testProjectId, 1, 'Task 1 content');
      writeTaskDoc(testProjectId, 2, 'Task 2 content');

      expect(readTaskDoc(testProjectId, 1)).toBe('Task 1 content');
      expect(readTaskDoc(testProjectId, 2)).toBe('Task 2 content');
    });
  });

  describe('writeTaskDoc', () => {
    it('should create task file with content in the central archive', () => {
      const content = '# Task 1\n\nTask description.';

      writeTaskDoc(testProjectId, 1, content);

      const result = fs.readFileSync(archiveTaskPath(1), 'utf8');
      expect(result).toBe(content);
    });

    it('should auto-create the project archive folder if it does not exist', () => {
      writeTaskDoc(testProjectId, 1, 'Content');

      expect(fs.existsSync(path.join(archiveRoot, 'projects', String(testProjectId), 'tasks'))).toBe(true);
    });

    it('should not write to the repo .bottega/tasks folder', () => {
      writeTaskDoc(testProjectId, 1, 'Content');

      expect(fs.existsSync(path.join(testRepoPath, '.bottega', 'tasks', 'task-1.md'))).toBe(false);
    });

    it('should overwrite existing task file', () => {
      writeTaskDoc(testProjectId, 1, 'Old content');
      writeTaskDoc(testProjectId, 1, 'New content');

      const result = fs.readFileSync(archiveTaskPath(1), 'utf8');
      expect(result).toBe('New content');
    });

    it('should use correct filename based on task ID', () => {
      writeTaskDoc(testProjectId, 42, 'Task 42 content');

      expect(fs.existsSync(archiveTaskPath(42))).toBe(true);
    });
  });

  describe('deleteTaskDoc', () => {
    it('should delete task file and return true', () => {
      writeTaskDoc(testProjectId, 1, 'Content');

      const result = deleteTaskDoc(testProjectId, 1);

      expect(result).toBe(true);
      expect(fs.existsSync(archiveTaskPath(1))).toBe(false);
    });

    it('should return false if task file does not exist', () => {
      const result = deleteTaskDoc(testProjectId, 999);

      expect(result).toBe(false);
    });

    it('should only delete the specified task file', () => {
      writeTaskDoc(testProjectId, 1, 'Task 1');
      writeTaskDoc(testProjectId, 2, 'Task 2');

      deleteTaskDoc(testProjectId, 1);

      expect(fs.existsSync(archiveTaskPath(1))).toBe(false);
      expect(fs.existsSync(archiveTaskPath(2))).toBe(true);
    });
  });

  describe('deleteTaskArchive', () => {
    it('should delete the task doc, input_files folder, and recording', () => {
      writeTaskDoc(testProjectId, 7, 'doc');
      const inputFilesPath = getTaskInputFilesPath(testProjectId, 7);
      fs.mkdirSync(inputFilesPath, { recursive: true });
      fs.writeFileSync(path.join(inputFilesPath, 'a.txt'), 'x');
      const recordingPath = getRecordingPath(testProjectId, 7);
      fs.mkdirSync(path.dirname(recordingPath), { recursive: true });
      fs.writeFileSync(recordingPath, 'video-bytes');

      deleteTaskArchive(testProjectId, 7);

      expect(fs.existsSync(archiveTaskPath(7))).toBe(false);
      expect(fs.existsSync(path.dirname(inputFilesPath))).toBe(false);
      expect(fs.existsSync(recordingPath)).toBe(false);
    });

    it('should not throw when nothing exists for the task', () => {
      expect(() => deleteTaskArchive(testProjectId, 999)).not.toThrow();
    });
  });

  describe('buildContextPrompt', () => {
    it('should include Testing Configuration even when no task doc exists', () => {
      const result = buildContextPrompt(testProjectId, 1);

      expect(result).toContain('## Testing Configuration');
      expect(result).toContain('Task ID:** 1');
      expect(result).toContain('Dev Server Port:** 3101'); // 3100 + (1 % 900)
      // Task body is never inlined
      expect(result).not.toContain('## Task Context');
    });

    it('should advertise spec/specifications synonyms in Task Plan File guidance', () => {
      const result = buildContextPrompt(testProjectId, 1);

      expect(result).toContain('## Task Plan File');
      expect(result).toContain('task spec');
      expect(result).toContain('specifications');
    });

    it('should warn that in-repo .bottega/tasks files are legacy', () => {
      const result = buildContextPrompt(testProjectId, 1);

      expect(result).toContain('.bottega/tasks');
      expect(result).toContain('legacy');
    });

    it('should never inline the task doc body — only point to the path', () => {
      writeTaskDoc(testProjectId, 1, 'Task documentation body that should NOT be inlined');

      const result = buildContextPrompt(testProjectId, 1);

      expect(result).not.toContain('## Task Context');
      expect(result).not.toContain('Task documentation body that should NOT be inlined');
      expect(result).toContain(getTaskDocPath(testProjectId, 1));
    });

    it('should instruct the agent to read the task plan in full at conversation start', () => {
      const result = buildContextPrompt(testProjectId, 1);

      expect(result).toMatch(/MUST read this file in full/i);
      expect(result).toContain('Read tool');
    });

    it('should embed correct task-specific path for each task', () => {
      const result1 = buildContextPrompt(testProjectId, 1);
      const result2 = buildContextPrompt(testProjectId, 2);

      expect(result1).toContain(getTaskDocPath(testProjectId, 1));
      expect(result1).not.toContain(getTaskDocPath(testProjectId, 2));
      expect(result2).toContain(getTaskDocPath(testProjectId, 2));
      expect(result2).not.toContain(getTaskDocPath(testProjectId, 1));
    });
  });

  describe('getDevServerPort', () => {
    it('should calculate port using formula 3100 + (taskId % 900)', () => {
      expect(getDevServerPort(1)).toBe(3101);
      expect(getDevServerPort(15)).toBe(3115);
      expect(getDevServerPort(42)).toBe(3142);
      expect(getDevServerPort(100)).toBe(3200);
    });

    it('should keep ports in range 3100-3999', () => {
      // Test edge cases
      expect(getDevServerPort(0)).toBe(3100);
      expect(getDevServerPort(899)).toBe(3999);
      expect(getDevServerPort(900)).toBe(3100); // Wraps around
      expect(getDevServerPort(901)).toBe(3101);
      expect(getDevServerPort(1800)).toBe(3100); // Wraps around again
    });

    it('should handle large task IDs', () => {
      expect(getDevServerPort(10000)).toBe(3100 + (10000 % 900));
      expect(getDevServerPort(99999)).toBe(3100 + (99999 % 900));
    });
  });


  describe('_internal.getTmpFolderPath', () => {
    it('should return correct tmp folder path at project root', () => {
      const result = _internal.getTmpFolderPath('/home/user/project');
      expect(result).toBe('/home/user/project/tmp');
    });
  });

  describe('_internal.getMimeType', () => {
    it('should return correct mime type for text files', () => {
      expect(_internal.getMimeType('.txt')).toBe('text/plain');
      expect(_internal.getMimeType('.md')).toBe('text/markdown');
      expect(_internal.getMimeType('.json')).toBe('application/json');
    });

    it('should return correct mime type for image files', () => {
      expect(_internal.getMimeType('.png')).toBe('image/png');
      expect(_internal.getMimeType('.jpg')).toBe('image/jpeg');
      expect(_internal.getMimeType('.gif')).toBe('image/gif');
    });

    it('should return correct mime type for code files', () => {
      expect(_internal.getMimeType('.js')).toBe('text/javascript');
      expect(_internal.getMimeType('.py')).toBe('text/x-python');
      expect(_internal.getMimeType('.go')).toBe('text/x-go');
    });

    it('should return application/octet-stream for unknown extensions', () => {
      expect(_internal.getMimeType('.xyz')).toBe('application/octet-stream');
      expect(_internal.getMimeType('.unknown')).toBe('application/octet-stream');
    });
  });

  describe('ensureTmpFolder', () => {
    it('should create tmp folder at project root', () => {
      const result = ensureTmpFolder(testRepoPath);

      expect(result).toBe(path.join(testRepoPath, 'tmp'));
      expect(fs.existsSync(result)).toBe(true);
    });

    it('should not fail if tmp folder already exists', () => {
      fs.mkdirSync(path.join(testRepoPath, 'tmp'));

      const result = ensureTmpFolder(testRepoPath);

      expect(result).toBe(path.join(testRepoPath, 'tmp'));
      expect(fs.existsSync(result)).toBe(true);
    });

    it('should return path to tmp folder', () => {
      const result = ensureTmpFolder(testRepoPath);

      expect(result).toContain('tmp');
      expect(result.endsWith('tmp')).toBe(true);
    });
  });

  describe('saveConversationUpload', () => {
    it('should save file and return file info with absolute and relative paths', () => {
      const buffer = Buffer.from('test content');

      const result = saveConversationUpload(testRepoPath, 'test.txt', buffer);

      expect(result.name).toBe('test.txt');
      expect(result.absolutePath).toBe(path.join(testRepoPath, 'tmp', 'test.txt'));
      expect(result.relativePath).toBe('./tmp/test.txt');
      expect(result.size).toBe(12);
      expect(result.mimeType).toBe('text/plain');
    });

    it('should create tmp folder if it does not exist', () => {
      const buffer = Buffer.from('content');

      saveConversationUpload(testRepoPath, 'file.txt', buffer);

      expect(fs.existsSync(path.join(testRepoPath, 'tmp'))).toBe(true);
    });

    it('should write correct content to file', () => {
      const content = 'Hello, World!';
      const buffer = Buffer.from(content);

      saveConversationUpload(testRepoPath, 'greeting.txt', buffer);

      const savedContent = fs.readFileSync(path.join(testRepoPath, 'tmp', 'greeting.txt'), 'utf8');
      expect(savedContent).toBe(content);
    });

    it('should sanitize filename by removing path components', () => {
      const buffer = Buffer.from('content');

      const result = saveConversationUpload(testRepoPath, '../../../etc/passwd', buffer);

      expect(result.name).toBe('passwd');
      expect(result.absolutePath).toBe(path.join(testRepoPath, 'tmp', 'passwd'));
      expect(result.relativePath).toBe('./tmp/passwd');
    });

    it('should sanitize filename by replacing dangerous characters', () => {
      const buffer = Buffer.from('content');

      const result = saveConversationUpload(testRepoPath, 'file name with spaces!@#.txt', buffer);

      expect(result.name).toBe('file_name_with_spaces___.txt');
      expect(result.absolutePath).toBe(path.join(testRepoPath, 'tmp', 'file_name_with_spaces___.txt'));
      expect(result.relativePath).toBe('./tmp/file_name_with_spaces___.txt');
    });

    it('should overwrite existing file', () => {
      ensureTmpFolder(testRepoPath);
      fs.writeFileSync(path.join(testRepoPath, 'tmp', 'file.txt'), 'old content');

      saveConversationUpload(testRepoPath, 'file.txt', Buffer.from('new content'));

      const savedContent = fs.readFileSync(path.join(testRepoPath, 'tmp', 'file.txt'), 'utf8');
      expect(savedContent).toBe('new content');
    });

    it('should return correct mimeType for different file types', () => {
      const buffer = Buffer.from('fake data');

      const txtResult = saveConversationUpload(testRepoPath, 'doc.txt', buffer);
      const mdResult = saveConversationUpload(testRepoPath, 'readme.md', buffer);
      const jsonResult = saveConversationUpload(testRepoPath, 'data.json', buffer);
      const pngResult = saveConversationUpload(testRepoPath, 'image.png', buffer);

      expect(txtResult.mimeType).toBe('text/plain');
      expect(mdResult.mimeType).toBe('text/markdown');
      expect(jsonResult.mimeType).toBe('application/json');
      expect(pngResult.mimeType).toBe('image/png');
    });

    it('should handle binary files correctly', () => {
      // Create a buffer with binary data (not valid UTF-8)
      const binaryBuffer = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

      const result = saveConversationUpload(testRepoPath, 'image.png', binaryBuffer);

      expect(result.size).toBe(8);
      const savedBuffer = fs.readFileSync(path.join(testRepoPath, 'tmp', 'image.png'));
      expect(savedBuffer.equals(binaryBuffer)).toBe(true);
    });
  });
});

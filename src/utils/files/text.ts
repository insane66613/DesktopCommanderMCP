/**
 * Text file handler
 * Handles reading, writing, and editing text files
 *
 * Binary detection is handled at the factory level (factory.ts) using isBinaryFile.
 * This handler only receives files that have been confirmed as text.
 *
 * TECHNICAL DEBT:
 * This handler is missing editRange() - text search/replace logic currently lives in
 * src/tools/edit.ts (performSearchReplace function) instead of here.
 *
 * For architectural consistency with ExcelFileHandler.editRange(), the fuzzy
 * search/replace logic should be moved here. See comment in src/tools/edit.ts.
 */

import fs from "fs/promises";
import path from "path";
import { createReadStream } from 'fs';
import { createInterface, Interface } from 'readline';
import {
    FileHandler,
    ReadOptions,
    FileResult,
    FileInfo
} from './base.js';

// TODO: Centralize these constants with filesystem.ts to avoid silent drift
// These duplicate concepts from filesystem.ts and should be moved to a shared
// constants module (e.g., src/utils/files/constants.ts) during reorganization
const FILE_SIZE_LIMITS = {
    LARGE_FILE_THRESHOLD: 10 * 1024 * 1024,  // 10MB
    LINE_COUNT_LIMIT: 10 * 1024 * 1024,      // 10MB for line counting
} as const;

const READ_PERFORMANCE_THRESHOLDS = {
    SMALL_READ_THRESHOLD: 100,    // For very small reads
    CHUNK_SIZE: 8192,             // 8KB chunks for reverse reading
    DEEP_OFFSET_THRESHOLD: 1000, // Switch to bounded native byte scanning
    SCAN_CHUNK_SIZE: 64 * 1024,  // 64KB scan blocks; no retained content
} as const;

/**
 * Text file handler implementation
 * Binary detection is done at the factory level - this handler assumes file is text
 */
export class TextFileHandler implements FileHandler {
    canHandle(_path: string): boolean {
        // Text handler accepts all files that pass the factory's binary check
        // The factory routes binary files to BinaryFileHandler before reaching here
        return true;
    }

    private async detectTextEncoding(filePath: string): Promise<'utf8' | 'utf16le'> {
        const fd = await fs.open(filePath, 'r');
        try {
            const bom = Buffer.alloc(2);
            const { bytesRead } = await fd.read(bom, 0, bom.length, 0);
            if (bytesRead === 2 && bom[0] === 0xff && bom[1] === 0xfe) {
                return 'utf16le';
            }
            return 'utf8';
        } finally {
            await fd.close();
        }
    }

    async read(filePath: string, options?: ReadOptions): Promise<FileResult> {
        const offset = options?.offset ?? 0;
        const length = options?.length ?? 1000; // Default from config
        const includeStatusMessage = options?.includeStatusMessage ?? true;

        // Binary detection is done at factory level - just read as text
        return this.readFileWithSmartPositioning(filePath, offset, length, 'text/plain', includeStatusMessage, options?.signal);
    }

    async write(path: string, content: string, mode: 'rewrite' | 'append' = 'rewrite'): Promise<void> {
        if (mode === 'append') {
            await fs.appendFile(path, content);
        } else {
            await fs.writeFile(path, content);
        }
    }

    async getInfo(path: string): Promise<FileInfo> {
        const stats = await fs.stat(path);

        const info: FileInfo = {
            size: stats.size,
            created: stats.birthtime,
            modified: stats.mtime,
            accessed: stats.atime,
            isDirectory: stats.isDirectory(),
            isFile: stats.isFile(),
            permissions: stats.mode.toString(8).slice(-3),
            fileType: 'text',
            metadata: {}
        };

        // For text files that aren't too large, count lines
        if (stats.isFile() && stats.size < FILE_SIZE_LIMITS.LINE_COUNT_LIMIT) {
            try {
                const encoding = await this.detectTextEncoding(path);
                let content = await fs.readFile(path, encoding);
                if (encoding === 'utf16le' && content.charCodeAt(0) === 0xfeff) {
                    content = content.slice(1);
                }
                const lineCount = TextFileHandler.countLines(content);
                info.metadata!.lineCount = lineCount;
            } catch (error) {
                // If reading fails, skip line count
            }
        }

        return info;
    }

    // ========================================================================
    // Private Helper Methods (extracted from filesystem.ts)
    // ========================================================================

    /**
     * Count lines in text content
     * Made static and public for use by other modules (e.g., writeFile telemetry in filesystem.ts)
     */
    static countLines(content: string): number {
        if (content.length === 0) return 0;
        // Match splitLinesPreservingEndings without allocating one string per line.
        // CRLF is one break; a final break does not create an extra empty line.
        let lines = 1;
        for (let i = 0; i < content.length; i++) {
            if (content[i] === '\r') {
                lines++;
                if (content[i + 1] === '\n') i++;
            } else if (content[i] === '\n') {
                lines++;
            }
        }
        const last = content[content.length - 1];
        return last === '\r' || last === '\n' ? lines - 1 : lines;
    }

    /**
     * Get file line count (for files under size limit)
     */
    private async getFileLineCount(
        filePath: string,
        signal?: AbortSignal,
        encoding: 'utf8' | 'utf16le' = 'utf8'
    ): Promise<number | undefined> {
        try {
            const stats = await fs.stat(filePath);
            if (stats.size < FILE_SIZE_LIMITS.LINE_COUNT_LIMIT) {
                let content = await fs.readFile(filePath, { encoding, signal });
                if (encoding === 'utf16le' && content.charCodeAt(0) === 0xfeff) {
                    content = content.slice(1);
                }
                return TextFileHandler.countLines(content);
            }
        } catch (error) {
            // If we can't read the file, return undefined
        }
        return undefined;
    }

    /**
     * Generate enhanced status message
     */
    private generateEnhancedStatusMessage(
        readLines: number,
        offset: number,
        totalLines?: number,
        isNegativeOffset: boolean = false
    ): string {
        if (isNegativeOffset) {
            if (totalLines !== undefined) {
                return `[Reading last ${readLines} lines (total: ${totalLines} lines)]`;
            } else {
                return `[Reading last ${readLines} lines]`;
            }
        } else {
            if (totalLines !== undefined) {
                const endLine = offset + readLines;
                const remainingLines = Math.max(0, totalLines - endLine);

                if (offset === 0) {
                    return `[Reading ${readLines} lines from start (total: ${totalLines} lines, ${remainingLines} remaining)]`;
                } else {
                    return `[Reading ${readLines} lines from line ${offset} (total: ${totalLines} lines, ${remainingLines} remaining)]`;
                }
            } else {
                if (offset === 0) {
                    return `[Reading ${readLines} lines from start]`;
                } else {
                    return `[Reading ${readLines} lines from line ${offset}]`;
                }
            }
        }
    }

    /**
     * Split text into lines while preserving line endings
     * Made static and public for use by other modules (e.g., readFileInternal in filesystem.ts)
     */
    static splitLinesPreservingEndings(content: string): string[] {
        if (!content) return [''];

        const lines: string[] = [];
        let currentLine = '';

        for (let i = 0; i < content.length; i++) {
            const char = content[i];
            currentLine += char;

            if (char === '\n') {
                lines.push(currentLine);
                currentLine = '';
            } else if (char === '\r') {
                if (i + 1 < content.length && content[i + 1] === '\n') {
                    currentLine += content[i + 1];
                    i++;
                }
                lines.push(currentLine);
                currentLine = '';
            }
        }

        if (currentLine) {
            lines.push(currentLine);
        }

        return lines;
    }

    /**
     * Read file with smart positioning for optimal performance
     */
    private async readFileWithSmartPositioning(
        filePath: string,
        offset: number,
        length: number,
        mimeType: string,
        includeStatusMessage: boolean = true,
        signal?: AbortSignal
    ): Promise<FileResult> {
        const stats = await fs.stat(filePath);
        const fileSize = stats.size;
        const encoding = await this.detectTextEncoding(filePath);
        const totalLines = await this.getFileLineCount(filePath, signal, encoding);

        // UTF-16LE needs character-aware streaming. Skip the two-byte BOM and keep
        // the same line pagination/status semantics as ordinary text reads.
        if (encoding === 'utf16le') {
            if (offset < 0) {
                return await this.readFromEndWithReadline(
                    filePath, Math.abs(offset), mimeType, includeStatusMessage,
                    totalLines, signal, 'utf16le', 2
                );
            }
            return await this.readFromStartWithReadline(
                filePath, offset, length, mimeType, includeStatusMessage,
                totalLines, signal, 'utf16le', 2
            );
        }

        // For negative offsets (tail behavior), use reverse reading
        if (offset < 0) {
            const requestedLines = Math.abs(offset);

            if (fileSize > FILE_SIZE_LIMITS.LARGE_FILE_THRESHOLD &&
                requestedLines <= READ_PERFORMANCE_THRESHOLDS.SMALL_READ_THRESHOLD) {
                return await this.readLastNLinesReverse(filePath, requestedLines, mimeType, includeStatusMessage, totalLines, signal);
            } else {
                return await this.readFromEndWithReadline(filePath, requestedLines, mimeType, includeStatusMessage, totalLines, signal);
            }
        }
        // For large deep offsets, find the exact byte boundary with native
        // chunk scanning rather than iterating thousands of readline strings.
        // This uses bounded memory and preserves variable-length line accuracy.
        if (fileSize > FILE_SIZE_LIMITS.LARGE_FILE_THRESHOLD &&
            Number.isSafeInteger(offset) &&
            offset >= READ_PERFORMANCE_THRESHOLDS.DEEP_OFFSET_THRESHOLD) {
            const start = await this.findLineStartByte(filePath, offset, signal);
            return this.readFromStartWithReadline(
                filePath, 0, length, mimeType, includeStatusMessage,
                totalLines, signal, undefined, start, offset
            );
        }
        return this.readFromStartWithReadline(
            filePath, offset, length, mimeType, includeStatusMessage,
            totalLines, signal
        );
    }

    /**
     * Find an exact UTF-8 line start without constructing JS strings for
     * every preceding line. Both LF and CR/CRLF are delimiters, including
     * CRLF split across read buffers. No approximated byte offsets or cache
     * entries that could survive a file replacement.
     */
    private async findLineStartByte(
        filePath: string,
        targetLine: number,
        signal?: AbortSignal
    ): Promise<number> {
        if (targetLine <= 0) return 0;
        const fd = await fs.open(filePath, 'r');
        const chunk = Buffer.allocUnsafe(READ_PERFORMANCE_THRESHOLDS.SCAN_CHUNK_SIZE);
        let position = 0;
        let lines = 0;
        let skipLeadingLf = false;
        try {
            while (true) {
                if (signal?.aborted) {
                    const error = new Error('Read aborted');
                    error.name = 'AbortError';
                    throw error;
                }
                const { bytesRead } = await fd.read(chunk, 0, chunk.length, position);
                if (bytesRead === 0) return position;
                // Latin-1 preserves each original byte as one character;
                // V8's native regexp engine finds delimiters without a slow
                // JavaScript branch for every non-newline byte.
                const scanText = chunk.toString('latin1', 0, bytesRead);
                const lineBreak = /\r\n|\r|\n/g;
                lineBreak.lastIndex = skipLeadingLf && scanText.charCodeAt(0) === 0x0a ? 1 : 0;
                skipLeadingLf = false;
                for (let match = lineBreak.exec(scanText); match; match = lineBreak.exec(scanText)) {
                    let after = match.index + match[0].length;
                    if (match[0] === '\r' && after === bytesRead) skipLeadingLf = true;
                    if (++lines === targetLine) {
                        if (skipLeadingLf) {
                            const peek = Buffer.allocUnsafe(1);
                            const seen = await fd.read(peek, 0, 1, position + bytesRead);
                            if (seen.bytesRead === 1 && peek[0] === 0x0a) after++;
                        }
                        return position + after;
                    }
                }
                position += bytesRead;
            }
        } finally {
            await fd.close();
        }
    }

    /**
     * Read last N lines efficiently by reading file backwards
     */
    private async readLastNLinesReverse(
        filePath: string,
        n: number,
        mimeType: string,
        includeStatusMessage: boolean = true,
        fileTotalLines?: number,
        signal?: AbortSignal
    ): Promise<FileResult> {
        const fd = await fs.open(filePath, 'r');
        try {
            const stats = await fd.stat();
            const fileSize = stats.size;

            let position = fileSize;
            let lines: string[] = [];
            let partialLine = '';

            while (position > 0 && lines.length < n) {
                if (signal?.aborted) {
                    const err = new Error('Read aborted') as NodeJS.ErrnoException;
                    err.code = 'ABORT_ERR';
                    throw err;
                }
                const readSize = Math.min(READ_PERFORMANCE_THRESHOLDS.CHUNK_SIZE, position);
                position -= readSize;

                const buffer = Buffer.alloc(readSize);
                await fd.read(buffer, 0, readSize, position);

                const chunk = buffer.toString('utf-8');
                const text = chunk + partialLine;
                const chunkLines = text.split('\n');

                partialLine = chunkLines.shift() || '';
                lines = chunkLines.concat(lines);
            }

            if (position === 0 && partialLine) {
                lines.unshift(partialLine);
            }

            const result = lines.slice(-n);
            const content = includeStatusMessage
                ? `${this.generateEnhancedStatusMessage(result.length, -n, fileTotalLines, true)}\n\n${result.join('\n')}`
                : result.join('\n');

            return { content, mimeType, metadata: {} };
        } finally {
            await fd.close();
        }
    }

    /**
     * Run `readLines` on a readline over `filePath`, then close the file before
     * returning, whether the read finished, stopped early or failed. rl.close()
     * alone closes the line reader, not the file stream under it, so a read
     * that stopped early kept the file open until the process exited.
     */
    private async withLineReader(
        filePath: string,
        options: { signal?: AbortSignal; encoding?: BufferEncoding; start?: number },
        readLines: (rl: Interface) => Promise<void>
    ): Promise<void> {
        const input = createReadStream(filePath, options);
        // events.once(input, 'close') rejects when an earlier 'error' fires,
        // which would let an interrupted read return before the descriptor is
        // actually closed. Observe 'close' directly, even on read errors.
        const closed = new Promise<void>((resolve) => input.once('close', resolve));
        const absorbDuringCleanup = () => {};
        input.on('error', absorbDuringCleanup);
        const rl = createInterface({
            input,
            crlfDelay: Infinity
        });

        try {
            await readLines(rl);
        } finally {
            rl.close();
            input.destroy();
            await closed;
            input.off('error', absorbDuringCleanup);
        }
    }

    /**
     * Read from end using readline with circular buffer
     */
    private async readFromEndWithReadline(
        filePath: string,
        requestedLines: number,
        mimeType: string,
        includeStatusMessage: boolean = true,
        fileTotalLines?: number,
        signal?: AbortSignal,
        encoding?: BufferEncoding,
        start?: number
    ): Promise<FileResult> {
        const buffer: string[] = new Array(requestedLines);
        let bufferIndex = 0;
        let totalLines = 0;

        await this.withLineReader(filePath, { signal, encoding, start }, async (rl) => {
            for await (const line of rl) {
                buffer[bufferIndex] = line;
                bufferIndex = (bufferIndex + 1) % requestedLines;
                totalLines++;
            }
        });

        let result: string[];
        if (totalLines >= requestedLines) {
            result = [
                ...buffer.slice(bufferIndex),
                ...buffer.slice(0, bufferIndex)
            ].filter(line => line !== undefined);
        } else {
            result = buffer.slice(0, totalLines);
        }

        const content = includeStatusMessage
            ? `${this.generateEnhancedStatusMessage(result.length, -requestedLines, fileTotalLines, true)}\n\n${result.join('\n')}`
            : result.join('\n');

        return { content, mimeType, metadata: {} };
    }

    /**
     * Read from start/middle using readline
     */
    private async readFromStartWithReadline(
        filePath: string,
        offset: number,
        length: number,
        mimeType: string,
        includeStatusMessage: boolean = true,
        fileTotalLines?: number,
        signal?: AbortSignal,
        encoding?: BufferEncoding,
        start?: number,
        statusOffset: number = offset
    ): Promise<FileResult> {
        const result: string[] = [];
        let lineNumber = 0;

        await this.withLineReader(filePath, { signal, encoding, start }, async (rl) => {
            for await (const line of rl) {
                if (lineNumber >= offset && result.length < length) {
                    result.push(line);
                }
                if (result.length >= length) break;
                lineNumber++;
            }
        });

        if (includeStatusMessage) {
            const statusMessage = this.generateEnhancedStatusMessage(result.length, statusOffset, fileTotalLines, false);
            const content = `${statusMessage}\n\n${result.join('\n')}`;
            return { content, mimeType, metadata: {} };
        } else {
            const content = result.join('\n');
            return { content, mimeType, metadata: {} };
        }
    }

}

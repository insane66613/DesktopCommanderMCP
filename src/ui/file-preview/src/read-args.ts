/**
 * Preserve only parameters the original read_file tool accepts when the
 * preview widget re-reads the source. In particular, view_range is a one-based
 * inclusive read range and must not silently fall back to the default slice.
 */
const READ_ARG_KEYS = [
    'path', 'offset', 'length', 'view_range', 'sheet', 'range', 'isUrl',
] as const;

export function pickReadArgs(args: unknown): Record<string, unknown> | undefined {
    if (!args || typeof args !== 'object') return undefined;
    const source = args as Record<string, unknown>;
    // edit_block calls the path file_path; read_file/write_file use path.
    const filePath = typeof source.path === 'string'
        ? source.path
        : typeof source.file_path === 'string'
            ? source.file_path
            : undefined;
    if (!filePath) return undefined;
    const picked: Record<string, unknown> = { path: filePath };
    for (const key of READ_ARG_KEYS) {
        if (key !== 'path' && source[key] !== undefined) picked[key] = source[key];
    }
    return picked;
}

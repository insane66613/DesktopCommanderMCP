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

// Tool-input lacks the method name. A spreadsheet edit_block uses
// (file_path, range, content), not (old_string, new_string). Recognize it
// before write_file, or the widget pulls the spreadsheet before the edit
// and suppresses the post-result refresh as if the read were complete.
export function inferMutationTool(args: unknown): 'write_file' | 'edit_block' | undefined {
    if (!args || typeof args !== 'object') return undefined;
    const src = args as Record<string, unknown>;
    if (
        src.old_string !== undefined || src.new_string !== undefined
        || (typeof src.file_path === 'string'
            && (src.range !== undefined || src.content !== undefined))
    ) {
        return 'edit_block';
    }
    if (src.content !== undefined) return 'write_file';
    return undefined;
}

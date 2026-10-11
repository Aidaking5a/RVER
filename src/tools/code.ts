import {
    readdir,
    readFile,
    writeFile,
    realpath,
} from "node:fs/promises";
import path from "node:path";


const ignoredDirectories = new Set([
    "node_modules",
    ".git",
    ".venv",
    "dist",
    "build",
    ".next",
]);

export async function listProjectFiles(): Promise<string[]> {
    const root = process.cwd();
    const files: string[] = [];
    const maxFiles = 300;

    async function walk(directory: string): Promise<void> {
        if (files.length >= maxFiles) return;

        const entries = await readdir(directory, {
            withFileTypes: true,
        });

        for (const entry of entries) {
            if (files.length >= maxFiles) return;
            if (entry.name.startsWith(".")) continue;

            const fullPath = path.join(directory, entry.name);

            if (entry.isDirectory()) {
                if (!ignoredDirectories.has(entry.name)) {
                    await walk(fullPath);
                }
            } else if (entry.isFile()) {
                files.push(path.relative(root, fullPath));
            }
        }
    }

    await walk(root);
    return files.sort();
}


export async function readProjectFile(
    relativePath: string
): Promise<string> {
    const root = await realpath(process.cwd());

    if (
        !relativePath.trim() ||
        path.isAbsolute(relativePath) ||
        relativePath.split(/[\\/]/).includes("..") ||
        relativePath.includes("\0")
    ) {
        throw new Error("Invalid project-relative path.");
    }

    const resolved = path.resolve(root, relativePath);
    const relative = path.relative(root, resolved);

    if (
        !relative ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
    ) {
        throw new Error("Path must stay inside the project.");
    }

    const parts = relative.split(path.sep);

    if (
        parts.some(part =>
            part.startsWith(".") ||
            /^(node_modules|\.venv|dist|build|\.next)$/i.test(part) ||
            /secret|credential/i.test(part)
        )
    ) {
        throw new Error("Reading this path is not allowed.");
    }

    const actualPath = await realpath(resolved);

    if (
        actualPath !== resolved ||
        !actualPath.startsWith(root + path.sep)
    ) {
        throw new Error("File resolves outside the project.");
    }

    const content = await readFile(actualPath, "utf8");

    if (Buffer.byteLength(content, "utf8") > 100_000) {
        throw new Error("File exceeds the 100 KB read limit.");
    }

    return content;
}



export async function writeProjectFile(
    relativePath: string,
    content: string,
): Promise<{ success: boolean; message: string }> {
    const root = await realpath(process.cwd());

    // Reject absolute paths and attempts to traverse directories.
    if (
        path.isAbsolute(relativePath) ||
        relativePath.split(/[\\/]/).includes("..") ||
        relativePath.includes("\0")
    ) {
        throw new Error("Invalid project-relative path.");
    }

    const resolvedPath = path.resolve(root, relativePath);
    const relative = path.relative(root, resolvedPath);

    if (
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
    ) {
        throw new Error("Path must stay inside the project.");
    }

    const parts = relative.split(path.sep);

    const forbidden = new Set([
        ".env",
        ".git",
        "node_modules",
        ".venv",
        "dist",
        "build",
        ".next",
    ]);

    if (
        parts.some(
            part =>
                part.startsWith(".") ||
                forbidden.has(part.toLowerCase()) ||
                /secret|credential/i.test(part)
        )
    ) {
        throw new Error("Writing to this path is not allowed.");
    }

    if (Buffer.byteLength(content, "utf8") > 100_000) {
        throw new Error("File content exceeds the 100 KB limit.");
    }

    // Require an existing file: no accidental file creation or overwrite
    // of an unexpected path.
    const target = await realpath(resolvedPath);

    if (target !== resolvedPath) {
        throw new Error("Resolved file path does not match the requested path.");
    }

    const original = await readFile(target);

    if (original.length > 100_000) {
        throw new Error("Existing file exceeds the 100 KB limit.");
    }

    await writeFile(target, content, {
        encoding: "utf8",
        flag: "w",
    });

    return {
        success: true,
        message: `Updated ${relativePath}.`,
    };
}


import { path } from 'playcanvas';

class DroppedFile {
    filename: string;
    file: File;
    handle?: FileSystemFileHandle;

    constructor(filename: string, file: File, handle?: FileSystemFileHandle) {
        this.filename = filename;
        this.file = file;
        this.handle = handle;
    }
}

type DropHandlerFunc = (files: Array<DroppedFile>, resetScene: boolean) => void;

const resolveDirectories = (entries: Array<FileSystemEntry>): Promise<Array<FileSystemFileEntry>> => {
    const promises: Promise<Array<FileSystemFileEntry>>[] = [];
    const result: Array<FileSystemFileEntry> = [];

    entries.forEach((entry) => {
        if (entry.name === '.DS_Store') {
            return;
        }

        if (entry.isFile) {
            result.push(entry as FileSystemFileEntry);
        } else if (entry.isDirectory) {
            promises.push(
                new Promise<any>((resolve, reject) => {
                    const reader = (entry as FileSystemDirectoryEntry).createReader();

                    const p: Promise<any>[] = [];

                    const read = () => {
                        reader.readEntries(
                            (children: Array<FileSystemEntry>) => {
                                if (children.length > 0) {
                                    p.push(resolveDirectories(children));
                                    read();
                                } else {
                                    Promise.all(p).then((children: Array<Array<FileSystemFileEntry>>) => {
                                        resolve(children.flat());
                                    }, reject);
                                }
                            },
                            reject
                        );
                    };
                    read();
                })
            );
        }
    });

    return Promise.all(promises).then((children: Array<Array<FileSystemFileEntry>>) => {
        return result.concat(...children);
    });
};

const removeCommonPrefix = (urls: Array<DroppedFile>) => {
    const split = (pathname: string) => {
        const parts = pathname.split(path.delimiter);
        const base = parts[0];
        const rest = parts.slice(1).join(path.delimiter);
        return [base, rest];
    };
    while (true) {
        const parts = split(urls[0].filename);
        if (parts[1].length === 0) {
            return;
        }
        for (let i = 1; i < urls.length; ++i) {
            const other = split(urls[i].filename);
            if (parts[0] !== other[0]) {
                return;
            }
        }
        for (let i = 0; i < urls.length; ++i) {
            urls[i].filename = split(urls[i].filename)[1];
        }
    }
};

// configure drag and drop
const CreateDropHandler = (target: HTMLElement, dropHandler: DropHandlerFunc) => {

    const isLocalDrop = (ev: DragEvent) => (
        ev.target instanceof Element && !!ev.target.closest('[data-local-file-drop]')
    );

    const dragstart = (ev: DragEvent) => {
        if (isLocalDrop(ev)) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'all';
    };

    const dragover = (ev: DragEvent) => {
        if (isLocalDrop(ev)) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'all';
    };

    const drop = async (ev: DragEvent) => {
        if (isLocalDrop(ev)) return;
        ev.preventDefault();

        const transfer = ev.dataTransfer;
        if (!transfer) return;
        const items = Array.from(transfer.items);
        const fallbackFiles = () => Array.from(transfer.files).map(file => new DroppedFile(file.name, file));
        const submit = (files: DroppedFile[]) => {
            if (files.length > 1) removeCommonPrefix(files);
            if (files.length > 0) dropHandler(files, ev.shiftKey);
        };

        // handle single file drops so documents can propagate the filesystemfilehandle
        if (items.length === 1) {
            const item = items[0];
            const entry = item.kind === 'file' ? item.webkitGetAsEntry?.() : null;
            if (item.getAsFileSystemHandle && entry?.isFile) {
                try {
                    const handle = await item.getAsFileSystemHandle();
                    if (handle?.kind === 'file') {
                        const fileHandle = handle as FileSystemFileHandle;
                        const file = await fileHandle.getFile();
                        submit([new DroppedFile(file.name, file, fileHandle)]);
                        return;
                    }
                } catch (error) {
                    console.warn('Unable to access the dropped file handle; using FileList fallback', error);
                }
            }
        }

        // Map to entries first
        const entries = items
        .filter(item => item.kind === 'file')
        .map(item => item.webkitGetAsEntry?.())
        .filter((entry): entry is FileSystemEntry => !!entry);

        if (entries.length === 0) {
            submit(fallbackFiles());
            return;
        }

        try {
            // resolve directories to files
            const resolvedEntries = await resolveDirectories(entries);

            const files = await Promise.all(
                resolvedEntries.map((entry) => {
                    return new Promise<DroppedFile>((resolve, reject) => {
                        entry.file((entryFile: File) => {
                            resolve(new DroppedFile(entry.fullPath.substring(1), entryFile));
                        }, reject);
                    });
                })
            );

            submit(files);
        } catch (error) {
            console.warn('Unable to enumerate dropped entries; using FileList fallback', error);
            submit(fallbackFiles());
        }
    };

    target.addEventListener('dragstart', dragstart, true);
    target.addEventListener('dragover', dragover, true);
    target.addEventListener('drop', drop, true);
};

export { CreateDropHandler };

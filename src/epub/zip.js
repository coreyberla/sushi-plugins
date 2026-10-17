// SPDX-License-Identifier: GPL-2.0-or-later WITH GStreamer-exception-2008
// SPDX-FileCopyrightText: 2026 The Sushi authors

// A minimal read-only zip reader. It only supports what is needed to pull
// a few small entries out of an archive: stored and deflated entries, no
// encryption and no zip64.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.InputStream.prototype, 'close_async', 'close_finish');

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_SIZE = 22;
const EOCD_MAX_COMMENT = 0xffff;
const CENTRAL_SIGNATURE = 0x02014b50;
const CENTRAL_SIZE = 46;
const LOCAL_SIGNATURE = 0x04034b50;
const LOCAL_SIZE = 30;

const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const FLAG_ENCRYPTED = 1 << 0;
const FLAG_UTF8 = 1 << 11;

const CHUNK_SIZE = 64 * 1024;

const zipError = message => new GLib.Error(
    Gio.IOErrorEnum, Gio.IOErrorEnum.INVALID_DATA, message);

/** @param {GLib.Bytes} bytes */
const toDataView = bytes => {
    const array = bytes.toArray();
    return new DataView(array.buffer, array.byteOffset, array.byteLength);
};

const utf8Decoder = new TextDecoder('utf-8');
// Not strictly CP437, but non-UTF-8 names don't matter for what we look up
const latin1Decoder = new TextDecoder('latin1');

export class ZipReader {
    /** @type {Gio.FileInputStream} */
    #stream;
    /** @type {Gio.Cancellable|null} */
    #cancellable;
    /** @type {Map<string, {method: number, flags: number, compressedSize: number, size: number, offset: number}>} */
    #entries = new Map();

    /** @param {Gio.File} file
     *  @param {Gio.Cancellable|null} cancellable */
    static async open(file, cancellable) {
        const stream = await file.read_async(GLib.PRIORITY_DEFAULT, cancellable);
        const reader = new ZipReader(stream, cancellable);
        try {
            await reader.#readCentralDirectory();
        } catch (error) {
            reader.close();
            throw error;
        }
        return reader;
    }

    constructor(stream, cancellable) {
        this.#stream = stream;
        this.#cancellable = cancellable;
    }

    close() {
        if (!this.#stream.is_closed())
            this.#stream.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
    }

    /** @param {string} name */
    has(name) {
        return this.#entries.has(name);
    }

    /** @param {string} name
     *  @param {number} maxSize refuse entries that inflate beyond this
     *  @returns {Promise<GLib.Bytes>} */
    async read(name, maxSize) {
        const entry = this.#entries.get(name);
        if (!entry)
            throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND, `No “${name}” in archive`);
        if (entry.flags & FLAG_ENCRYPTED)
            throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_SUPPORTED, `“${name}” is encrypted`);
        if (entry.size > maxSize)
            throw zipError(`“${name}” is too large`);

        const header = toDataView(await this.#readAt(entry.offset, LOCAL_SIZE));
        if (header.getUint32(0, true) !== LOCAL_SIGNATURE)
            throw zipError(`Bad local header for “${name}”`);
        const dataOffset = entry.offset + LOCAL_SIZE +
            header.getUint16(26, true) + header.getUint16(28, true);
        const data = await this.#readAt(dataOffset, entry.compressedSize);

        switch (entry.method) {
        case METHOD_STORED:
            return data;
        case METHOD_DEFLATED:
            return this.#inflate(data, maxSize);
        default:
            throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_SUPPORTED,
                `Unsupported compression method ${entry.method} for “${name}”`);
        }
    }

    async #readCentralDirectory() {
        const info = this.#stream.query_info(Gio.FILE_ATTRIBUTE_STANDARD_SIZE, this.#cancellable);
        const fileSize = info.get_size();
        const tailSize = Math.min(fileSize, EOCD_SIZE + EOCD_MAX_COMMENT);
        const tail = toDataView(await this.#readAt(fileSize - tailSize, tailSize));

        let eocd = -1;
        for (let i = tailSize - EOCD_SIZE; i >= 0; i--) {
            if (tail.getUint32(i, true) === EOCD_SIGNATURE) {
                eocd = i;
                break;
            }
        }
        if (eocd < 0)
            throw zipError('Not a zip archive');

        const count = tail.getUint16(eocd + 10, true);
        const directorySize = tail.getUint32(eocd + 12, true);
        const directoryOffset = tail.getUint32(eocd + 16, true);
        if (count === 0xffff || directoryOffset === 0xffffffff)
            throw new GLib.Error(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_SUPPORTED, 'Zip64 archives are not supported');
        if (directoryOffset + directorySize > fileSize)
            throw zipError('Truncated zip archive');

        const directory = toDataView(await this.#readAt(directoryOffset, directorySize));
        let pos = 0;
        for (let i = 0; i < count; i++) {
            if (pos + CENTRAL_SIZE > directory.byteLength ||
                directory.getUint32(pos, true) !== CENTRAL_SIGNATURE)
                throw zipError('Corrupt zip central directory');

            const flags = directory.getUint16(pos + 8, true);
            const nameLength = directory.getUint16(pos + 28, true);
            const extraLength = directory.getUint16(pos + 30, true);
            const commentLength = directory.getUint16(pos + 32, true);
            const nameBytes = new Uint8Array(directory.buffer,
                directory.byteOffset + pos + CENTRAL_SIZE, nameLength);
            const name = (flags & FLAG_UTF8 ? utf8Decoder : latin1Decoder).decode(nameBytes);

            this.#entries.set(name, {
                flags,
                method: directory.getUint16(pos + 10, true),
                compressedSize: directory.getUint32(pos + 20, true),
                size: directory.getUint32(pos + 24, true),
                offset: directory.getUint32(pos + 42, true),
            });
            pos += CENTRAL_SIZE + nameLength + extraLength + commentLength;
        }
    }

    /** @returns {Promise<GLib.Bytes>} */
    async #readAt(offset, length) {
        this.#stream.seek(offset, GLib.SeekType.SET, this.#cancellable);
        const chunks = [];
        let remaining = length;
        while (remaining > 0) {
            // eslint-disable-next-line no-await-in-loop
            const chunk = await this.#stream.read_bytes_async(
                remaining, GLib.PRIORITY_DEFAULT, this.#cancellable);
            if (chunk.get_size() === 0)
                throw zipError('Unexpected end of zip archive');
            chunks.push(chunk);
            remaining -= chunk.get_size();
        }
        return concatBytes(chunks);
    }

    /** @param {GLib.Bytes} data
     *  @param {number} maxSize
     *  @returns {Promise<GLib.Bytes>} */
    async #inflate(data, maxSize) {
        // The declared size can't be trusted, so cap the output while inflating
        const stream = new Gio.ConverterInputStream({
            base_stream: Gio.MemoryInputStream.new_from_bytes(data),
            converter: new Gio.ZlibDecompressor({format: Gio.ZlibCompressorFormat.RAW}),
        });
        const chunks = [];
        let size = 0;
        while (true) {
            // eslint-disable-next-line no-await-in-loop
            const chunk = await stream.read_bytes_async(
                CHUNK_SIZE, GLib.PRIORITY_DEFAULT, this.#cancellable);
            if (chunk.get_size() === 0)
                break;
            size += chunk.get_size();
            if (size > maxSize)
                throw zipError('Zip entry is too large');
            chunks.push(chunk);
        }
        return concatBytes(chunks);
    }
}

/** @param {GLib.Bytes[]} chunks
 *  @returns {GLib.Bytes} */
const concatBytes = chunks => {
    if (chunks.length === 1)
        return chunks[0];
    const arrays = chunks.map(c => c.toArray());
    const result = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0));
    let offset = 0;
    for (const array of arrays) {
        result.set(array, offset);
        offset += array.length;
    }
    return new GLib.Bytes(result);
};

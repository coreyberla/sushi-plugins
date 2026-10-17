/* SPDX-License-Identifier: GPL-2.0-or-later WITH GStreamer-exception-2008
 * SPDX-FileCopyrightText: 2026 The Sushi authors */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import * as Gettext from 'gettext';

import {Renderer} from 'resource://org/gnome/NautilusPreviewer/plugin-api-1.js';

const Format = imports.format;

Gio._promisify(Gio.File.prototype, 'read_async', 'read_finish');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.InputStream.prototype, 'close_async', 'close_finish');

const TSV_CONTENT_TYPE = 'text/tab-separated-values';
const CANDIDATE_DELIMITERS = [',', ';', '\t', '|'];

// Only preview the beginning of huge files, parsing happens on the main thread
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_ROWS = 50_000;
const READ_CHUNK_SIZE = 256 * 1024;

// Used to estimate a natural column width from the first rows
const WIDTH_SAMPLE_ROWS = 100;
const MAX_NAT_CHARS = 40;

const CsvRow = GObject.registerClass({
    GTypeName: 'SushiPluginCsvRow',
}, class CsvRow extends GObject.Object {
    constructor(index, fields) {
        super();
        this.index = index;
        this.fields = fields;
    }
});

/** Decodes as UTF-8, falling back to Windows-1252 which spreadsheet
 *  applications commonly export. GJS keeps the byte order mark, so strip it.
 *  @param {Uint8Array} bytes
 *  @param {boolean} truncated whether the bytes may end mid-character
 *  @returns {string} */
const decode = (bytes, truncated) => {
    const decoder = new TextDecoder('utf-8', {fatal: true});
    let text = null;
    // A UTF-8 character is at most 4 bytes, so at most 3 can be cut off
    for (let cut = 0; cut <= (truncated ? 3 : 0) && text === null; cut++) {
        try {
            text = decoder.decode(bytes.subarray(0, bytes.length - cut));
        } catch {}
    }
    text ??= new TextDecoder('windows-1252').decode(bytes);
    return text.startsWith('﻿') ? text.slice(1) : text;
};

/** Guesses the delimiter by counting candidates outside of quotes in the first line.
 *  @param {string} text
 *  @returns {string} */
const sniffDelimiter = text => {
    const counts = new Map(CANDIDATE_DELIMITERS.map(d => [d, 0]));
    let inQuotes = false;
    for (const char of text.slice(0, 64 * 1024)) {
        if (char === '"')
            inQuotes = !inQuotes;
        else if (!inQuotes && (char === '\n' || char === '\r'))
            break;
        else if (!inQuotes && counts.has(char))
            counts.set(char, counts.get(char) + 1);
    }
    const [best, count] = [...counts].reduce((a, b) => b[1] > a[1] ? b : a);
    return count > 0 ? best : ',';
};

/** Lenient RFC 4180 parser: handles quoted fields, escaped quotes,
 *  embedded newlines and LF/CRLF/CR line endings.
 *  @param {string} text
 *  @param {string} delimiter
 *  @param {number} maxRows
 *  @returns {{rows: string[][], complete: boolean}} */
const parseCsv = (text, delimiter, maxRows) => {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;

    const endRow = () => {
        row.push(field);
        field = '';
        // Skip blank lines
        if (row.length > 1 || row[0] !== '')
            rows.push(row);
        row = [];
    };

    while (i < text.length) {
        const char = text[i];
        if (inQuotes) {
            if (char === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                field += char;
            }
        } else if (char === '"' && field === '') {
            inQuotes = true;
        } else if (char === delimiter) {
            row.push(field);
            field = '';
        } else if (char === '\n' || char === '\r') {
            if (char === '\r' && text[i + 1] === '\n')
                i++;
            endRow();
            if (rows.length >= maxRows)
                return {rows, complete: i + 1 >= text.length};
        } else {
            field += char;
        }
        i++;
    }

    if (field !== '' || row.length > 0)
        endRow();

    return {rows, complete: true};
};

export const Klass = class CsvRenderer extends Adw.Bin {
    static {
        GObject.registerClass({
            // Explicit so this doesn't clash with a built-in renderer
            GTypeName: 'SushiPluginCsvRenderer',
            Implements: [Renderer],
        }, this);
    }

    constructor(file, fileInfo, constructProperties = {}) {
        super(constructProperties);

        this._loadFile(file, fileInfo)
            .catch(error => this.markFailed(error));

        this.markInitialized();
    }

    cleanup() {
        this.set_child(null);
    }

    get topBarStyle() {
        return Adw.ToolbarStyle.RAISED_BORDER;
    }

    async _loadFile(file, fileInfo) {
        const {bytes, truncated} = await this._readHead(file);
        const text = decode(bytes, truncated);

        const delimiter = fileInfo.get_content_type() === TSV_CONTENT_TYPE
            ? '\t' : sniffDelimiter(text);
        const {rows, complete} = parseCsv(text, delimiter, MAX_ROWS + 1);

        // A row cut off by the byte limit would show partial data
        if (truncated && rows.length > 1)
            rows.pop();

        if (rows.length === 0) {
            this.set_child(new Adw.StatusPage({
                icon_name: 'x-office-spreadsheet-symbolic',
                title: _('Empty File'),
            }));
            this.markReady();
            return;
        }

        const [header, ...body] = rows;
        const shownRows = body.slice(0, MAX_ROWS);
        const isPartial = truncated || !complete || body.length > MAX_ROWS;

        this.set_child(this._buildView(header, shownRows, isPartial));
        this.markReady();
    }

    /** @param {Gio.File} file
     *  @returns {Promise<{bytes: Uint8Array, truncated: boolean}>} */
    async _readHead(file) {
        const stream = await file.read_async(GLib.PRIORITY_DEFAULT, this.cancellable);
        const chunks = [];
        let total = 0;
        let truncated = false;

        try {
            while (true) {
                const remaining = MAX_BYTES - total;
                if (remaining <= 0) {
                    truncated = true;
                    break;
                }
                const chunk = await stream.read_bytes_async(
                    Math.min(READ_CHUNK_SIZE, remaining),
                    GLib.PRIORITY_DEFAULT, this.cancellable);
                if (chunk.get_size() === 0)
                    break;
                chunks.push(chunk.toArray());
                total += chunk.get_size();
            }
        } finally {
            stream.close_async(GLib.PRIORITY_DEFAULT, null).catch(logError);
        }

        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
        }
        return {bytes, truncated};
    }

    /** @param {string[]} header
     *  @param {string[][]} rows
     *  @param {boolean} isPartial */
    _buildView(header, rows, isPartial) {
        const store = new Gio.ListStore({item_type: CsvRow.$gtype});
        store.splice(0, 0, rows.map((fields, index) => new CsvRow(index, fields)));

        const columnView = new Gtk.ColumnView({
            reorderable: false,
            show_column_separators: true,
            show_row_separators: true,
            css_classes: ['data-table'],
        });

        const columnCount = Math.max(header.length, ...rows.map(r => r.length));

        columnView.append_column(this._createColumn('', -1, rows, {
            text: row => String(row.index + 1),
            compare: (a, b) => a.index - b.index,
            dimmed: true,
        }));

        const collator = new Intl.Collator(undefined, {numeric: true});
        for (let col = 0; col < columnCount; col++) {
            const text = row => row.fields[col] ?? '';
            columnView.append_column(this._createColumn(header[col] ?? '', col, rows, {
                text,
                compare: (a, b) => collator.compare(text(a), text(b)),
            }));
        }

        const sortModel = new Gtk.SortListModel({
            model: store,
            sorter: columnView.sorter,
        });
        columnView.model = new Gtk.NoSelection({model: sortModel});

        const scrolled = new Gtk.ScrolledWindow({
            child: columnView,
            vexpand: true,
        });

        if (!isPartial)
            return scrolled;

        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        box.append(new Adw.Banner({
            title: Format.vprintf(Gettext.ngettext(
                'Showing the first %s row', 'Showing the first %s rows', rows.length),
            [rows.length.toLocaleString()]),
            revealed: true,
        }));
        box.append(scrolled);
        return box;
    }

    /** @param {string} title
     *  @param {number} col column index, used to sample the width
     *  @param {string[][]} rows
     *  @param {{text: (row: CsvRow) => string, compare: (a: CsvRow, b: CsvRow) => number, dimmed?: boolean}} options */
    _createColumn(title, col, rows, {text, compare, dimmed = false}) {
        const sample = rows.slice(0, WIDTH_SAMPLE_ROWS);
        const natChars = dimmed
            ? String(rows.length).length + 1
            : Math.min(MAX_NAT_CHARS, Math.max(
                title.length, ...sample.map(r => (r[col] ?? '').length), 3));

        const factory = new Gtk.SignalListItemFactory();
        factory.connect('setup', (_, listItem) => {
            listItem.child = new Gtk.Inscription({
                nat_chars: natChars,
                min_chars: Math.min(natChars, 3),
                text_overflow: Gtk.InscriptionOverflow.ELLIPSIZE_END,
                xalign: dimmed ? 1 : 0,
                css_classes: dimmed ? ['dim-label', 'numeric'] : [],
            });
        });
        factory.connect('bind', (_, listItem) => {
            const value = text(listItem.item);
            listItem.child.text = value;
            listItem.child.tooltip_text = !dimmed && value.length > natChars ? value : null;
        });

        return new Gtk.ColumnViewColumn({
            title,
            factory,
            resizable: !dimmed,
            // Data columns share any spare width, so the table fills the window
            expand: !dimmed,
            sorter: Gtk.CustomSorter.new((a, b) => Math.sign(compare(a, b))),
        });
    }
};

export const contentTypes = [
    'text/csv',
    TSV_CONTENT_TYPE,
];

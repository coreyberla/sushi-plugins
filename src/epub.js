/* SPDX-License-Identifier: GPL-2.0-or-later WITH GStreamer-exception-2008
 * SPDX-FileCopyrightText: 2026 The Sushi authors */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gly from 'gi://Gly';
import GlyGtk4 from 'gi://GlyGtk4';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {
    Renderer, ResizePolicy, resolveRelativePath,
} from 'resource://org/gnome/NautilusPreviewer/plugin-api-1.js';

import {Epub} from './epub/epub.js';
import {CoverPaintable} from './epub/coverPaintable.js';

Gio._promisify(Gly.Loader.prototype, 'load_async', 'load_finish');
Gio._promisify(Gly.Image.prototype, 'next_frame_async', 'next_frame_finish');

const FALLBACK_ICON_SIZE = 128;

/** @param {any} error */
const isCancelledError = error =>
    error instanceof GLib.Error &&
    error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);

/** @param {string} code BCP 47 language code */
const languageName = code => {
    try {
        return new Intl.DisplayNames([], {type: 'language'}).of(code) ?? code;
    } catch {
        return code;
    }
};

/** Shows dates as precise as they were given, ignoring times
 *  @param {string} date */
const formatDate = date => {
    const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(date);
    if (!match)
        return date;
    const [, year, month, day] = match;
    if (!month)
        return year;
    const parsed = new Date(Date.UTC(year, month - 1, day ?? 1));
    return parsed.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: day ? 'numeric' : undefined,
        timeZone: 'UTC',
    });
};

export const Klass = class EpubRenderer extends Adw.Bin {
    static {
        GObject.registerClass({
            // Explicit so this doesn't clash with a built-in EPUB renderer
            GTypeName: 'SushiPluginEpubRenderer',
            Implements: [Renderer],
            Template: resolveRelativePath(import.meta.url, './epub/epub.ui'),
            InternalChildren: [
                'coverImage', 'titleLabel', 'authorLabel', 'seriesLabel',
                'publisherRow', 'dateRow', 'languageRow', 'sizeRow',
                'descriptionGroup', 'descriptionLabel',
            ],
        }, this);
    }

    /** @type {CoverPaintable|null} */
    #coverPaintable = null;

    constructor(file, fileInfo, constructProperties = {}) {
        super(constructProperties);

        this._load(file, fileInfo)
            .catch(error => this.markFailed(error));

        this.markInitialized();
    }

    cleanup() {
        this.#coverPaintable?.destroy();
    }

    async _load(file, fileInfo) {
        const epub = await Epub.open(file, this.cancellable);
        try {
            this._applyMetadata(epub.metadata, fileInfo);
            this.markReady();
            await this._loadCover(epub, fileInfo);
        } finally {
            epub.close();
        }
    }

    _applyMetadata(metadata, fileInfo) {
        this._titleLabel.set_label(metadata.title ?? fileInfo.get_display_name());

        if (metadata.authors.length > 0) {
            this._authorLabel.set_label(metadata.authors.join(', '));
            this._authorLabel.set_visible(true);
        }

        if (metadata.series) {
            // Calibre stores indices as floats, e.g. "3.0"
            const index = metadata.seriesIndex && Number.isFinite(Number(metadata.seriesIndex))
                ? `${Number(metadata.seriesIndex)}`
                : metadata.seriesIndex;
            this._seriesLabel.set_label(index
                ? `${metadata.series} #${index}`
                : metadata.series);
            this._seriesLabel.set_visible(true);
        }

        const setRow = (row, value) => {
            if (!value)
                return;
            row.set_subtitle(GLib.markup_escape_text(value, -1));
            row.set_visible(true);
        };
        setRow(this._publisherRow, metadata.publisher);
        setRow(this._dateRow, metadata.date && formatDate(metadata.date));
        setRow(this._languageRow, metadata.language && languageName(metadata.language));
        if (fileInfo.has_attribute(Gio.FILE_ATTRIBUTE_STANDARD_SIZE))
            setRow(this._sizeRow, GLib.format_size(fileInfo.get_size()));

        if (metadata.description) {
            this._descriptionLabel.set_label(metadata.description);
            this._descriptionGroup.set_visible(true);
        }
    }

    async _loadCover(epub, fileInfo) {
        let texture = null;
        try {
            const bytes = await epub.readCover();
            if (bytes) {
                const image = await Gly.Loader.new_for_bytes(bytes).load_async(this.cancellable);
                const frame = await image.next_frame_async(this.cancellable);
                texture = GlyGtk4.frame_get_texture(frame);
            }
        } catch (error) {
            if (isCancelledError(error))
                return;
            console.warn('Unable to load EPUB cover', error);
        }

        if (texture) {
            this.#coverPaintable = new CoverPaintable({display: this.get_display(), texture});
            this.bind_property('scale-factor', this.#coverPaintable, 'scale-factor',
                GObject.BindingFlags.SYNC_CREATE);
            this._coverImage.set_from_paintable(this.#coverPaintable);
        } else {
            const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
            const paintable = iconTheme.lookup_by_gicon(
                fileInfo.get_icon(), FALLBACK_ICON_SIZE, this.scale_factor, 0, 0);
            this._coverImage.set_pixel_size(FALLBACK_ICON_SIZE);
            this._coverImage.add_css_class('icon-dropshadow');
            this._coverImage.set_from_paintable(paintable);
        }
    }

    get resizePolicy() {
        return ResizePolicy.NAT_SIZE;
    }
};

export const contentTypes = [
    'application/epub+zip',
];

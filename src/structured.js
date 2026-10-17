/* SPDX-License-Identifier: GPL-2.0-or-later WITH GStreamer-exception-2008
 * SPDX-FileCopyrightText: 2026 The Sushi authors */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import GtkSource from 'gi://GtkSource';

import {
    Renderer, resolveRelativePath, setupActions,
} from 'resource://org/gnome/NautilusPreviewer/plugin-api-1.js';

import {jsonCopyText, jsonPath, parseJson} from './structured/json.js';
import {ParseError, Tree, createRowFactory} from './structured/tree.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

// Parsing happens on the main thread, at roughly 15 MB/s, so leave big
// files to the text view
const MAX_TREE_SIZE = 8 * 1024 * 1024;

/**
 * @typedef {object} Format
 * @property {string} name
 * @property {string} contentType base type, subtypes are handled too
 * @property {string} language GtkSourceView language id for the text view
 * @property {(source: string) => NodeData} parse
 * @property {(node: NodeData, source: string) => string} copyText
 * @property {(nodes: NodeData[]) => string} path from the top down
 */

/** @typedef {import('./structured/tree.js').NodeData} NodeData */

/** @type {Format[]} */
const FORMATS = [{
    name: 'JSON',
    contentType: 'application/json',
    language: 'json',
    parse: parseJson,
    copyText: jsonCopyText,
    path: jsonPath,
}];

/** @param {string} contentType */
const formatFor = contentType =>
    FORMATS.find(format => Gio.content_type_is_a(contentType, format.contentType));

export const Klass = class StructuredRenderer extends Adw.Bin {
    static {
        GObject.type_ensure(GtkSource.View);
        GObject.registerClass({
            // Explicit so this doesn't clash with a built-in renderer
            GTypeName: 'SushiPluginStructuredRenderer',
            Implements: [Renderer],
            Template: resolveRelativePath(import.meta.url, './structured/structured.ui'),
            InternalChildren: [
                'banner', 'stack', 'treeView', 'textView',
                'toolbar', 'expandButton', 'viewToggle', 'rowMenu',
            ],
        }, this);
    }

    /** @type {Tree|null} */
    #tree = null;
    /** @type {Format} */
    #format;
    /** @type {string} */
    #source = '';
    /** Text for the text view, filled in when first shown
     *  @type {string|null} */
    #pendingText = null;

    constructor(file, fileInfo, constructProperties = {}) {
        super(constructProperties);

        this._viewToggle.bind_property('active-name', this._stack, 'visible-child-name',
            GObject.BindingFlags.SYNC_CREATE);
        this._viewToggle.bind_property_full('active-name', this._expandButton, 'visible',
            GObject.BindingFlags.SYNC_CREATE, (_binding, name) => [true, name === 'tree'], null);
        this._viewToggle.connect('notify::active-name', () => {
            if (this._viewToggle.active_name === 'text')
                this._fillText();
        });
        this._treeView.factory = createRowFactory(this._rowMenu);
        setupActions(this, 'structured', [
            ['copy-value', () => this._copySelected(path => this.#format.copyText(path.at(-1), this.#source))],
            ['copy-path', () => this._copySelected(path => this.#format.path(path))],
        ]);

        const styleManager = Adw.StyleManager.get_default();
        styleManager.connect_object('notify::dark', () => this._updateStyle(styleManager),
            this, GObject.ConnectFlags.DEFAULT);
        this._updateStyle(styleManager);

        this.#format = formatFor(fileInfo.get_content_type());
        this._load(file, this.#format)
            .catch(error => this.markFailed(error));

        this.markInitialized();
    }

    /** @param {Gio.File} file
     *  @param {Format} format */
    async _load(file, format) {
        const [contents] = await file.load_contents_async(this.cancellable);
        const source = new TextDecoder().decode(contents);
        this.#source = source;

        // Highlighting and laying out a big buffer is slow, so only do it
        // once someone looks at the text
        this._textView.buffer.language =
            GtkSource.LanguageManager.get_default().get_language(format.language);
        this.#pendingText = source;

        if (contents.length > MAX_TREE_SIZE) {
            this._showTextOnly(_('This file is too large to show as a tree'));
        } else {
            try {
                this.#tree = new Tree(format.parse(source));
                this._treeView.model = this.#tree.selection;
                this._updateExpandButton();
            } catch (error) {
                if (!(error instanceof ParseError))
                    throw error;
                this._showTextOnly(`Invalid ${format.name}: ${error.message}`);
                this._scrollToLine(error.line, error.column);
            }
        }

        this.markReady();
    }

    /** @param {string} message */
    _showTextOnly(message) {
        this._viewToggle.active_name = 'text';
        this._toolbar.visible = false;
        this._banner.title = message;
        this._banner.revealed = true;
    }

    _fillText() {
        if (this.#pendingText === null)
            return;
        const buffer = this._textView.buffer;
        buffer.text = this.#pendingText;
        buffer.place_cursor(buffer.get_start_iter());
        this.#pendingText = null;
    }

    /** @param {number} line 1-based
     *  @param {number} column 1-based */
    _scrollToLine(line, column) {
        const buffer = this._textView.buffer;
        const [, iter] = buffer.get_iter_at_line_offset(line - 1, column - 1);
        buffer.place_cursor(iter);
        this._textView.scroll_to_mark(buffer.get_insert(), 0.2, false, 0, 0);
    }

    /** @param {(path: NodeData[]) => string} getText */
    _copySelected(getText) {
        const path = this.#tree?.selectedPath;
        if (path)
            this.get_clipboard().set(getText(path));
    }

    _onExpandClicked() {
        // Every top level row changes separately, so detach the view rather
        // than have it update after each one
        this._treeView.model = null;
        this.#tree.setExpanded(!this.#tree.expanded);
        this._treeView.model = this.#tree.selection;
        if (this.#tree.selection.get_n_items() > 0)
            this._treeView.scroll_to(0, Gtk.ListScrollFlags.NONE, null);
        this._updateExpandButton();
    }

    _updateExpandButton() {
        this._expandButton.label = this.#tree.expanded ? _('Collapse All') : _('Expand All');
    }

    _onRowActivated(_view, position) {
        const row = this._treeView.model.get_item(position);
        if (row.expandable)
            row.expanded = !row.expanded;
    }

    /** @param {Adw.StyleManager} styleManager */
    _updateStyle(styleManager) {
        const schemes = GtkSource.StyleSchemeManager.get_default();
        this._textView.buffer.style_scheme =
            schemes.get_scheme(styleManager.dark ? 'Adwaita-dark' : 'Adwaita');
    }

    get toolbar() {
        return this._toolbar;
    }

    get topBarStyle() {
        return Adw.ToolbarStyle.RAISED_BORDER;
    }
};

// List every registered subtype: sushi matches supertypes in registration
// order, so its own text/plain renderer would otherwise win for e.g. GeoJSON
export const contentTypes = Gio.content_types_get_registered()
    .filter(type => formatFor(type));

// SPDX-License-Identifier: GPL-2.0-or-later WITH GStreamer-exception-2008
// SPDX-FileCopyrightText: 2026 The Sushi authors

import GLib from 'gi://GLib';

import {ZipReader} from './zip.js';

const MAX_XML_SIZE = 4 * 1024 * 1024;
const MAX_COVER_SIZE = 32 * 1024 * 1024;

const utf8Decoder = new TextDecoder('utf-8');

/**
 * @typedef {object} XmlElement
 * @property {string} name local name, without namespace prefix
 * @property {Record<string, string>} attrs keyed by local name
 * @property {XmlElement[]} children
 * @property {string} text concatenated text content
 */

const ENTITIES = {lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' '};

/** @param {string} text */
const decodeEntities = text => text.replace(/&(#x[0-9a-f]+|#[0-9]+|\w+);/gi, (match, entity) => {
    if (entity[0] === '#') {
        const code = entity[1] === 'x' || entity[1] === 'X'
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        try {
            return String.fromCodePoint(code);
        } catch {
            return match;
        }
    }
    return ENTITIES[entity] ?? match;
});

const localName = name => name.slice(name.indexOf(':') + 1);

const TOKEN_REGEX = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][\s\S]*?>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const ATTR_REGEX = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * A forgiving XML parser. It is only meant for the small, regular documents
 * found in an EPUB's metadata, not for general use.
 *
 * @param {string} source
 * @returns {XmlElement}
 */
export const parseXml = source => {
    const root = {name: '', attrs: {}, children: [], text: ''};
    const stack = [root];

    for (const [, cdata, closing, tagName, attrString, selfClosing, text] of source.matchAll(TOKEN_REGEX)) {
        const current = stack.at(-1);
        if (cdata !== undefined) {
            current.text += cdata;
        } else if (text !== undefined) {
            current.text += decodeEntities(text);
        } else if (closing) {
            // Tolerate mismatched tags by unwinding to the nearest match
            const name = localName(tagName);
            const index = stack.findLastIndex(e => e.name === name);
            if (index > 0)
                stack.length = index;
        } else if (tagName) {
            const attrs = {};
            for (const [, key, double, single] of (attrString ?? '').matchAll(ATTR_REGEX))
                attrs[localName(key)] = decodeEntities(double ?? single);
            const element = {name: localName(tagName), attrs, children: [], text: ''};
            current.children.push(element);
            if (!selfClosing)
                stack.push(element);
        }
    }

    return root;
};

/** @param {XmlElement} element
 *  @param {string} name
 *  @returns {XmlElement[]} */
const findAll = (element, name) => element.children.flatMap(
    child => child.name === name ? [child, ...findAll(child, name)] : findAll(child, name));

/** @param {XmlElement} element
 *  @param {string} name */
const find = (element, name) => findAll(element, name)[0] ?? null;

/** @param {string|undefined} text */
const clean = text => text?.replace(/\s+/g, ' ').trim() || null;

/** Descriptions are frequently (escaped) HTML, flatten them to plain text
 *  @param {string} html */
const htmlToText = html => decodeEntities(html
    .replace(/<\s*(br|\/p|\/div|\/h\d|\/li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n') || null;

/** Resolves an href relative to a path inside the archive
 *  @param {string} base path of the referencing file
 *  @param {string} href */
const resolvePath = (base, href) => {
    const parts = base.split('/').slice(0, -1);
    const unescaped = GLib.Uri.unescape_string(href.split('#')[0], null) ?? href;
    for (const part of unescaped.split('/')) {
        if (part === '..')
            parts.pop();
        else if (part !== '.' && part !== '')
            parts.push(part);
    }
    return parts.join('/');
};

/**
 * @typedef {object} EpubMetadata
 * @property {string|null} title
 * @property {string[]} authors
 * @property {string|null} publisher
 * @property {string|null} date
 * @property {string|null} language BCP 47 code
 * @property {string|null} description
 * @property {string|null} series
 * @property {string|null} seriesIndex
 * @property {string|null} coverPath path of the cover image inside the archive
 */

/**
 * @param {XmlElement} opf
 * @param {string} opfPath
 * @returns {EpubMetadata}
 */
export const parseOpf = (opf, opfPath) => {
    const metadata = find(opf, 'metadata') ?? opf;
    const metas = findAll(metadata, 'meta');
    const manifest = findAll(find(opf, 'manifest') ?? opf, 'item');

    // EPUB 3 attaches extra info to elements through <meta refines="#id">
    const refinement = (element, property) => {
        const id = element.attrs.id;
        if (!id)
            return null;
        const meta = metas.find(m => m.attrs.refines === `#${id}` && m.attrs.property === property);
        return clean(meta?.text);
    };
    // EPUB 2 style <meta name="…" content="…">
    const namedMeta = name => clean(metas.find(m => m.attrs.name === name)?.attrs.content);

    const titles = findAll(metadata, 'title');
    const mainTitle = titles.find(t => refinement(t, 'title-type') === 'main') ?? titles[0];

    const authors = findAll(metadata, 'creator')
        .filter(c => {
            const role = c.attrs.role ?? refinement(c, 'role');
            return !role || role === 'aut';
        })
        .map(c => clean(c.text))
        .filter(Boolean);

    let series = namedMeta('calibre:series');
    let seriesIndex = namedMeta('calibre:series_index');
    const collection = metas.find(m => m.attrs.property === 'belongs-to-collection' &&
        (refinement(m, 'collection-type') ?? 'series') === 'series');
    if (!series && collection) {
        series = clean(collection.text);
        seriesIndex = refinement(collection, 'group-position');
    }

    const coverId = namedMeta('cover');
    const coverItem =
        manifest.find(i => i.attrs.properties?.split(/\s+/).includes('cover-image')) ??
        manifest.find(i => coverId && i.attrs.id === coverId) ??
        manifest.find(i => i.attrs['media-type']?.startsWith('image/') &&
            /cover/i.test(`${i.attrs.id} ${i.attrs.href}`));

    const description = find(metadata, 'description');

    return {
        title: clean(mainTitle?.text),
        authors,
        publisher: clean(find(metadata, 'publisher')?.text),
        date: clean(find(metadata, 'date')?.text),
        language: clean(find(metadata, 'language')?.text),
        description: description ? htmlToText(description.text) : null,
        series,
        seriesIndex,
        coverPath: coverItem?.attrs.href ? resolvePath(opfPath, coverItem.attrs.href) : null,
    };
};

export class Epub {
    /** @type {ZipReader} */
    #zip;
    /** @type {EpubMetadata} */
    metadata;

    /** @param {Gio.File} file
     *  @param {Gio.Cancellable|null} cancellable */
    static async open(file, cancellable) {
        const zip = await ZipReader.open(file, cancellable);
        try {
            const container = parseXml(await zip.read('META-INF/container.xml', MAX_XML_SIZE)
                .then(bytes => utf8Decoder.decode(bytes.toArray())));
            const opfPath = findAll(container, 'rootfile')
                .find(r => r.attrs['media-type'] === 'application/oebps-package+xml' ||
                    r.attrs['full-path']?.endsWith('.opf'))
                ?.attrs['full-path'];
            if (!opfPath)
                throw new Error('EPUB has no package document');

            const opf = parseXml(utf8Decoder.decode(
                (await zip.read(opfPath, MAX_XML_SIZE)).toArray()));
            return new Epub(zip, parseOpf(opf, opfPath));
        } catch (error) {
            zip.close();
            throw error;
        }
    }

    constructor(zip, metadata) {
        this.#zip = zip;
        this.metadata = metadata;
    }

    /** @returns {Promise<GLib.Bytes|null>} */
    async readCover() {
        const path = this.metadata.coverPath;
        if (!path || !this.#zip.has(path))
            return null;
        return this.#zip.read(path, MAX_COVER_SIZE);
    }

    close() {
        this.#zip.close();
    }
}

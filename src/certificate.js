/* SPDX-License-Identifier: GPL-2.0-or-later WITH GStreamer-exception-2008
 * SPDX-FileCopyrightText: 2026 The Sushi authors */

import Adw from 'gi://Adw';
import Gcr from 'gi://Gcr?version=4';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {
    Renderer, ResizePolicy,
} from 'resource://org/gnome/NautilusPreviewer/plugin-api-1.js';

const Format = imports.format;

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

// Bundles like the system CA list hold hundreds of certificates
const SEARCH_THRESHOLD = 10;

/** Finds every certificate in PEM, DER or PKCS#7 data.
 *  @param {GLib.Bytes} bytes
 *  @returns {{certificates: Gcr.Certificate[], others: string[]}} descriptions
 *      of anything else found, e.g. private keys */
const parseCertificates = bytes => {
    const parser = new Gcr.Parser();
    const certificates = [];
    const others = [];
    parser.connect('parsed', () => {
        if (parser.get_parsed_format() === Gcr.DataFormat.DER_CERTIFICATE_X509)
            certificates.push(Gcr.SimpleCertificate.new(parser.get_parsed_bytes().toArray()));
        else
            others.push(parser.get_parsed_description());
    });
    // There's no way to ask for a password, so leave encrypted blocks locked
    parser.connect('authenticate', () => false);

    try {
        parser.parse_bytes(bytes);
    } catch (error) {
        // Keep what came before a block that couldn't be read
        if (certificates.length === 0)
            throw error;
        console.warn('Unable to parse the rest of the certificate file', error);
    }
    return {certificates, others};
};

/** @param {Uint8Array} bytes */
const formatHex = bytes =>
    Array.from(bytes, b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

/** @param {GLib.DateTime} date */
const formatDate = date =>
    new Date(date.to_unix() * 1000).toLocaleDateString(undefined, {dateStyle: 'long'});

/** @param {Gcr.CertificateField} field
 *  @returns {{text: string, monospace: boolean}} */
const fieldText = field => {
    const value = field.value;
    if (value instanceof GLib.Bytes)
        return {text: formatHex(value.toArray()), monospace: true};
    if (Array.isArray(value))
        return {text: value.join('\n'), monospace: false};
    return {text: String(value ?? ''), monospace: false};
};

/** @param {Gcr.Certificate} certificate */
const certificateName = certificate =>
    certificate.get_subject_name() ?? certificate.label ?? _('Unnamed Certificate');

/** @param {string} title
 *  @param {string} text
 *  @param {boolean} monospace */
const createRow = (title, text, monospace) => {
    const escaped = GLib.markup_escape_text(text, -1);
    return new Adw.ActionRow({
        title,
        subtitle: monospace ? `<tt>${escaped}</tt>` : escaped,
        subtitle_selectable: true,
        css_classes: ['property'],
    });
};

/** @param {Gcr.Certificate} certificate
 *  @returns {{text: string, style: string}} */
const validity = certificate => {
    const now = GLib.DateTime.new_now_utc();
    const expiry = certificate.get_expiry_date();
    const issued = certificate.get_issued_date();
    if (expiry && now.compare(expiry) > 0) {
        return {
            text: Format.vprintf(_('Expired on %s'), [formatDate(expiry)]),
            style: 'error',
        };
    }
    if (issued && now.compare(issued) < 0) {
        return {
            text: Format.vprintf(_('Not valid before %s'), [formatDate(issued)]),
            style: 'warning',
        };
    }
    if (expiry) {
        return {
            text: Format.vprintf(_('Valid until %s'), [formatDate(expiry)]),
            style: 'success',
        };
    }
    return {text: _('Unknown validity'), style: 'dim-label'};
};

/** @param {Gcr.Certificate} certificate */
const buildHeader = certificate => {
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
    box.append(new Gtk.Image({
        icon_name: 'application-certificate-symbolic',
        pixel_size: 64,
        margin_bottom: 12,
        css_classes: ['dim-label'],
    }));
    box.append(new Gtk.Label({
        label: certificateName(certificate),
        wrap: true,
        wrap_mode: Gtk.WrapMode.WORD_CHAR,
        justify: Gtk.Justification.CENTER,
        selectable: true,
        css_classes: ['title-2'],
    }));

    const issuer = certificate.is_issuer(certificate)
        ? _('Self-signed')
        : Format.vprintf(_('Issued by %s'), [certificate.get_issuer_name() ?? _('Unknown')]);
    box.append(new Gtk.Label({
        label: issuer,
        wrap: true,
        justify: Gtk.Justification.CENTER,
        css_classes: ['heading'],
    }));

    const {text, style} = validity(certificate);
    box.append(new Gtk.Label({
        label: text,
        wrap: true,
        justify: Gtk.Justification.CENTER,
        css_classes: [style],
    }));
    return box;
};

/** @param {Gcr.Certificate} certificate */
const buildPage = certificate => {
    const content = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 24,
        margin_top: 24,
        margin_bottom: 24,
        margin_start: 12,
        margin_end: 12,
    });
    content.append(buildHeader(certificate));

    for (const section of certificate.get_interface_elements()) {
        // The summary section repeats what the header shows
        if (section.get_flags() & Gcr.CertificateSectionFlags.IMPORTANT)
            continue;

        const group = new Adw.PreferencesGroup({
            title: GLib.markup_escape_text(section.label, -1),
        });
        const fields = section.fields;
        for (let i = 0; i < fields.get_n_items(); i++) {
            const field = fields.get_item(i);
            // gcr only lists the SHA1 and MD5 fingerprints, add the one
            // browsers show next to them
            if (field.label === 'SHA1') {
                group.add(createRow('SHA256',
                    certificate.get_fingerprint_hex(GLib.ChecksumType.SHA256), true));
            }
            const {text, monospace} = fieldText(field);
            group.add(createRow(field.label, text, monospace));
        }
        content.append(group);
    }

    return new Gtk.ScrolledWindow({
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        propagate_natural_height: true,
        // Grow the window with the content, but scroll the long field list
        max_content_height: 720,
        child: new Adw.Clamp({maximum_size: 500, child: content}),
    });
};

export const Klass = class CertificateRenderer extends Adw.Bin {
    static {
        GObject.registerClass({
            // Explicit so this doesn't clash with a built-in renderer
            GTypeName: 'SushiPluginCertificateRenderer',
            Implements: [Renderer],
        }, this);
    }

    /** @type {Gtk.Widget|null} */
    #toolbar = null;

    constructor(file, fileInfo, constructProperties = {}) {
        super(constructProperties);

        this._load(file)
            .catch(error => this.markFailed(error));

        this.markInitialized();
    }

    cleanup() {
        this.set_child(null);
    }

    /** @param {Gio.File} file */
    async _load(file) {
        const [contents] = await file.load_contents_async(this.cancellable);
        const {certificates, others} = parseCertificates(new GLib.Bytes(contents));

        if (certificates.length === 0) {
            this.set_child(new Adw.StatusPage({
                icon_name: 'application-certificate-symbolic',
                title: _('No Certificates'),
                description: others.length > 0
                    ? Format.vprintf(_('This file contains: %s'), [[...new Set(others)].join(', ')])
                    : null,
            }));
            this.markReady();
            return;
        }

        if (certificates.length > 1)
            this.#toolbar = this._buildPicker(certificates);
        this.set_child(buildPage(certificates[0]));
        this.markReady();
    }

    /** Pages are built when picked, since bundles can be large
     *  @param {Gcr.Certificate[]} certificates */
    _buildPicker(certificates) {
        const dropDown = Gtk.DropDown.new_from_strings(certificates.map(certificateName));
        dropDown.add_css_class('flat');
        if (certificates.length > SEARCH_THRESHOLD) {
            dropDown.enable_search = true;
            dropDown.search_match_mode = Gtk.StringFilterMatchMode.SUBSTRING;
            dropDown.expression = Gtk.PropertyExpression.new(Gtk.StringObject, null, 'string');
        }
        dropDown.connect('notify::selected', () => {
            const certificate = certificates[dropDown.selected];
            if (certificate)
                this.set_child(buildPage(certificate));
        });

        const box = new Gtk.Box({
            halign: Gtk.Align.END,
            valign: Gtk.Align.END,
            css_classes: ['osd', 'pill-osd'],
        });
        box.append(dropDown);
        return box;
    }

    get toolbar() {
        return this.#toolbar;
    }

    get resizePolicy() {
        return ResizePolicy.NAT_SIZE;
    }
};

// The +pem types are subtypes of text/plain, so list them explicitly or the
// built-in text renderer wins
export const contentTypes = [
    'application/pkix-cert',
    'application/pkix-cert+pem',
    'application/x-x509-ca-cert',
    'application/x-x509-user-cert',
    'application/x-pem-file',
    'application/pkcs7-mime',
    'application/pkcs7-mime+pem',
    'application/x-pkcs7-certificates',
];

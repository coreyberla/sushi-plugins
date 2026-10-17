// SPDX-License-Identifier: GPL-2.0-or-later WITH GStreamer-exception-2008
// SPDX-FileCopyrightText: 2026 The Sushi authors

// A format independent tree of nodes, and the list view pieces to show it.
// Each format only has to parse its source into NodeData.

import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';

/**
 * @typedef {object} NodeData
 * @property {string|null} key name of the node, null for the root
 * @property {boolean} isIndex whether the key is a position rather than a name
 * @property {string} kind format specific, e.g. "string", picks the value style
 * @property {string} value text to show, a summary for nodes with children
 * @property {NodeData[]|null} children null for leaves
 * @property {number} start offset of the node in the source
 * @property {number} end offset just past the node in the source
 */

const MAX_TOOLTIP_LENGTH = 2000;

// Style classes for leaf values by kind, other kinds use the default color
const VALUE_STYLES = {
    string: 'success',
    number: 'accent',
    boolean: 'warning',
    null: 'warning',
};

export class ParseError extends Error {
    /** @param {string} source
     *  @param {number} offset
     *  @param {string} message */
    static at(source, offset, message) {
        const before = source.slice(0, offset);
        const line = before.split('\n').length;
        const column = offset - before.lastIndexOf('\n');
        return new ParseError(`${message} at line ${line}, column ${column}`, line, column);
    }

    constructor(message, line, column) {
        super(message);
        this.line = line;
        this.column = column;
    }
}

class TreeNode extends GObject.Object {
    static {
        GObject.registerClass({GTypeName: 'SushiPluginStructuredNode'}, this);
    }

    /** @param {NodeData} data */
    constructor(data) {
        super();
        this.data = data;
    }
}

/** @param {NodeData[]} nodes */
const createListModel = nodes => {
    const store = new Gio.ListStore({item_type: TreeNode.$gtype});
    store.splice(0, 0, nodes.map(node => new TreeNode(node)));
    return store;
};

/** @param {NodeData[]} nodes
 *  @param {number} limit stop counting past this */
const countNodes = (nodes, limit) => {
    let count = 0;
    const stack = [nodes];
    while (stack.length > 0 && count <= limit) {
        for (const node of stack.pop()) {
            count++;
            if (node.children)
                stack.push(node.children);
        }
    }
    return count;
};

// Expanding creates an object for every row, so only expand small documents
const MAX_EXPANDED_NODES = 20000;

/** A tree of rows, starting fully expanded unless the document is large */
export class Tree {
    /** @param {NodeData} root */
    constructor(root) {
        // Show the root's members at the top level rather than a single root row
        const top = root.children?.length ? root.children : [root];
        this.expanded = countNodes(top, MAX_EXPANDED_NODES) <= MAX_EXPANDED_NODES;
        // Nodes are wrapped lazily, once their parent is expanded
        this._model = Gtk.TreeListModel.new(createListModel(top), false, this.expanded,
            item => item.data.children?.length ? createListModel(item.data.children) : null);
        this.selection = new Gtk.SingleSelection({
            model: this._model,
            autoselect: false,
            can_unselect: true,
        });
    }

    /** The selected node and its ancestors, from the top down
     *  @returns {NodeData[]|null} */
    get selectedPath() {
        let row = this.selection.selected_item;
        if (!row)
            return null;
        const path = [];
        for (; row; row = row.get_parent())
            path.unshift(row.item.data);
        return path;
    }

    /** Expands or collapses every top level row. For small documents
     *  expanding also expands everything below them. */
    setExpanded(expanded) {
        const count = this._model.get_model().get_n_items();
        for (let i = 0; i < count; i++)
            this._model.get_child_row(i).expanded = expanded;
        this.expanded = expanded;
    }
}

/** @param {Gio.MenuModel} menu shown on right click, after selecting the row */
export const createRowFactory = menu => {
    const factory = new Gtk.SignalListItemFactory();

    factory.connect('setup', (_factory, listItem) => {
        const box = new Gtk.Box({spacing: 8, css_classes: ['monospace']});

        /** @type {Gtk.PopoverMenu|null} */
        let popover = null;
        const click = new Gtk.GestureClick({button: 3});
        click.connect('pressed', (_gesture, _count, x, y) => {
            box.get_ancestor(Gtk.ListView.$gtype)?.model.select_item(listItem.position, true);
            // Created on first use, most rows never get a menu
            if (!popover) {
                popover = new Gtk.PopoverMenu({
                    menu_model: menu,
                    has_arrow: false,
                    halign: Gtk.Align.START,
                });
                popover.set_parent(box);
            }
            popover.pointing_to = new Gdk.Rectangle({x, y, width: 1, height: 1});
            popover.popup();
        });
        box.add_controller(click);

        box.append(new Gtk.Label({xalign: 0}));
        box.append(new Gtk.Label({
            xalign: 0,
            hexpand: true,
            ellipsize: Pango.EllipsizeMode.END,
        }));
        listItem.child = new Gtk.TreeExpander({child: box});
    });

    factory.connect('bind', (_factory, listItem) => {
        const expander = listItem.child;
        const row = listItem.item;
        const {data} = row.item;
        expander.list_row = row;

        const keyLabel = expander.child.get_first_child();
        keyLabel.visible = data.key !== null;
        keyLabel.label = data.key ?? '';
        keyLabel.css_classes = data.isIndex ? ['dimmed'] : [];

        // Not get_last_child(), a row's menu popover comes after the labels
        const valueLabel = keyLabel.get_next_sibling();
        valueLabel.label = data.value;
        valueLabel.css_classes = data.children
            ? ['dimmed']
            : [VALUE_STYLES[data.kind]].filter(Boolean);
        valueLabel.tooltip_text = !data.children && data.value.length > 40
            ? data.value.slice(0, MAX_TOOLTIP_LENGTH)
            : null;
    });

    factory.connect('unbind', (_factory, listItem) => {
        listItem.child.list_row = null;
    });

    return factory;
};

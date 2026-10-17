// SPDX-License-Identifier: GPL-2.0-or-later WITH GStreamer-exception-2008
// SPDX-FileCopyrightText: 2026 The Sushi authors

// A JSON parser that keeps what JSON.parse throws away but a viewer needs:
// key order and duplicate keys, numbers exactly as written, and where an
// error is.

import {ParseError} from './tree.js';

const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LITERAL = /true|false|null/y;

// Deeper documents would overflow the stack of this recursive parser
const MAX_DEPTH = 1000;

/**
 * @param {string} source
 * @returns {import('./tree.js').NodeData}
 */
export const parseJson = source => {
    let pos = source.charCodeAt(0) === 0xfeff ? 1 : 0;

    const fail = message => {
        throw ParseError.at(source, pos, message);
    };
    const found = () => pos < source.length ? `“${source[pos]}”` : 'end of file';
    // A loop rather than a regex, this runs between every token
    const skipWhitespace = () => {
        for (let code = source.charCodeAt(pos);
            code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
            code = source.charCodeAt(++pos));
    };
    /** @param {RegExp} regex sticky */
    const match = regex => {
        regex.lastIndex = pos;
        const result = regex.exec(source);
        if (!result)
            return null;
        pos = regex.lastIndex;
        return result[0];
    };
    const string = () => match(STRING) ?? fail('Unterminated or invalid string');

    const parseContainer = (key, isIndex, depth) => {
        const start = pos;
        const open = source[pos];
        const close = open === '{' ? '}' : ']';
        const children = [];
        pos++;
        skipWhitespace();
        if (source[pos] === close) {
            pos++;
        } else {
            for (;;) {
                if (open === '{') {
                    skipWhitespace();
                    if (source[pos] !== '"')
                        fail(`Expected a key, found ${found()}`);
                    const name = JSON.parse(string());
                    skipWhitespace();
                    if (source[pos] !== ':')
                        fail(`Expected “:”, found ${found()}`);
                    pos++;
                    children.push(parseValue(name, false, depth + 1));
                } else {
                    children.push(parseValue(`${children.length}`, true, depth + 1));
                }

                skipWhitespace();
                if (source[pos] === ',') {
                    pos++;
                } else if (source[pos] === close) {
                    pos++;
                    break;
                } else {
                    fail(`Expected “,” or “${close}”, found ${found()}`);
                }
            }
        }
        return {
            key,
            isIndex,
            kind: open === '{' ? 'object' : 'array',
            value: `${open}${children.length}${close}`,
            children,
            start,
            end: pos,
        };
    };

    const parseValue = (key, isIndex, depth) => {
        if (depth > MAX_DEPTH)
            fail('Too deeply nested');
        skipWhitespace();

        const char = source[pos];
        if (char === '{' || char === '[')
            return parseContainer(key, isIndex, depth);

        const start = pos;
        const leaf = (kind, value) => ({key, isIndex, kind, value, children: null, start, end: pos});
        if (char === '"')
            return leaf('string', string());
        const number = match(NUMBER);
        if (number !== null)
            return leaf('number', number);
        const literal = match(LITERAL);
        if (literal !== null)
            return leaf(literal === 'null' ? 'null' : 'boolean', literal);

        return fail(`Unexpected ${found()}`);
    };

    const root = parseValue(null, false, 0);
    skipWhitespace();
    if (pos < source.length)
        fail(`Unexpected ${found()} after the end of the document`);
    return root;
};

/** What to copy for a node: strings without their quotes and escapes, and
 *  everything else exactly as written
 *  @param {import('./tree.js').NodeData} node
 *  @param {string} source */
export const jsonCopyText = (node, source) => {
    const text = source.slice(node.start, node.end);
    return node.kind === 'string' ? JSON.parse(text) : text;
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A jq style path, e.g. .items[3].name
 *  @param {import('./tree.js').NodeData[]} nodes from the top down */
export const jsonPath = nodes => {
    const path = nodes
        .filter(node => node.key !== null)
        .map(node => {
            if (node.isIndex)
                return `[${node.key}]`;
            return IDENTIFIER.test(node.key) ? `.${node.key}` : `[${JSON.stringify(node.key)}]`;
        })
        .join('');
    return path.startsWith('.') ? path : `.${path}`;
};

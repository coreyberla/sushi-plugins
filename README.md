# Sushi plugins

Pure GJS plugins for [Sushi](https://gitlab.gnome.org/GNOME/sushi), the GNOME Files previewer.

> [!WARNING]
> These plugins are not thoroughly tested. Use them at your own risk.

## Install

```sh
./install.sh --list            # show available plugins
./install.sh epub              # symlink into ~/.local/share/sushi/plugins-1
./install.sh --all             # every plugin
./install.sh --uninstall epub
```

Then restart sushi. Symlinks mean a `git pull` updates the installed plugins;
use `--copy` if you'd rather not keep this checkout around.

For a system-wide install, or when packaging, copy into sushi's system plugin
directory instead:

```sh
./install.sh --copy --all --dest "$DESTDIR/usr/lib/sushi/plugins-1"
```

## Plugins

### epub

Shows an EPUB's cover, title, authors, series, publisher, date, language and
description. Uses a small built-in zip reader (`Gio.ZlibDecompressor`), so it
needs no libraries beyond what sushi already uses.

### structured

Shows structured data as a collapsible tree, with a toggle to the raw text.
Keys stay in file order and numbers show exactly as written. Files that don't
parse open as text, with the error shown and the cursor on it.

Currently supports JSON and all its subtypes (GeoJSON, JSON-LD, Jupyter
notebooks, …). Files over 8 MB only get the text view.

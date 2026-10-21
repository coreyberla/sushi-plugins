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

### certificate

Shows X.509 certificates: subject, issuer, validity, and every field and
extension, including SHA-256 fingerprints. Reads PEM, DER and PKCS#7 files;
files with several certificates (chains, CA bundles) get a picker. Parsing uses
[Gcr](https://gitlab.gnome.org/GNOME/gcr) 4, so it needs its typelib
(`Gcr-4.typelib`). Encrypted files such as PKCS#12 aren't supported, since sushi
can't ask for a password.

### csv

Shows CSV and TSV files as a table, with the first row as column headers.
Click a header to sort by that column; numbers sort numerically. The
delimiter (comma, semicolon, tab or pipe) is detected from the first line.
Only the first 8 MB or 50,000 rows are shown.

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

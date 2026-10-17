# Contributing

## Layout

Each plugin is `src/<name>.js`, plus an optional `src/<name>/` directory for its
helpers. Sushi only loads `.js` files at the top level of its plugin directory,
so helpers must stay in the subdirectory, where they won't be loaded as plugins.
`install.sh` picks up new plugins automatically.

## UI files

Plugin UIs are written in [Blueprint](https://gitlab.gnome.org/GNOME/blueprint-compiler).
GTK can't load `.blp` files directly, so the compiled `.ui` file is committed next to it.
After editing a `.blp` file, regenerate its `.ui` file and commit both:

```sh
blueprint-compiler compile src/epub/epub.blp --output src/epub/epub.ui
```
